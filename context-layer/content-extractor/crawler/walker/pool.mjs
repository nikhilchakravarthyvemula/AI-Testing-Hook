// walker/pool.mjs
//
// Master orchestrator for the parallel unified-DFS walker.
//
// Lifecycle:
//   1. Launch one Chromium browser
//   2. PRE-DISCOVERY: spin up 1 temporary context, navigate to each
//      seed, scan, enqueue every nav URL found. This way the queue is
//      pre-populated before the parallel workers start, so each worker
//      can grab a different sidebar branch from the very first second
//      (no fighting over a 1-task queue early-on).
//   3. Create N independent BrowserContexts (= N parallel workers).
//      Worker count is sized to min(CRAWL_WORKERS, queueLength) so we
//      don't spin up 8 workers when there's only 3 routes to crawl.
//   4. For each context: run `onContextReady` (typically attach NDJSON
//      listeners + inject auth state + maybeLogin)
//   5. Build a SharedState seeded with the input task list
//   6. Spawn N workers as Promises sharing that state
//   7. await Promise.all — all workers drain to quiescence
//   8. Close the browser, return serialized graph

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

import { SharedState }       from './state.mjs';
import { runWorker }         from './worker.mjs';
import { scanInteractables } from './scanner.mjs';

/**
 * @param {Object} opts
 * @param {Array<{url:string, depth?:number, phase?:string}>} opts.seeds
 * @param {number} [opts.workers=4]
 * @param {string|null} [opts.sameOrigin]
 * @param {string} opts.safeRe
 * @param {string} opts.destrRe
 * @param {number} [opts.maxClicksPerPage=Infinity]
 * @param {number} [opts.maxListItemsPerNav=5]   per-table cap (see worker.mjs)
 * @param {number} [opts.maxDepth=5]
 * @param {number} [opts.maxPages=200]
 * @param {number} [opts.budgetMs=600_000]
 * @param {boolean}[opts.headless=true]
 * @param {number} [opts.postNavWaitMs=1500]
 * @param {boolean}[opts.preDiscovery=true]      run the seed expansion phase
 * @param {Function}[opts.onContextReady]
 * @param {Function}[opts.reAuth]
 * @param {Function}[opts.recordPage]
 * @param {Function}[opts.log]
 * @returns {Promise<Object>}
 */
