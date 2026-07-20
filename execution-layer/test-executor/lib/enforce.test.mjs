import test from 'node:test';
import assert from 'node:assert/strict';

import { classify } from './enforce.mjs';
import { matchesSafetyFloor, parseAllowlist, SAFETY_FLOOR } from './safety-floor.mjs';

const empty = new Set();

// ── the safety floor regex ────────────────────────────────────────────────────

test('safety floor matches destructive verbs in title/intent/targets', () => {
  assert.ok(matchesSafetyFloor({ title: 'delete the account' }));
  assert.ok(matchesSafetyFloor({ intent: 'the user can sign out' }));
  assert.ok(matchesSafetyFloor({ title: 'x', intent: 'y', targets: { endpoints: ['POST /api/logout'] } }));
  assert.ok(matchesSafetyFloor({ targets: { pages: ['/cancel-subscription'] } }));
});

test('safety floor does NOT match ordinary read/write language', () => {
  assert.equal(matchesSafetyFloor({ title: 'view the cart', intent: 'load the page' }), false);
  assert.equal(matchesSafetyFloor({ title: 'create an order', intent: 'submit checkout' }), false);
  // \b precision: no match inside a larger word.
  assert.equal(SAFETY_FLOOR.test('uncancellable'), false);
});

test('parseAllowlist splits on commas and whitespace', () => {
  assert.deepEqual([...parseAllowlist('sc-01, sc-02  sc-03')], ['sc-01', 'sc-02', 'sc-03']);
  assert.deepEqual([...parseAllowlist('')], []);
  assert.deepEqual([...parseAllowlist(undefined)], []);
});

// ── classify: order + precedence ──────────────────────────────────────────────

test('failed-generation is carried as error, never run', () => {
  const d = classify({ scenarioId: 'x', status: 'failed-generation', mutation: false }, {}, { mode: 'safe', allowlist: empty });
  assert.deepEqual(d, { decision: 'carry', status: 'error', reason: 'failed-generation' });
});

test('safe mode skips mutations', () => {
  const d = classify({ scenarioId: 'x', status: 'generated', mutation: true }, { title: 'place order' }, { mode: 'safe', allowlist: empty });
  assert.deepEqual(d, { decision: 'skip', status: 'skipped-mutation', reason: 'safe-mode' });
});

test('full mode runs mutations', () => {
  const d = classify({ scenarioId: 'x', status: 'generated', mutation: true }, { title: 'place order' }, { mode: 'full', allowlist: empty });
  assert.deepEqual(d, { decision: 'run' });
});

test('safety floor outranks mode — skips even in full mode', () => {
  const entry = { scenarioId: 'x', status: 'generated', mutation: false };
  const scenario = { title: 'delete account', intent: 'remove the user' };
  assert.deepEqual(classify(entry, scenario, { mode: 'full', allowlist: empty }),
    { decision: 'skip', status: 'skipped-mutation', reason: 'safety-floor' });
  assert.deepEqual(classify(entry, scenario, { mode: 'safe', allowlist: empty }),
    { decision: 'skip', status: 'skipped-mutation', reason: 'safety-floor' });
});

test('an allowlisted scenarioId is the only way past the floor', () => {
  const entry = { scenarioId: 'sc-danger', status: 'generated', mutation: false };
  const scenario = { title: 'delete account' };
  assert.deepEqual(classify(entry, scenario, { mode: 'full', allowlist: new Set(['sc-danger']) }),
    { decision: 'run' });
});

test('a plain safe scenario runs', () => {
  assert.deepEqual(
    classify({ scenarioId: 'x', status: 'generated', mutation: false }, { title: 'view cart' }, { mode: 'safe', allowlist: empty }),
    { decision: 'run' });
});
