// crash-recovery.test.mjs — walker survives a renderer crash (Fix 1, Phase 0).
//
// Replays the 2026-08-13 console-preview failure WITHOUT a browser: stub Page
// objects drive runWorker + SharedState directly. The old behavior (worker
// reuses the dead page, every remaining queue item fails instantly, tasks
// consumed with no requeue) is asserted gone.
//
// Run: npm run test:walker   (plain node, no Playwright, < 5s)

import assert from 'node:assert/strict';
import { runWorker, isDeadPage } from '../../testo/src/crawler/walker/worker.mjs';
import { SharedState } from '../../testo/src/crawler/walker/state.mjs';

const CRASH = () => { const e = new Error('page.goto: Page crashed'); return e; };
const CLOSED = () => new Error('page.goto: Target page, context or browser has been closed');

// A stub Playwright Page. `plan` maps url → behavior for goto:
//   'ok' | 'crash' (throws + page dies) | 'timeout' (throws, page stays alive)
// Once dead, EVERY goto throws instantly (that's the poisoning we recover from).
function stubPage(name, plan, events) {
  let dead = false;
  let currentUrl = 'about:blank';
  const resolved = () => Promise.resolve();
  return {
    name,
    isClosed: () => dead,
    url: () => currentUrl,
    async goto(url) {
      events.push(`${name}:goto:${url}`);
      if (dead) throw CLOSED();
      const behavior = plan.get(url) ?? 'ok';
      if (behavior === 'crash') { dead = true; plan.set(url, 'crash-again'); throw CRASH(); }
      if (behavior === 'crash-again') { dead = true; throw CRASH(); }
      if (behavior === 'timeout') { plan.set(url, 'ok'); throw new Error('page.goto: Timeout 30000ms exceeded.'); }
      currentUrl = url;
    },
    waitForLoadState: resolved,
    waitForFunction: resolved,
    waitForTimeout: resolved,
    keyboard: { press: resolved },
    screenshot: resolved,
  };
}

const emptyScan = async () => ({ items: [], totalElements: 0, rejected: [] });
const quiet = () => {};
const issueCount = (state, type) => state.issues.filter(i => i.type === type).length;

// ── scenario 1: crash mid-queue → recreate + requeue → rest of queue survives ─
{
  const events = [];
  const B = 'https://app.test';
  const urls = [`${B}/a`, `${B}/b`, `${B}/crash`, `${B}/c`, `${B}/d`];
  const state = new SharedState({ seeds: urls.map(u => ({ url: u, depth: 0 })) });

  // /crash kills every page that visits it (both attempts) — like /graph did.
  let pageNo = 0;
  const mkPage = () => stubPage(`p${++pageNo}`, new Map([[`${B}/crash`, 'crash']]), events);
  let recreations = 0;
  const recreatePage = async () => { recreations++; return mkPage(); };

  await runWorker({
    workerId: 1, state, page: mkPage(),
    scannerFn: emptyScan, log: quiet, recreatePage,
  });

  for (const u of [`${B}/a`, `${B}/b`, `${B}/c`, `${B}/d`]) {
    assert.ok(state.interactedUrls.has(u), `expected ${u} to be visited`);
  }
  assert.equal(issueCount(state, 'page-crashed'), 2, 'crash recorded on both attempts');
  assert.equal(recreations, 2, 'page recreated after each crash');
  assert.equal(issueCount(state, 'page-recreated'), 2);
  assert.equal(issueCount(state, 'task-abandoned'), 1, '/crash abandoned after attempt cap');
  assert.equal(state.pending.length, 0, 'queue fully drained');
  // The old bug: goto attempts against a dead page. Every goto after a crash
  // must be on a FRESH page object.
  const gotosAfterCrash = events.slice(events.findIndex(e => e.includes('/crash')) + 1);
  assert.ok(!gotosAfterCrash.some(e => e.startsWith('p1:')), 'dead p1 never reused');
  console.log('PASS  scenario 1 — crash mid-queue: recreate + requeue, 4/4 healthy routes visited');
}

// ── scenario 2: transient nav timeout (page alive) → requeued, no recreation ─
{
  const events = [];
  const B = 'https://app.test';
  const state = new SharedState({ seeds: [{ url: `${B}/flaky`, depth: 0 }, { url: `${B}/ok`, depth: 0 }] });
  let recreations = 0;

  await runWorker({
    workerId: 1, state,
    page: stubPage('p1', new Map([[`${B}/flaky`, 'timeout']]), events),
    scannerFn: emptyScan, log: quiet,
    recreatePage: async () => { recreations++; throw new Error('should not be called'); },
  });

  assert.ok(state.interactedUrls.has(`${B}/flaky`), 'flaky route visited on retry');
  assert.ok(state.interactedUrls.has(`${B}/ok`));
  assert.equal(recreations, 0, 'no recreation for a live page');
  assert.equal(issueCount(state, 'task-failed'), 1, 'timeout recorded as task-failed');
  assert.equal(issueCount(state, 'task-abandoned'), 0);
  console.log('PASS  scenario 2 — transient nav timeout: requeued once, visited, no recreation');
}

// ── scenario 3: crash with NO recreatePage → worker exits, doesn't drain queue ─
{
  const events = [];
  const B = 'https://app.test';
  const urls = [`${B}/crash`, `${B}/x`, `${B}/y`];
  const state = new SharedState({ seeds: urls.map(u => ({ url: u, depth: 0 })) });

  await runWorker({
    workerId: 1, state,
    page: stubPage('p1', new Map([[`${B}/crash`, 'crash']]), events),
    scannerFn: emptyScan, log: quiet,   // recreatePage absent
  });

  assert.equal(issueCount(state, 'worker-dead'), 1, 'worker exit recorded');
  // Remaining tasks must still be pending (for siblings), not consumed as failures.
  const remaining = state.pending.map(t => t.url);
  assert.ok(remaining.includes(`${B}/x`) && remaining.includes(`${B}/y`),
    'queue not consumed by a dead worker');
  console.log('PASS  scenario 3 — no recreatePage: worker exits without consuming the queue');
}

// ── scenario 4: CRAWL_SKIP_ROUTES excludes + records, seeds and enqueue ──────
{
  const state = new SharedState({
    seeds: [{ url: 'https://a.test/graph', depth: 0 }, { url: 'https://a.test/ok', depth: 0 }],
    skipRoutes: /\/graph/i,
  });
  assert.equal(state.pending.length, 1, 'skipped seed filtered');
  assert.equal(state.enqueue({ url: 'https://a.test/graph?x=1', depth: 1 }), false, 'skipped at enqueue');
  assert.equal(issueCount(state, 'route-skipped'), 2);
  assert.deepEqual(state.serialize().skippedRoutes.length, 2, 'skips serialized');
  console.log('PASS  scenario 4 — CRAWL_SKIP_ROUTES: excluded and recorded, never silent');
}

// ── scenario 5: isDeadPage classification ────────────────────────────────────
{
  const alive = { isClosed: () => false };
  assert.ok(isDeadPage(alive, CRASH()));
  assert.ok(isDeadPage(alive, CLOSED()));
  assert.ok(isDeadPage({ isClosed: () => true }, new Error('anything')));
  assert.ok(!isDeadPage(alive, new Error('page.goto: Timeout 30000ms exceeded.')));
  assert.ok(!isDeadPage(alive, new Error('locator.click: Timeout 3000ms exceeded.')));
  console.log('PASS  scenario 5 — isDeadPage: crashes/closures yes, timeouts no');
}

console.log('\nAll crash-recovery scenarios passed.');
