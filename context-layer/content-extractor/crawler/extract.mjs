// Crawler source extractor — drives the crawler engine in this folder.
//
// Runs the existing crawler with whatever env vars are set, then reads its
// outputs (routes.json, pages.json, click-graph.json) and emits a
// normalized source-bundle JSON at output/sources/crawler.json carrying
// provenance (DiscoveryTier=live_observed, confidence=0.95).
//
// Semantic source id is "crawler" (matches the folder name and the
// run.mjs auto-discovery convention). The Knowledge Base layer maps it
// to the architecture-diagram bucket "Live Links".
//
// The crawler engine lives in this folder; we run its stages with node.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { provenance, DiscoveryTier } from '../../../knowledge-base/schema.mjs';
import { adviseOn } from './llm-advisor/index.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

// The crawler engine now lives alongside this file (moved out of
// scripts/crawler). We invoke its stages directly with node — no npm seam.
const CRAWLER_STAGES = ['crawl.mjs', 'analyze.mjs', 'spec.mjs', 'route-tree.mjs'];
const CRAWLER_OUT = path.join(REPO_ROOT, 'output', 'crawler');
// Crawler-specific output folder. The crawler subsystem already writes
// raw data + reports under output/crawler/{data,reports}/ via the crawler stages;
// the bundle.json sits alongside those as the "what the indexer reads".
const OUT_DIR = path.join(REPO_ROOT, 'output', 'crawler');
const OUT_FILE = path.join(OUT_DIR, 'bundle.json');

const SKIP_CRAWL = (process.env.SKIP_CRAWL ?? '0') === '1';

function loadJSON(p) {
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  if (!SKIP_CRAWL) {
    console.log('[crawler] running the crawler pipeline (set SKIP_CRAWL=1 to use prior output)…');
    for (const stage of CRAWLER_STAGES) {
      execFileSync(process.execPath, [path.join(__dirname, stage)], {
        cwd: REPO_ROOT,
        stdio: 'inherit',
        env: process.env,
      });
    }
  } else {
    console.log('[crawler] SKIP_CRAWL=1 — reusing existing output/crawler/');
  }

  const routes     = loadJSON(path.join(CRAWLER_OUT, 'data', 'routes.json'));
  const pages      = loadJSON(path.join(CRAWLER_OUT, 'data', 'pages.json'));
  const clickGraph = loadJSON(path.join(CRAWLER_OUT, 'data', 'click-graph.json'));
  if (!routes || !pages) {
    console.error('[crawler] missing routes.json or pages.json — crawler did not produce output');
    process.exit(1);
  }

  // ── post-crawl: LLM annotates every clickable on every page with intent ────
  //
  // One LLM call per page. Results merged into `facts.pages[i].clickables`.
  // `CRAWLER_LLM=0` env var (read inside the advisor) disables the pass.
  await annotateClickableIntents(pages.pages ?? []);

  const bundle = {
    ...provenanceShell(),
    target: { baseUrl: routes?.summary?.origins?.[0] ?? null },
    stats: {
      endpoints: routes.endpoints?.length ?? 0,
      pages: pages.pages?.length ?? 0,
      clickEdges: clickGraph?.edges?.length ?? 0,
      origins: routes.summary?.origins ?? [],
      intentsAnnotated: _countAnnotatedIntents(pages.pages ?? []),
    },
    facts: {
      endpoints: routes.endpoints ?? [],
      pages: pages.pages ?? [],
      clickGraph: clickGraph ?? null,
      serverRedirects: routes.serverRedirects ?? [],
      clientNavRedirects: routes.clientNavRedirects ?? [],
      authObservations: routes.authObservations ?? null,
      security: routes.security ?? null,
      performance: routes.performance ?? null,
      failedRequests: routes.failedRequests ?? [],
    },
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(bundle, null, 2));
  const sizeKB = (fs.statSync(OUT_FILE).size / 1024).toFixed(1);
  console.log(`[crawler] wrote ${path.relative(REPO_ROOT, OUT_FILE)} (${sizeKB} KB)`);
  console.log(`[crawler] stats: ${JSON.stringify(bundle.stats)}`);
}


