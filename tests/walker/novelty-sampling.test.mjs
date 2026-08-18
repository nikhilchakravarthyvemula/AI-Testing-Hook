// novelty-sampling.test.mjs — adaptive per-template sampling (whole-app step 3).
//
// The property under test: a template's instances are visited only while
// samples reveal novelty (new API templates, interactable shapes, edge keys,
// or first-seen child templates). Identical clones saturate after
// NOVELTY_DRY_LIMIT dry samples; genuinely-different instances keep getting
// crawled. Saturated instances are dispositioned, never silently lost.
//
// Run: npm run test:walker

import assert from 'node:assert/strict';
import { runWorker } from '../../testo/src/crawler/walker/worker.mjs';
import { SharedState } from '../../testo/src/crawler/walker/state.mjs';

const B = 'https://app.test';
const quiet = () => {};
const emptyScan = async () => ({ items: [], totalElements: 0, rejected: [] });

function stubPage() {
  let currentUrl = 'about:blank';
  const ok = () => Promise.resolve();
  return {
    isClosed: () => false,
    url: () => currentUrl,
    async goto(url) { currentUrl = url; },
    waitForLoadState: ok, waitForFunction: ok, waitForTimeout: ok,
    keyboard: { press: ok }, screenshot: ok,
  };
}

// Drive the state machine directly: dequeue + report a sample with given signals.
function drainWithSamples(state, signalsFor) {
  const visited = [];
  let task;
  while ((task = state.tryDequeue())) {
    visited.push(task.url);
    state.recordSample(task.url, signalsFor(task.url, visited.length));
  }
  return visited;
}

const N = 20;
const seedsOf = (tpl) => Array.from({ length: N }, (_, i) => ({ url: `${B}/${tpl}/${1000 + i}`, depth: 0 }));

// ── 1. identical clones saturate at 1 + dryLimit ────────────────────────────
{
  const state = new SharedState({ seeds: seedsOf('inventory'), budgetMs: 0 });
  const visited = drainWithSamples(state, () => ({ shapeHash: 'same', edgeKeys: [], newApis: 0 }));
  assert.equal(visited.length, 3, '1 novel first sample + 2 dry = 3 visits at dryLimit 2');
  const cov = state.coverage();
  assert.equal(cov.urls.saturated.length, N - 3, 'remaining 17 sampled out');
  assert.equal(cov.complete, true, 'saturation is a deliberate bound — completeness holds');
  assert.equal(cov.stoppedBy, 'drained');
  assert.equal(cov.urls.visited + cov.urls.saturated.length, cov.urls.discovered, 'partition sums');
  assert.deepEqual(cov.templates.saturated, [`${B}/inventory/{id}`]);
  console.log('PASS  novelty 1 — identical clones: 3/20 visited, 17 saturated, COMPLETE');
}

// ── 2. continuous novelty (new APIs each time) → every instance visited ─────
{
  const state = new SharedState({ seeds: seedsOf('cases'), budgetMs: 0, maxSamplesPerTemplate: 0 });
  const visited = drainWithSamples(state, () => ({ shapeHash: 'same', edgeKeys: [], newApis: 1 }));
  assert.equal(visited.length, N, 'novelty keeps the sampler visiting');
  assert.equal(state.coverage().urls.saturated.length, 0);
  console.log('PASS  novelty 2 — continuous API novelty: all 20 visited');
}

// ── 3. novelty via changing shape (rows differ structurally) ────────────────
{
  const state = new SharedState({ seeds: seedsOf('detail'), budgetMs: 0, maxSamplesPerTemplate: 0 });
  const visited = drainWithSamples(state, (url, n) => ({ shapeHash: `shape-${n}`, edgeKeys: [], newApis: 0 }));
  assert.equal(visited.length, N, 'each new shape resets the dry streak');
  console.log('PASS  novelty 3 — per-instance shape novelty: all visited');
}

// ── 4. NOVELTY_DRY_LIMIT=0 disables the gate ────────────────────────────────
{
  const state = new SharedState({ seeds: seedsOf('all'), budgetMs: 0, noveltyDryLimit: 0, maxSamplesPerTemplate: 0 });
  const visited = drainWithSamples(state, () => ({ shapeHash: 'same', edgeKeys: [], newApis: 0 }));
  assert.equal(visited.length, N, 'gate off → every instance visited');
  console.log('PASS  novelty 4 — dryLimit 0: sampler disabled, all visited');
}