export async function runWalkerPool(opts) {
  const {
    seeds = [],
    workers: workerCount = Number(process.env.CRAWL_WORKERS || 8),
    sameOrigin = null,
    safeRe,
    destrRe,
    maxClicksPerPage = Infinity,
    maxListItemsPerNav,        // worker.mjs has its own default
    maxDepth = 5,
    maxPages = 200,
    budgetMs = 600_000,
    headless = true,
    postNavWaitMs = 1500,
    preDiscovery = (process.env.CRAWL_PREDISCOVERY ?? '1') !== '0',
    onContextReady,
    reAuth,
    recordPage,
    log = console.log.bind(console),
    // Periodically write the current SharedState to checkpointPath so a
    // mid-run kill leaves usable data. Defaults to 30s. Pass null to
    // disable (e.g. tiny test runs).
    checkpointPath = null,
    checkpointIntervalMs = Number(process.env.CRAWL_CHECKPOINT_MS || 30_000),
    // Per-page scanner. Defaults inside worker.mjs to the heuristic
    // scanInteractables. crawler-llm passes its LLM-primary scanner here.
    scannerFn,
  } = opts;

  if (!seeds.length) {
    log('[walker-pool] no seeds — nothing to crawl');
    return new SharedState().serialize({ workers: 0 });
  }

  // Normalize seeds to {url, depth, phase}.
  const seedTasks = seeds.map(s => ({
    url: s.url,
    depth: s.depth ?? 0,
    phase: s.phase || 'seed',
  }));

  const state = new SharedState({
    seeds: seedTasks,
    budgetMs, maxPages, maxDepth,
  });

  log(`[walker-pool] starting — seeds=${seeds.length} workers=${workerCount}(max) maxPages=${maxPages} maxDepth=${maxDepth} budget=${Math.round(budgetMs/1000)}s preDiscovery=${preDiscovery}`);

  const browser = await chromium.launch({ headless });

  // ── PRE-DISCOVERY PHASE ───────────────────────────────────────────────
  // Optional: scan each seed in a single throwaway context to populate
  // the queue with discovered nav URLs BEFORE the parallel workers
  // start. This means each parallel worker can immediately grab a
  // different sidebar route — no "1 worker scans / for 30s while 3
  // workers idle" warmup cost. The seeds themselves stay in the queue
  // so the per-page state edges still get captured by the pool.
  if (preDiscovery && seedTasks.length > 0) {
    log(`[walker-pool] discovery phase — scanning ${seedTasks.length} seed(s) to enumerate routes`);
    const dctx = await browser.newContext();
    const dpage = await dctx.newPage();
    if (onContextReady) {
      try { await onContextReady(dctx, dpage, 0); }
      catch (e) { log(`[walker-pool] discovery context setup failed: ${e.message}`); }
    }

    for (const seed of seedTasks) {
      try {
        await dpage.goto(seed.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await dpage.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
        await dpage.waitForTimeout(postNavWaitMs);
      } catch (e) {
        log(`[walker-pool] discovery nav failed for ${seed.url}: ${e.message.split('\n')[0].slice(0, 100)}`);
        continue;
      }

      const scan = await scanInteractables(dpage, { safeRe, destrRe, sameOrigin });
      const navs = scan.items.filter(it => it.kind === 'nav' && !it.rejected && it.href);

      // Build a set of unique same-origin absolute URLs.
      const discoveredUrls = new Set();
      for (const it of navs) {
        let abs;
        try { abs = new URL(it.href, dpage.url()).href; } catch { continue; }
        if (sameOrigin) {
          try { if (new URL(abs).origin !== sameOrigin) continue; } catch { continue; }
        }
        // Strip OAuth callback fragments so we don't enqueue the same
        // route N times with varying #state= / #session_state= hashes.
        const cleaned = abs.replace(/#(?=.*(?:state|session_state|code|iss)=)[^#]*$/, '');
        if (cleaned === seed.url) continue;
        discoveredUrls.add(cleaned);
      }

      let added = 0;
      for (const u of discoveredUrls) {
        if (state.enqueue({ url: u, depth: (seed.depth ?? 0) + 1, phase: 'predisc', parentUrl: seed.url })) {
          added++;
        }
      }
      log(`[walker-pool] discovery: ${seed.url} → +${added} route(s) (${navs.length} nav anchor(s) on page)`);
    }

    await dctx.close().catch(() => {});
    log(`[walker-pool] discovery done — queue size = ${state.queueLength}`);
  }

  // ── DYNAMIC WORKER SIZING ─────────────────────────────────────────────
  // No point spawning 8 contexts if there's only 2 pages to crawl. Cap
  // at min(requested, queue) — the upper bound is what the user set.
  // Floor at 1 so we always make some progress.
  const effectiveWorkers = Math.max(1, Math.min(workerCount, state.queueLength));
  if (effectiveWorkers < workerCount) {
    log(`[walker-pool] sized workers to ${effectiveWorkers} (queue=${state.queueLength}, requested=${workerCount})`);
  }

  // ── per-worker context setup (parallel) ───────────────────────────────
  const contexts = [];
  for (let i = 0; i < effectiveWorkers; i++) {
    const ctx  = await browser.newContext();
    const page = await ctx.newPage();
    contexts.push({ ctx, page, workerId: i + 1 });
  }

  await Promise.all(contexts.map(async ({ ctx, page, workerId }) => {
    if (onContextReady) {
      try { await onContextReady(ctx, page, workerId); }
      catch (e) { log(`[walker-pool] context ${workerId} setup failed: ${e.message}`); }
    }
  }));

  // ── checkpointing ─────────────────────────────────────────────────────
  // If a path is provided, periodically serialize SharedState to it so a
  // mid-run kill (process timeout, Ctrl+C, OOM, …) leaves usable data
  // on disk. Marked `complete: false` so consumers can tell it's partial.
  let checkpointTimer = null;
  let checkpointsWritten = 0;
  if (checkpointPath && checkpointIntervalMs > 0) {
    try { fs.mkdirSync(path.dirname(checkpointPath), { recursive: true }); } catch {}
    checkpointTimer = setInterval(() => {
      try {
        const partial = state.serialize({ workers: effectiveWorkers, complete: false });
        fs.writeFileSync(checkpointPath, JSON.stringify(partial, null, 2));
        checkpointsWritten++;
        log(`[walker-pool] checkpoint #${checkpointsWritten} written — pages=${partial.pageCount} edges=${partial.edgeCounts.total} pending=${partial.pendingCount} issues=${partial.issues.length}`);
      } catch (e) {
        log(`[walker-pool] checkpoint write failed: ${e.message}`);
      }
    }, checkpointIntervalMs);
    log(`[walker-pool] checkpointing to ${path.relative(process.cwd(), checkpointPath)} every ${checkpointIntervalMs}ms`);
  }

  // ── spawn workers ─────────────────────────────────────────────────────
  const promises = contexts.map(({ page, workerId }) =>
    runWorker({
      workerId, state, page,
      sameOrigin, safeRe, destrRe,
      maxClicksPerPage, maxListItemsPerNav, postNavWaitMs,
      log, recordPage, reAuth,
      scannerFn,
    }).catch(e => {
      log(`[walker-pool] worker ${workerId} crashed: ${e.message}`);
      state.recordIssue({ type: 'worker-crashed', workerId, message: e.message });
    })
  );

  await Promise.all(promises);

  // ── teardown ──────────────────────────────────────────────────────────
  if (checkpointTimer) { clearInterval(checkpointTimer); }
  await browser.close().catch(() => {});

  const exhausted = state.isBudgetExhausted();
  if (exhausted) log(`[walker-pool] budget exhausted (${exhausted}) — wrote partial graph`);

  const serialized = state.serialize({ workers: effectiveWorkers, complete: !exhausted });
  log(`[walker-pool] done. pages=${serialized.pageCount} edges=${serialized.edgeCounts.total} (nav=${serialized.edgeCounts.nav}, state=${serialized.edgeCounts.state}) state-nodes=${serialized.stateNodes.length} new-via-click=${serialized.discoveredViaClick.length} interactable-pages=${Object.keys(serialized.interactables).length} pending-at-exit=${serialized.pendingCount} wallClock=${Math.round(serialized.wallClockMs/1000)}s`);

  // ── issue summary ────────────────────────────────────────────────────
  // Surface what went wrong so the user doesn't have to grep logs.
  const totalIssues = serialized.issues.length;
  if (totalIssues > 0) {
    log(`[walker-pool] issues: ${totalIssues} total`);
    for (const [type, count] of Object.entries(serialized.issueCounts).sort((a,b) => b[1] - a[1])) {
      log(`[walker-pool]   ${type.padEnd(20)} ${count}`);
    }
  } else {
    log(`[walker-pool] issues: 0 (clean run)`);
  }

  // Final write — overwrites the last checkpoint with the complete state.
  if (checkpointPath) {
    try {
      fs.writeFileSync(checkpointPath, JSON.stringify(serialized, null, 2));
      log(`[walker-pool] wrote final ${path.relative(process.cwd(), checkpointPath)} (${checkpointsWritten} interim checkpoints during run)`);
    } catch (e) {
      log(`[walker-pool] final write failed: ${e.message}`);
    }
  }

  return serialized;
}