// ── Part B: per-page intent annotation ────────────────────────────────────


// Concurrency + caps (env-overridable). The old code was strictly serial —
// one ~30s reasoning-LLM call after another — so a 34-page crawl spent ~80 min
// here. Now we dedup aggressively, cap table rows, and run batches concurrently.
const INTENT_CONCURRENCY = Number(process.env.INTENT_CONCURRENCY || 6);
const INTENT_BATCH_SIZE  = Number(process.env.INTENT_BATCH_SIZE || 15);
// Cap applies ONLY to table-row clickables (per page). Nav links + buttons +
// other clicks are never capped. Same-table rows already collapse to one
// signature via dedup, so this only bites pathological pages (>N distinct tables).
const INTENT_ROW_CAP     = Number(process.env.INTENT_ROW_CAP || 12);

// Run async tasks with a fixed concurrency cap.
async function _runPool(items, concurrency, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const idx = next++;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

// A dedup signature: collapses (a) the same nav/button repeated across every
// page, and (b) all rows of one table (selector nth-indices wildcarded) to a
// single label. Links also key on a normalized href shape so genuinely
// different links don't over-collapse.
function _sigOf(item) {
  const selPat = String(item.selector || '')
    .replace(/:nth-(of-type|child)\(\d+\)/g, ':nth(*)')
    .replace(/\b\d{2,}\b/g, '#');
  const text = String(item.text || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 40);
  if (item.kind === 'link') return `L|${selPat}|${_hrefShape(item.href)}`;
  return `B|${selPat}|${text}`;
}
function _hrefShape(href) {
  if (!href) return '';
  try {
    const u = new URL(href, 'http://x');
    return u.pathname.replace(/\/[0-9a-f-]{6,}/gi, '/#').replace(/\/\d+/g, '/#');
  } catch { return String(href).slice(0, 40); }
}
function _isRow(item) {
  return /(\btr\b|tbody|\[role=['"]?row|row→first-cell|>\s*tr)/i.test(String(item.selector || ''));
}

async function annotateClickableIntents(pages) {
  if (!pages.length) return;
  const t0 = Date.now();
  const seen = new Map();          // sig → intent (global dedup, persists across pages)
  const queued = new Set();        // sigs already queued for labeling

  // ── plan: dedup (global + page) + table-row cap → unique reps to label ────
  const plans = [];                // { page, items, sigByIdx }
  const toLabel = [];              // { sig, item, ctx } representatives needing an LLM call
  let totalItems = 0;
  const workable = pages.filter(p => _flattenClickables(p.clickables).length > 0);
  for (const page of pages) {
    const items = _flattenClickables(page.clickables);
    if (!items.length) continue;
    const sigByIdx = items.map(_sigOf);
    plans.push({ page, items, sigByIdx });
    totalItems += items.length;
    const ctx = {
      url: page.finalUrl || page.requestedUrl,
      title: page.title || '',
      section: page.section || null,
      contextSnippet: page.headings ? JSON.stringify(page.headings).slice(0, 400) : '',
    };
    let rowSigsThisPage = 0;
    for (let i = 0; i < items.length; i++) {
      const sig = sigByIdx[i];
      if (seen.has(sig) || queued.has(sig)) continue;   // labeled elsewhere / already queued
      if (_isRow(items[i])) {
        if (rowSigsThisPage >= INTENT_ROW_CAP) continue; // table-row cap (rows only)
        rowSigsThisPage++;
      }
      queued.add(sig);
      toLabel.push({ sig, item: items[i], ctx });
    }
  }

  // ── batch the reps (grouped by page-context) and run concurrently ────────
  const batches = [];
  for (let i = 0; i < toLabel.length; i += INTENT_BATCH_SIZE) {
    const slice = toLabel.slice(i, i + INTENT_BATCH_SIZE);
    batches.push({ ctx: slice[0].ctx, reps: slice });   // ctx of first rep — good enough for labeling
  }
  console.log(
    `[crawler] intent-extract: ${totalItems} clickables on ${workable.length} pages → ` +
    `${toLabel.length} unique to label after dedup (global+page, table-row cap ${INTENT_ROW_CAP}); ` +
    `${batches.length} batches @ concurrency ${INTENT_CONCURRENCY}`
  );

  let doneBatches = 0, labeled = 0, failedBatches = 0;
  await _runPool(batches, INTENT_CONCURRENCY, async (batch) => {
    const advice = await adviseOn({
      kind: 'intent-extract',
      input: {
        url: batch.ctx.url, title: batch.ctx.title, section: batch.ctx.section,
        clickables: batch.reps.map(r => ({ kind: r.item.kind, text: r.item.text, selector: r.item.selector, href: r.item.href })),
        contextSnippet: batch.ctx.contextSnippet,
      },
    });
    doneBatches++;
    if (!advice?.recommendation?.intents) { failedBatches++; }
    else {
      for (const intent of advice.recommendation.intents) {
        const rep = batch.reps[intent.i - 1];           // intent.i is 1-based within the batch
        if (rep) { seen.set(rep.sig, stripIndex(intent)); labeled++; }
      }
    }
    if (batches.length > 4 && doneBatches % 5 === 0) {
      console.log(`[crawler]   ↳ intent batches ${doneBatches}/${batches.length} (${labeled} labeled)`);
    }
  });

  // ── propagate labels back to every item that shares a signature ──────────
  let annotatedPages = 0, annotatedIntents = 0;
  for (const { page, items, sigByIdx } of plans) {
    let i = 0, pageGot = 0;
    for (const btn of page.clickables?.buttons ?? []) {
      const intent = seen.get(sigByIdx[i++]);
      if (intent) { btn.intent = intent; annotatedIntents++; pageGot++; }
    }
    for (const lnk of page.clickables?.links ?? []) {
      const intent = seen.get(sigByIdx[i++]);
      if (intent) { lnk.intent = intent; annotatedIntents++; pageGot++; }
    }
    if (pageGot) annotatedPages++;
  }

  const ms = Date.now() - t0;
  const failMsg = failedBatches > 0 ? `  (${failedBatches} batch(es) had no usable LLM response)` : '';
  console.log(
    `[crawler] intent-extract: annotated ${annotatedIntents} clickables across ` +
    `${annotatedPages}/${pages.length} pages — ${labeled} unique LLM labels reused via dedup — ` +
    `in ${(ms / 1000).toFixed(1)}s${failMsg}`
  );
}


function _shortenUrl(url) {
  if (!url) return '(no url)';
  try {
    const u = new URL(url);
    const path = u.pathname + (u.search || '');
    return path.length > 60 ? path.slice(0, 57) + '…' : path;
  } catch {
    return url.length > 60 ? url.slice(0, 57) + '…' : url;
  }
}


function _flattenClickables(cl) {
  const out = [];
  if (!cl) return out;
  for (const b of cl.buttons ?? [])
    out.push({ kind: 'button', text: b.text ?? '', selector: b.selector ?? null });
  for (const l of cl.links ?? [])
    out.push({ kind: 'link', text: l.text ?? '', href: l.href ?? null, selector: l.selector ?? null });
  return out;
}


function _countAnnotatedIntents(pages) {
  let n = 0;
  for (const p of pages) {
    for (const b of (p.clickables?.buttons ?? [])) if (b.intent) n++;
    for (const l of (p.clickables?.links ?? [])) if (l.intent) n++;
  }
  return n;
}


function stripIndex(intent) {
  // Drop the per-batch numbering — the index is meaningful only to the LLM call.
  const { i, ...rest } = intent;
  return rest;
}

function provenanceShell() {
  // Attach a provenance block to the bundle itself (not per-fact — the source's
  // own provenance applies to everything in facts unless overridden).
  return {
    sourceId: 'crawler',
    discoveryTier: DiscoveryTier.LIVE_OBSERVED,
    confidence: 0.95,
    extractedAt: new Date().toISOString(),
    extractedBy: 'context-layer/content-extractor/crawler/extract.mjs',
    provenance: provenance({
      sourceId: 'crawler',
      tier: DiscoveryTier.LIVE_OBSERVED,
      extractedBy: 'crawler',
    }),
  };
}

await main();