// ── 5. hard cap wins even under continuous novelty ──────────────────────────
{
  const state = new SharedState({ seeds: seedsOf('capped'), budgetMs: 0, maxSamplesPerTemplate: 4 });
  const visited = drainWithSamples(state, () => ({ shapeHash: 'x', edgeKeys: [], newApis: 1 }));
  assert.equal(visited.length, 4, 'hard ceiling regardless of novelty');
  assert.equal(state.coverage().urls.saturated.length, N - 4);
  console.log('PASS  novelty 5 — MAX_SAMPLES_PER_TEMPLATE beats novelty');
}

// ── 6. distinct templates unaffected — every unique route always visited ────
{
  const names = ['home', 'users', 'settings', 'billing', 'reports', 'alerts', 'teams', 'search', 'help', 'graph'];
  const seeds = names.map((n) => ({ url: `${B}/${n}`, depth: 0 }));
  const state = new SharedState({ seeds, budgetMs: 0 });
  const visited = drainWithSamples(state, () => ({ shapeHash: 'same', edgeKeys: [], newApis: 0 }));
  assert.equal(visited.length, 10, 'singleton templates never saturate');
  console.log('PASS  novelty 6 — singleton templates always visited');
}

// ── 7. child-template discovery counts as novelty ───────────────────────────
{
  const state = new SharedState({ seeds: seedsOf('parents'), budgetMs: 0, maxSamplesPerTemplate: 0 });
  const visited = [];
  let task, n = 0;
  while ((task = state.tryDequeue())) {
    if (task.url.includes('/parents/')) {
      visited.push(task.url);
      n++;
      // each parent instance reveals a brand-new child TEMPLATE (novelty)…
      state.enqueue({ url: `${B}/child${n}/view`, depth: 1, parentUrl: task.url });
      state.recordSample(task.url, { shapeHash: 'same', edgeKeys: [], newApis: 0 });
    } else {
      state.recordSample(task.url, { shapeHash: 'child', edgeKeys: [], newApis: 0 });
    }
  }
  assert.equal(visited.length, N, 'template discovery resets the dry streak every time');
  console.log('PASS  novelty 7 — new child templates keep the parent template alive');
}

// ── 9. VOLATILE GENERATED IDS ≠ novelty (the 2026-08-17 live failure) ───────
// Radix/MUI mint a fresh element id per render, so every instance of a
// template carries a never-seen `sel:#radix-_r_X_` key. Un-normalized, that
// one key resets the dry streak forever — the /policies?rule=* crawl ran 18
// pages with ZERO dry samples before being killed. Normalization must make
// these instances saturate exactly like identical clones.
{
  const state = new SharedState({ seeds: seedsOf('rules'), budgetMs: 0 });
  let render = 0;
  const visited = drainWithSamples(state, () => ({
    shapeHash: 'same',
    // stable structural keys + ONE volatile generated-id key per render
    edgeKeys: [
      'sel:body > main > table > tr:nth-of-type(1) > button',
      `sel:#radix-_r_${(render++).toString(36)}_`,
    ],
    newApis: 0,
  }));
  assert.equal(visited.length, 3, 'volatile ids collapse to {gen} → saturates at 1 + dryLimit');
  assert.equal(state.coverage().urls.saturated.length, N - 3);
  console.log('PASS  novelty 9 — volatile radix ids normalized: saturates at 3, not never');
}

// ── 10. undetected volatility is bounded by the default hard cap ────────────
// A generated-id pattern NOT in GENERATED_ID_RE (unknown UI lib) is perpetual
// fake novelty — the detector can't catch it, so the default
// maxSamplesPerTemplate=10 must bound the damage.
{
  const state = new SharedState({ seeds: seedsOf('unknownlib'), budgetMs: 0 });   // defaults
  let render = 0;
  const visited = drainWithSamples(state, () => ({
    shapeHash: 'same',
    edgeKeys: [`sel:#sparkle-ui-${(render++).toString(36)}`],   // unknown prefix
    newApis: 0,
  }));
  assert.equal(visited.length, 10, 'default hard cap bounds undetected volatility');
  assert.equal(state.coverage().urls.saturated.length, N - 10);
  console.log('PASS  novelty 10 — unknown volatile pattern: capped at default 10');
}

// ── 8. worker integration: empty pages saturate through the real loop ───────
{
  const state = new SharedState({ seeds: seedsOf('rows'), budgetMs: 0 });
  await runWorker({ workerId: 1, state, page: stubPage(), scannerFn: emptyScan, log: quiet });
  const cov = state.coverage();
  assert.equal(cov.urls.visited, 3, 'runWorker + recordSample: 3 visited');
  assert.equal(cov.urls.saturated.length, N - 3);
  assert.equal(cov.complete, true);
  console.log('PASS  novelty 8 — end-to-end through runWorker: 3/20 visited');
}

console.log('\nAll novelty-sampling scenarios passed.');
