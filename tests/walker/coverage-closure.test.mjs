// coverage-closure.test.mjs — frontier closure + coverage manifest (step 2).
//
// Asserts the three stopping regimes (drained / time / pages) and that every
// URL the frontier accepted ends with exactly one disposition — the property
// that makes "the whole application was scanned" a checkable claim.
//
// Run: npm run test:walker

import assert from 'node:assert/strict';
import { runWorker } from '../../testo/src/crawler/walker/worker.mjs';
import { SharedState } from '../../testo/src/crawler/walker/state.mjs';

const B = 'https://app.test';
const quiet = () => {};
const emptyScan = async () => ({ items: [], totalElements: 0, rejected: [] });

function stubPage(plan = new Map()) {
  let dead = false, currentUrl = 'about:blank';
  const ok = () => Promise.resolve();
  return {
    isClosed: () => dead,
    url: () => currentUrl,
    async goto(url) {
      if (dead) throw new Error('Target page, context or browser has been closed');
      const behavior = plan.get(url) ?? 'ok';
      if (behavior === 'crash') { dead = true; throw new Error('page.goto: Page crashed'); }
      currentUrl = url;
    },
    waitForLoadState: ok, waitForFunction: ok, waitForTimeout: ok,
    keyboard: { press: ok }, screenshot: ok,
  };
}

const stoppedBy = (state) => state.coverage().stoppedBy;

// ── 1. budget 0 = unbounded → frontier drains → COMPLETE ────────────────────
{
  const urls = Array.from({ length: 6 }, (_, i) => `${B}/s${i}`);
  const state = new SharedState({ seeds: urls.map(u => ({ url: u, depth: 0 })), budgetMs: 0 });
  assert.equal(state.isBudgetExhausted(), null, 'budget 0 never expires on time');
  await runWorker({ workerId: 1, state, page: stubPage(), scannerFn: emptyScan, log: quiet });
  const cov = state.coverage();
  assert.equal(cov.complete, true);
  assert.equal(cov.stoppedBy, 'drained');
  assert.equal(cov.urls.visited, 6);
  assert.equal(cov.urls.pending.length, 0);
  console.log('PASS  closure 1 — budget 0: runs to frontier closure, COMPLETE/drained');
}

// ── 2. time failsafe → INCOMPLETE with pending dispositioned ────────────────
{
  const urls = Array.from({ length: 5 }, (_, i) => `${B}/t${i}`);
  const state = new SharedState({ seeds: urls.map(u => ({ url: u, depth: 0 })), budgetMs: 1 });
  await new Promise(r => setTimeout(r, 5));            // let the 1ms budget lapse
  await runWorker({ workerId: 1, state, page: stubPage(), scannerFn: emptyScan, log: quiet });
  const cov = state.coverage();
  assert.equal(cov.complete, false);
  assert.equal(cov.stoppedBy, 'time');
  assert.equal(cov.urls.visited, 0, 'nothing visited after expiry');
  assert.equal(cov.urls.pending.length, 5, 'all seeds dispositioned as pending');
  console.log('PASS  closure 2 — time failsafe: INCOMPLETE, pending fully listed');
}

// ── 3. pages cap → stoppedBy pages ──────────────────────────────────────────
{
  const urls = Array.from({ length: 5 }, (_, i) => `${B}/p${i}`);
  const state = new SharedState({ seeds: urls.map(u => ({ url: u, depth: 0 })), budgetMs: 0, maxPages: 2 });
  await runWorker({ workerId: 1, state, page: stubPage(), scannerFn: emptyScan, log: quiet });
  const cov = state.coverage();
  assert.equal(cov.complete, false);
  assert.equal(cov.stoppedBy, 'pages');
  assert.equal(cov.urls.visited, 2);
  assert.equal(cov.urls.pending.length, 3);
  console.log('PASS  closure 3 — pages cap: stoppedBy=pages, remainder pending');
}

// ── 4. abandoned ≠ complete, and every URL has exactly one disposition ──────
{
  const state = new SharedState({
    seeds: [`${B}/ok1`, `${B}/crash`, `${B}/ok2`, `${B}/skipme/x`].map(u => ({ url: u, depth: 0 })),
    budgetMs: 0, skipRoutes: /skipme/,
  });
  let pageNo = 0;
  const mk = () => stubPage(new Map([[`${B}/crash`, 'crash']]));
  await runWorker({
    workerId: 1, state, page: mk(), scannerFn: emptyScan, log: quiet,
    recreatePage: async () => { pageNo++; return mk(); },
  });
  const cov = state.coverage();
  assert.equal(cov.stoppedBy, 'drained', 'queue fully drained');
  assert.equal(cov.complete, false, 'abandoned URL blocks the completeness claim');
  assert.deepEqual(cov.urls.abandoned, [`${B}/crash`]);
  assert.deepEqual(cov.urls.skipped, [`${B}/skipme/x`]);
  assert.equal(cov.urls.visited, 2);
  // disposition partition: every discovered URL lands in exactly one bucket
  const total = cov.urls.visited + cov.urls.abandoned.length + cov.urls.pending.length
              + cov.urls.depthCapped.length;
  assert.equal(total, cov.urls.discovered, 'every discovered URL dispositioned exactly once');
  console.log('PASS  closure 4 — abandoned/skipped dispositioned; partition adds up');
}

// ── 5. template rollup: 40 instances of one template pending → 1 coverage hole ─
{
  const seeds = [{ url: `${B}/home`, depth: 0 }];
  const state = new SharedState({ seeds, budgetMs: 0 });
  // simulate discovery enqueuing 40 rule variants + one real section, then time-out style exit
  for (let i = 0; i < 40; i++) state.enqueue({ url: `${B}/policies?rule=r${i}`, depth: 1 });
  state.enqueue({ url: `${B}/sessions`, depth: 1 });
  state.tryDequeue();                                   // visit /home only
  const cov = state.coverage();
  assert.equal(cov.templates.visited, 1);
  assert.equal(cov.urls.pending.length, 41);
  assert.equal(cov.templates.pending.length, 2, '41 pending URLs = 2 real coverage holes');
  assert.ok(cov.templates.pending.includes(`${B}/policies?rule=*`));
  assert.ok(cov.templates.pending.includes(`${B}/sessions`));
  console.log('PASS  closure 5 — pending URLs roll up to route templates');
}

// ── 6. depth-capped URLs are dispositioned, and don't break completeness ────
{
  const state = new SharedState({ seeds: [{ url: `${B}/home`, depth: 0 }], budgetMs: 0, maxDepth: 1 });
  state.enqueue({ url: `${B}/too/deep`, depth: 2 });
  state.tryDequeue();   // /home
  state.tryDequeue();   // /too/deep → depth-capped, not silently lost
  const cov = state.coverage();
  assert.deepEqual(cov.urls.depthCapped, [`${B}/too/deep`]);
  assert.equal(cov.complete, true, 'depth cap is a deliberate bound — completeness holds');
  assert.equal(cov.urls.visited + cov.urls.depthCapped.length, cov.urls.discovered);
  console.log('PASS  closure 6 — depth-capped dispositioned; deliberate bounds ≠ incomplete');
}

console.log('\nAll coverage-closure scenarios passed.');
