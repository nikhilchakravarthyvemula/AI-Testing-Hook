// Crawler source extractor — thin wrapper around context-layer/content-extractor/crawler/.
//
// Runs the existing crawler with whatever env vars are set, then reads its
// outputs (routes.json, pages.json, click-graph.json) and emits a
// normalized source-bundle JSON at output/crawler/bundle.json consumed
// by the indexer.
//
// Semantic source id is "crawler" (matches the folder name and the
// run.mjs auto-discovery convention).
//
// The crawler engine now lives alongside this adapter (moved out of scripts/) — we just shell out to it.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { adviseOn } from './llm-advisor/index.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

// The crawler engine now lives alongside this adapter (moved out of scripts/).
const CRAWLER_DIR = __dirname;
const CRAWLER_OUT = path.join(REPO_ROOT, 'output', 'crawler');
// Crawler-specific output folder. The crawler subsystem already writes
// raw data + reports under output/crawler/{data,reports}/ via context-layer/content-extractor/crawler;
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
    execFileSync('npm', ['run', '--silent', 'all'], {
      cwd: CRAWLER_DIR,
      stdio: 'inherit',
    });
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
    ...bundleMeta(),
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


async function annotateClickableIntents(pages) {
  if (!pages.length) return;
  // spec-15: the crawler has no live LLM. Intent + destructiveness are
  // classified by the HOST after the crawl (byo-llm-poc/ctx.mjs delegation),
  // so this in-crawl pass is a no-op — clickables are emitted raw. adviseOn()
  // returns null regardless; short-circuit to avoid iterating pages for nothing.
  console.log('[crawler] intent-extract: deferred to host (crawler emits raw clickables)');
  return;
  /* eslint-disable no-unreachable */
  let annotatedPages = 0;
  let annotatedIntents = 0;
  let failedBatches = 0;
  const t0 = Date.now();
  // LLM round-trips are slow on big prompts. Chunking ~15 clickables per
  // call keeps each LLM round under ~60s and lets a single timeout
  // on a noisy page not poison the whole page's annotations.
  const BATCH_SIZE = 15;

  // Pre-count pages with clickables so we can show "page N/M" progress
  // against the actual workload (skipping empty pages doesn't make sense).
  const workable = pages.filter(p => _flattenClickables(p.clickables).length > 0);
  console.log(
    `[crawler] intent-extract: ${workable.length}/${pages.length} pages have clickables ` +
    `(LLM batch size ${BATCH_SIZE}, ~30-60s per batch on the host model)`
  );

  let pageIdx = 0;
  for (const page of pages) {
    const items = _flattenClickables(page.clickables);
    if (items.length === 0) continue;
    pageIdx++;

    const totalBatches = Math.ceil(items.length / BATCH_SIZE);
    const pageUrl = page.finalUrl || page.requestedUrl || '(unknown)';
    const shortUrl = _shortenUrl(pageUrl);
    const pageT0 = Date.now();
    console.log(
      `[crawler] intent-extract: page ${pageIdx}/${workable.length} — ${shortUrl} ` +
      `(${items.length} clickables, ${totalBatches} batch${totalBatches > 1 ? 'es' : ''})`
    );

    // Build a flat array of intent objects (1-to-1 with `items`).
    const annotations = new Array(items.length).fill(null);
    let pageHadAny = false;
    let pageHadFail = false;

    let batchNum = 0;
    for (let start = 0; start < items.length; start += BATCH_SIZE) {
      batchNum++;
      const batch = items.slice(start, start + BATCH_SIZE);
      const batchT0 = Date.now();
      const advice = await adviseOn({
        kind: 'intent-extract',
        input: {
          url: page.finalUrl || page.requestedUrl,
          title: page.title || '',
          section: page.section || null,
          clickables: batch,
          contextSnippet: page.headings
            ? JSON.stringify(page.headings).slice(0, 400)
            : '',
        },
      });
      const batchMs = Date.now() - batchT0;
      if (!advice?.recommendation?.intents) {
        pageHadFail = true;
        if (totalBatches > 1) {
          console.log(`[crawler]   ↳ batch ${batchNum}/${totalBatches} no response (${batchMs}ms)`);
        }
        continue;
      }
      let batchGot = 0;
      for (const intent of advice.recommendation.intents) {
        // intent.i is 1-based within the BATCH; map back to global index.
        const globalIdx = start + (intent.i - 1);
        if (globalIdx >= 0 && globalIdx < items.length) {
          annotations[globalIdx] = intent;
          pageHadAny = true;
          batchGot++;
        }
      }
      if (totalBatches > 1) {
        console.log(`[crawler]   ↳ batch ${batchNum}/${totalBatches} ${batchGot}/${batch.length} ok (${batchMs}ms)`);
      }
    }

    if (pageHadFail && !pageHadAny) failedBatches++;
    if (!pageHadAny) {
      console.log(`[crawler]   ↳ page got 0 intents (${Date.now() - pageT0}ms)`);
      continue;
    }

    // Merge annotations back onto buttons[] then links[] in flatten order.
    let i = 0;
    let pageGot = 0;
    if (Array.isArray(page.clickables?.buttons)) {
      for (const btn of page.clickables.buttons) {
        const intent = annotations[i++];
        if (intent) { btn.intent = stripIndex(intent); annotatedIntents++; pageGot++; }
      }
    }
    if (Array.isArray(page.clickables?.links)) {
      for (const lnk of page.clickables.links) {
        const intent = annotations[i++];
        if (intent) { lnk.intent = stripIndex(intent); annotatedIntents++; pageGot++; }
      }
    }
    annotatedPages++;
    console.log(`[crawler]   ↳ ${pageGot}/${items.length} intents (${Date.now() - pageT0}ms)`);
  }
  const ms = Date.now() - t0;
  const failMsg = failedBatches > 0 ? `  (${failedBatches} page(s) had no usable LLM response)` : '';
  console.log(
    `[crawler] intent-extract: annotated ${annotatedIntents} clickables across ` +
    `${annotatedPages}/${pages.length} pages in ${(ms / 1000).toFixed(1)}s${failMsg}`
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

function bundleMeta() {
  // Basic metadata stamped on the bundle itself (not per-fact).
  return {
    sourceId: 'crawler',
    extractedAt: new Date().toISOString(),
    extractedBy: 'context-layer/content-extractor/crawler/extract.mjs',
  };
}

await main();
