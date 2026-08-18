// walker/state.mjs
//
// Single in-process shared state for the parallel DFS walker.
//
// All mutations are synchronous JavaScript on a single thread (Node JS
// is cooperatively scheduled between awaits). The walker design ensures
// every shared-state read AND its dependent write happen in the SAME
// synchronous block — no await between `set.has(t)` and `set.add(t)` —
// so the `tryClaim` semantics are race-safe without locks.
//
// Two budget gates:
//   - wall-clock: `budgetMs` from construction
//   - page count: `maxPages` distinct URLs visited
// `isBudgetExhausted()` lets workers exit gracefully when either fires.

import { routeKey } from '../lib/route-key.mjs';
import { normalizeGeneratedIds } from './scanner.mjs';

export class SharedState {
  // page-url → count of first-seen route templates its children introduced
  // (a novelty signal consumed by recordSample; private — internal bookkeeping)
  #newTplByPage = new Map();
  #satLoggedTpl = new Set();
  // auth-recovery storm detector + outage detector (private ring buffers)
  #recoveryHits = [];
  #netErrTimes = [];
  #outageProber = null;

  constructor({ seeds = [], budgetMs = 600_000, maxPages = 200, maxDepth = 5,
                maxTaskAttempts = 2, skipRoutes = null,
                // Hard cap default 10 (not unbounded): the novelty gate is a
                // DETECTOR and detectors can be fooled — a volatile-id pattern
                // not in GENERATED_ID_RE would be perpetual fake novelty. The
                // cap bounds the blast radius of any undetected volatility.
                noveltyDryLimit = 2, maxSamplesPerTemplate = 10 } = {}) {
    this.startedAt        = Date.now();
    this.budgetMs         = budgetMs;
    this.maxPages         = maxPages;
    this.maxDepth         = maxDepth;
    this.maxTaskAttempts  = maxTaskAttempts;  // total tries per task (1 initial + retries)
    this.skipRoutes       = skipRoutes;       // RegExp | null — CRAWL_SKIP_ROUTES
    this.skippedUrls      = new Set();        // routes excluded by skipRoutes

    // ── novelty-based sampling (whole-app step 3) ──────────────────────
    // Keep sampling a template's instances only while samples reveal new
    // things (APIs, interactable shapes, state edges, child templates).
    // After `noveltyDryLimit` consecutive dry samples the template is
    // SATURATED: further instances are dispositioned, not crawled.
    // 0 disables the dry gate; maxSamplesPerTemplate (0 = unbounded) is
    // the hard per-template ceiling regardless of novelty.
    this.noveltyDryLimit       = noveltyDryLimit;
    this.maxSamplesPerTemplate = maxSamplesPerTemplate;
    this.templateShapes   = new Map();      // tpl → Set(shapeHash)
    this.templateEdgeKeys = new Map();      // tpl → Set(clickable key)
    this.templateDry      = new Map();      // tpl → consecutive dry samples
    this.knownTemplates   = new Set();      // every template ever seen in the frontier
    this.saturatedUrls    = new Set();      // instances not visited because template saturated

    this.pending          = [];               // [{ url, depth, phase?, parentUrl?, attempts? }]
    this.interactedUrls   = new Set();
    this.navigatedPaths   = new Set();      // `${url}::${stableKey}`
    this.stateNodes       = new Set();      // `${url}#${stableKey}`
    this.discoveredViaClick = new Set();
    this.clickGraph       = [];
    this.interactablesByUrl = {};           // { url: [items] }
    this.issues           = [];             // [{ts, type, workerId?, url?, message}]
    this.templateVisits   = new Map();      // routeKey → visit count
    this.discoveredUrls   = new Set();      // every URL ever accepted into the frontier
    this.abandonedUrls    = new Set();      // gave up after maxTaskAttempts
    this.depthCappedUrls  = new Set();      // dropped at dequeue by MAX_INTERACT_DEPTH

    this.activeWorkers    = 0;

    // ── auth accounting ─────────────────────────────────────────────────
    // authRecoveries > 0 → a worker (or the keeper) is mid-recovery on the
    // single-flight token chain; siblings back off instead of piling onto
    // the refresh endpoint with soon-to-be-stale tokens.
    this.authRecoveries   = 0;
    this.authEvents       = [];   // [{ts, type, workerId?, durationMs?, message?}]
    // Wall-clock spent NOT crawling (auth recovery, network outage) — excluded
    // from the time budget so a slow SSO round-trip or a VPN blip doesn't eat
    // the crawl's allowance (TTL-aware budget accounting).
    this.budgetPausedMs   = 0;
    // Set by the pool when session refresh is configured: (reason) → Promise.
    // Workers call it on a recovery storm (mid-crawl warm-up + broadcast).
    this.requestSessionRefresh = null;

    // ── network-outage detection ────────────────────────────────────────
    this.outageSince      = null;   // epoch ms while an outage is active
    this.outageCount      = 0;
    this.outageTotalMs    = 0;

    // Seed filtering last — #skips records issues, so every field above
    // (issues in particular) must already be initialized.
    for (const s of seeds) {
      if (this.#skips(s.url)) continue;
      this.pending.push(s);
      this.discoveredUrls.add(s.url);
      this.knownTemplates.add(routeKey(s.url));
    }
  }

  // Push a structured issue (click failed, nav failed, re-auth needed, …)
  // so the pool can summarize them at the end and the saved click-graph.json
  // surfaces what went wrong without us needing to grep logs.
  recordIssue({ type, workerId = null, url = null, message = '' }) {
    if (!type) return;
    this.issues.push({
      ts: Date.now() - this.startedAt,
      type, workerId, url,
      message: String(message).split('\n')[0].slice(0, 200),
    });
  }

  // ── budget ────────────────────────────────────────────────────────────
  // budgetMs <= 0 means UNBOUNDED time: the crawl runs until the frontier
  // drains (or the pages cap fires). Time is a failsafe, not the goal —
  // the stopping criterion for whole-app coverage is frontier closure.
  // budgetPausedMs (auth recovery, outages) is excluded: the budget bounds
  // CRAWLING time, and charging a 75s SSO round-trip or a VPN blip against
  // it silently converts auth trouble into truncated coverage.
  isBudgetExhausted() {
    const crawlElapsed = Date.now() - this.startedAt - this.budgetPausedMs;
    if (this.budgetMs > 0 && crawlElapsed > this.budgetMs) return 'time';
    if (this.interactedUrls.size >= this.maxPages) return 'pages';
    return null;
  }

  // ── auth recovery accounting ──────────────────────────────────────────
  beginAuthRecovery() { this.authRecoveries += 1; }
  endAuthRecovery()   { this.authRecoveries = Math.max(0, this.authRecoveries - 1); }
  get authRecoveryActive() { return this.authRecoveries > 0; }

  recordAuthEvent({ type, workerId = null, durationMs = null, message = '' }) {
    if (!type) return;
    this.authEvents.push({
      ts: Date.now() - this.startedAt,
      type, workerId, durationMs,
      message: String(message).split('\n')[0].slice(0, 200),
    });
  }

  addBudgetPause(ms) { if (Number.isFinite(ms) && ms > 0) this.budgetPausedMs += ms; }

  // Recovery-storm detector: returns how many re-auth hits landed inside the
  // window INCLUDING this one. ≥2 means the shared session is stale for
  // everyone — per-context recovery would serialize N slow round-trips, so
  // the caller should trigger ONE session refresh + broadcast instead.
  noteRecoveryHit(windowMs = 60_000) {
    const now = Date.now();
    this.#recoveryHits.push(now);
    while (this.#recoveryHits.length && now - this.#recoveryHits[0] > windowMs) {
      this.#recoveryHits.shift();
    }
    return this.#recoveryHits.length;
  }

  // ── network-outage detection ──────────────────────────────────────────
  // N goto-level network errors across workers within a short window means
  // the NETWORK died, not the pages — retrying just burns each task's
  // attempt budget against a dead link. The frontier pauses (workers hold),
  // one worker probes until the target answers again, and paused time is
  // excluded from the crawl budget.
  reportNetworkError({ threshold = 3, windowMs = 30_000 } = {}) {
    const now = Date.now();
    this.#netErrTimes.push(now);
    while (this.#netErrTimes.length && now - this.#netErrTimes[0] > windowMs) {
      this.#netErrTimes.shift();
    }
    if (!this.outageSince && this.#netErrTimes.length >= threshold) {
      this.outageSince = now;
      this.outageCount += 1;
      this.recordIssue({ type: 'network-outage', message: `${this.#netErrTimes.length} network errors in ${Math.round(windowMs / 1000)}s — frontier paused` });
      return true;   // this call flipped the outage on
    }
    return false;
  }

  reportNetworkOk() {
    if (this.outageSince) {
      const dur = Date.now() - this.outageSince;
      this.outageTotalMs += dur;
      this.addBudgetPause(dur);
      this.recordIssue({ type: 'network-restored', message: `outage over after ${Math.round(dur / 1000)}s — frontier resumed` });
      this.outageSince = null;
      this.#outageProber = null;
    }
    this.#netErrTimes.length = 0;
  }

  get outageActive() { return this.outageSince != null; }

  // Exactly one worker probes connectivity during an outage; the rest wait.
  tryBecomeOutageProber(workerId) {
    if (this.#outageProber != null && this.#outageProber !== workerId) return false;
    this.#outageProber = workerId;
    return true;
  }

  // Deliberate route exclusion (CRAWL_SKIP_ROUTES) — recorded once per URL
  // so an excluded route shows up as `route-skipped`, never as silently lost.
  #skips(url) {
    if (!this.skipRoutes || !url || !this.skipRoutes.test(url)) return false;
    if (!this.skippedUrls.has(url)) {
      this.skippedUrls.add(url);
      this.recordIssue({ type: 'route-skipped', url, message: 'matched CRAWL_SKIP_ROUTES' });
    }
    return true;
  }

  // ── queue ─────────────────────────────────────────────────────────────
  enqueue(task) {
    // Skip if already known. The atomic check + push happens here so
    // multiple workers enqueueing the same discovered URL never produce
    // duplicates.
    if (!task || !task.url) return false;
    if (this.#skips(task.url)) return false;
    if (this.interactedUrls.has(task.url)) return false;
    if (this.pending.some(t => t.url === task.url)) return false;
    this.pending.push(task);
    this.discoveredUrls.add(task.url);
    // Novelty signal: did this discovery introduce a template the frontier
    // has never seen? Credited to the page that surfaced it (parentUrl).
    const tpl = routeKey(task.url);
    if (!this.knownTemplates.has(tpl)) {
      this.knownTemplates.add(tpl);
      if (task.parentUrl) {
        this.#newTplByPage.set(task.parentUrl, (this.#newTplByPage.get(task.parentUrl) || 0) + 1);
      }
    }
    return true;
  }

  // Put a failed task back for another try. The URL was reserved by
  // tryDequeue (added to interactedUrls) but never actually crawled, so
  // un-reserve it first. Returns false once the attempt cap is reached —
  // the caller records the task as abandoned.
  requeue(task) {
    if (!task || !task.url) return false;
    const attempts = (task.attempts ?? 1) + 1;
    if (attempts > this.maxTaskAttempts) {
      this.abandonedUrls.add(task.url);   // consumed all attempts — dispositioned, not silent
      return false;
    }
    this.interactedUrls.delete(task.url);
    this.pending.push({ ...task, attempts });
    return true;
  }

  // Requeue WITHOUT charging an attempt — for failures that aren't the
  // task's fault (network outage): the page never answered, so burning the
  // 2-attempt budget would abandon perfectly good routes on a dead link.
  requeueNoCharge(task) {
    if (!task || !task.url) return false;
    this.interactedUrls.delete(task.url);
    this.pending.push({ ...task });
    return true;
  }

  tryDequeue() {
    // BFS = shift (FIFO). Workers grab the OLDEST task so all sibling
    // discoveries at depth N are covered before any drill into depth N+1.
    // This matters when budget < time-to-exhaust: with DFS the walker
    // dove into one subtree (e.g. /downloads) and missed siblings
    // (/sessions, /endpoints, /insights) entirely. With BFS the entire
    // sidebar is covered first; details drilled second.
    //
    // Per-page click order is still depth-first (a worker fully drains
    // a page's click list before grabbing the next task), so state-edge
    // capture per page is unaffected.
    while (this.pending.length) {
      const task = this.pending.shift();
      if (this.interactedUrls.has(task.url)) continue;       // already done
      if (task.depth > this.maxDepth) {                      // depth-cap: deliberate
        this.depthCappedUrls.add(task.url);                  // bound — but never silent
        continue;
      }
      const tpl = routeKey(task.url);
      // Saturation gate: stop visiting instances of a template whose recent
      // samples revealed nothing new (or whose hard sample cap is spent).
      // Dispositioned as `saturated` — a deliberate bound, never silent.
      const visits = this.templateVisits.get(tpl) || 0;
      const dryDone = this.noveltyDryLimit > 0 && visits > 0 &&
                      (this.templateDry.get(tpl) || 0) >= this.noveltyDryLimit;
      const capDone = this.maxSamplesPerTemplate > 0 && visits >= this.maxSamplesPerTemplate;
      if (dryDone || capDone) {
        this.saturatedUrls.add(task.url);
        if (!this.#satLoggedTpl.has(tpl)) {
          this.#satLoggedTpl.add(tpl);
          this.recordIssue({
            type: 'template-saturated', url: task.url,
            message: `${tpl} — ${visits} sample(s), ${dryDone ? 'no novelty in last ' + this.noveltyDryLimit : 'sample cap ' + this.maxSamplesPerTemplate}`,
          });
        }
        continue;
      }
      // Reserve atomically — no other worker can also dequeue this URL.
      this.interactedUrls.add(task.url);
      // Template ledger: URL instances roll up into route templates — the
      // real coverage unit; also feeds the saturation gate above.
      this.templateVisits.set(tpl, visits + 1);
      return task;
    }
    return null;
  }

  // ── novelty sampling ──────────────────────────────────────────────────
  // Called by the worker after fully processing a page. `novel` when the
  // sample revealed anything unseen FOR ITS TEMPLATE: a new interactable
  // shape, a new clickable key, a first-seen child template, or a
  // first-seen API template. Resets or grows the template's dry streak —
  // which is what the tryDequeue gate reads.
  recordSample(url, { shapeHash = null, edgeKeys = [], newApis = 0 } = {}) {
    const tpl = routeKey(url);
    let novel = (this.templateVisits.get(tpl) || 0) <= 1;   // first sample defines the template
    if (shapeHash != null) {
      let shapes = this.templateShapes.get(tpl);
      if (!shapes) { shapes = new Set(); this.templateShapes.set(tpl, shapes); }
      if (!shapes.has(shapeHash)) { shapes.add(shapeHash); novel = true; }
    }
    let keys = this.templateEdgeKeys.get(tpl);
    if (!keys) { keys = new Set(); this.templateEdgeKeys.set(tpl, keys); }
    // Normalize volatile generated IDs (radix/mui/… mint a fresh id per
    // render) BEFORE the cross-instance comparison — otherwise one volatile
    // key per page is perpetual fake novelty and the template never
    // saturates. Click-time identity (tryClaim) stays UN-normalized: two
    // generated-id controls on one page must still be clicked separately.
    for (const k of edgeKeys) {
      const nk = normalizeGeneratedIds(k);
      if (!keys.has(nk)) { keys.add(nk); novel = true; }
    }
    if ((this.#newTplByPage.get(url) || 0) > 0) novel = true;
    this.#newTplByPage.delete(url);
    if (newApis > 0) novel = true;
    this.templateDry.set(tpl, novel ? 0 : (this.templateDry.get(tpl) || 0) + 1);
    return novel;
  }

  get queueLength()  { return this.pending.length; }
  get pagesVisited() { return this.interactedUrls.size; }

  // ── per-click transition dedup ────────────────────────────────────────
  // Atomic: no await between has + add, so two workers can't both win.
  tryClaim(transition) {
    if (this.navigatedPaths.has(transition)) return false;
    this.navigatedPaths.add(transition);
    return true;
  }

  // ── recording ─────────────────────────────────────────────────────────
  addEdge(edge)            { this.clickGraph.push(edge); }
  addStateNode(node)       { this.stateNodes.add(node); }
  markDiscovered(url)      { this.discoveredViaClick.add(url); }
  setInteractables(url, items) {
    if (items && items.length) this.interactablesByUrl[url] = items;
  }

  // ── worker accounting ─────────────────────────────────────────────────
  beginWork() { this.activeWorkers += 1; }
  endWork()   { this.activeWorkers -= 1; }

  // True when there's nothing pending AND no worker is mid-task.
  // The grace period in the worker loop guards against premature exit.
  isQuiescent() { return this.pending.length === 0 && this.activeWorkers === 0; }

  // ── coverage manifest ─────────────────────────────────────────────────
  // Every URL the frontier ever accepted ends with exactly one disposition:
  //   visited | abandoned (attempt cap) | skipped (CRAWL_SKIP_ROUTES) | pending.
  // Rolled up by route template (routeKey) — the real coverage unit.
  // `complete` = frontier drained AND nothing abandoned: the checkable claim
  // behind "the whole application was scanned".
  coverage(stoppedBy = null) {
    const pendingUrls = [...new Set(this.pending.map(t => t.url))]
      .filter(u => !this.interactedUrls.has(u));
    const visitedUrls = [...this.interactedUrls].filter(u => !this.abandonedUrls.has(u));
    const tplOf = (urls) => [...new Set(urls.map(u => routeKey(u)))];
    const visitedTpl = tplOf(visitedUrls);
    const pendingTpl = tplOf(pendingUrls).filter(t => !visitedTpl.includes(t));
    return {
      complete: pendingUrls.length === 0 && this.abandonedUrls.size === 0,
      stoppedBy: stoppedBy ?? (this.isBudgetExhausted() || (this.pending.length === 0 ? 'drained' : 'unknown')),
      urls: {
        discovered: this.discoveredUrls.size,
        visited: visitedUrls.length,
        abandoned: [...this.abandonedUrls],
        skipped: [...this.skippedUrls],
        depthCapped: [...this.depthCappedUrls],
        saturated: [...this.saturatedUrls],
        pending: pendingUrls,
      },
      templates: {
        visited: visitedTpl.length,
        saturated: [...this.#satLoggedTpl],   // sampled to no-novelty, remainder skipped
        pending: pendingTpl,      // templates never seen at all — the true coverage holes
      },
    };
  }

  // ── serialization (matches existing click-graph.json shape) ───────────
  serialize({ workers = 1, traversal = 'parallel-bfs', complete = true, stoppedBy = null } = {}) {
    const navEdges   = this.clickGraph.filter(e => e.kind === 'nav').length;
    const stateEdges = this.clickGraph.filter(e => e.kind === 'state').length;
    const issueCounts = {};
    for (const i of this.issues) issueCounts[i.type] = (issueCounts[i.type] || 0) + 1;
    return {
      generatedAt: new Date().toISOString(),
      traversal,
      dedup: 'transition',
      workers,
      complete,                            // false for mid-run checkpoints
      wallClockMs: Date.now() - this.startedAt,
      pageCount: this.interactedUrls.size,
      pendingCount: this.pending.length,
      edgeCounts: { total: this.clickGraph.length, nav: navEdges, state: stateEdges },
      issueCounts,
      // Auth observability: when a scan misbehaves, this section says whether
      // auth was the reason (recovery churn, token rotations, storms) without
      // grepping logs. budgetPausedMs is the wall-clock excluded from the
      // time budget (auth recovery + outages).
      auth: (() => {
        const counts = {}, totalMs = {};
        for (const e of this.authEvents) {
          counts[e.type] = (counts[e.type] || 0) + 1;
          if (e.durationMs) totalMs[e.type] = (totalMs[e.type] || 0) + e.durationMs;
        }
        return { counts, totalMs, budgetPausedMs: this.budgetPausedMs, events: this.authEvents };
      })(),
      outages: { count: this.outageCount, totalMs: this.outageTotalMs, active: this.outageActive },
      nodes: [...this.interactedUrls],
      skippedRoutes: [...this.skippedUrls],
      // Route templates visited, with instance counts — the coverage unit.
      templates: Object.fromEntries([...this.templateVisits.entries()].sort((a, b) => b[1] - a[1])),
      coverage: this.coverage(stoppedBy),
      stateNodes: [...this.stateNodes],
      discoveredViaClick: [...this.discoveredViaClick],
      navigatedPaths: [...this.navigatedPaths],
      edges: this.clickGraph,
      interactables: this.interactablesByUrl,
      issues: this.issues,
    };
  }
}
