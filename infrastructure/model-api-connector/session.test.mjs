// Contract tests for runSession() — C2b, driven entirely by the mock session
// provider so the whole agent-session mechanism is proven without an engine:
// the honesty rule, budget reservation, ledger accounting, and the
// engine-unavailable degrade path. A live claude session is checked, opt-in,
// in session-live.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runSession } from './session.mjs';
import { readLedger, requestsSpent } from './ledger.mjs';

// ── harness ──────────────────────────────────────────────────────────────────

function setup(t) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'c2b-'));
  fs.writeFileSync(path.join(ws, 'ledger.jsonl'), '');
  const fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'c2b-fx-'));
  const prev = process.env.MOCK_FIXTURES_DIR;
  process.env.MOCK_FIXTURES_DIR = fixtures;
  t.after(() => {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(fixtures, { recursive: true, force: true });
    if (prev === undefined) delete process.env.MOCK_FIXTURES_DIR;
    else process.env.MOCK_FIXTURES_DIR = prev;
  });
  return { ws, fixtures };
}

/** Write a session fixture: files the mock session will "produce". */
function seedSessionFixture(fixtures, featureId, files, meta = {}) {
  const dir = path.join(fixtures, 'sessions', featureId);
  if (files) {
    for (const [rel, content] of Object.entries(files)) {
      const p = path.join(dir, 'files', rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
    }
  } else {
    fs.mkdirSync(dir, { recursive: true });   // fixture exists but produces nothing
  }
  fs.writeFileSync(path.join(dir, 'session.json'),
    JSON.stringify({ model: 'mock-sonnet', turns: 4, inputTokens: 500, outputTokens: 300, ...meta }));
}

const slice = (featureId = 'feat:checkout') => ({
  featureId, name: 'Checkout',
  scenarios: [
    { scenarioId: 'sc-1', title: 'cart loads', kind: 'ui', intent: 'renders', mutation: false,
      targets: { pages: ['/cart'] } },
    { scenarioId: 'sc-2', title: 'create order', kind: 'api', intent: 'writes', mutation: true,
      targets: { endpoints: ['POST /api/v2/orders'] } },
  ],
});

// ── required args ────────────────────────────────────────────────────────────

test('missing required args throw', async (t) => {
  const { ws } = setup(t);
  await assert.rejects(() => runSession({ slice: slice(), provider: 'mock' }), /workspace/);
  await assert.rejects(() => runSession({ workspace: ws, provider: 'mock' }), /slice/);
  await assert.rejects(() => runSession({ workspace: ws, slice: { name: 'x' }, provider: 'mock' }), /featureId/);
});

// ── happy path ───────────────────────────────────────────────────────────────

test('a session that produces files succeeds and reports them', async (t) => {
  const { ws, fixtures } = setup(t);
  seedSessionFixture(fixtures, 'feat:checkout', {
    'sc-1.spec.mjs': '// run: r  scenario: sc-1  generator: agent\n',
    'sc-2.spec.mjs': '// run: r  scenario: sc-2  generator: agent\n',
  });

  const r = await runSession({ workspace: ws, slice: slice(), provider: 'mock', maxRequests: 200 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.filesWritten.sort(), [
    'tests/feat:checkout/sc-1.spec.mjs',
    'tests/feat:checkout/sc-2.spec.mjs',
  ]);
  // The files really landed in the workspace.
  assert.ok(fs.existsSync(path.join(ws, 'tests', 'feat:checkout', 'sc-1.spec.mjs')));
  assert.equal(r.usage.requests, 4, 'a session spends its turns against the budget');
  assert.equal(r.engine, 'mock');
});

test('the session is ledgered as A1 work with its turn count', async (t) => {
  const { ws, fixtures } = setup(t);
  seedSessionFixture(fixtures, 'feat:checkout', { 'sc-1.spec.mjs': '// x\n' }, { turns: 6 });

  await runSession({ workspace: ws, slice: slice(), provider: 'mock', maxRequests: 200 });
  const ledger = readLedger(ws);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].useCase, 'A1');
  assert.equal(ledger[0].caller, 'session');
  assert.equal(ledger[0].requests, 6);
  assert.equal(ledger[0].feature, 'feat:checkout');
  assert.equal(requestsSpent(ws), 6);
});

// ── the honesty rule ─────────────────────────────────────────────────────────

test('a session that writes NOTHING is a failure, whatever it claimed', async (t) => {
  const { ws, fixtures } = setup(t);
  seedSessionFixture(fixtures, 'feat:checkout', null);   // fixture exists, no files

  const r = await runSession({ workspace: ws, slice: slice(), provider: 'mock', maxRequests: 200 });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'honesty-failure');
  assert.deepEqual(r.filesWritten, []);
  // Still ledgered (degraded) so the report can account for the wasted turns.
  const ledger = readLedger(ws);
  assert.equal(ledger[0].degraded, true);
});

test('pre-existing files do not count as this session\'s output', async (t) => {
  const { ws, fixtures } = setup(t);
  // A leftover file from an earlier slice attempt sits in the feature dir.
  const dir = path.join(ws, 'tests', 'feat:checkout');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'old.spec.mjs'), '// stale\n');
  seedSessionFixture(fixtures, 'feat:checkout', null);   // this session writes nothing new

  const r = await runSession({ workspace: ws, slice: slice(), provider: 'mock', maxRequests: 200 });
  assert.equal(r.ok, false, 'the old file must not mask an empty session');
  assert.equal(r.error, 'honesty-failure');
});

// ── budget ───────────────────────────────────────────────────────────────────

test('a session will not START without its reserved floor of budget', async (t) => {
  const { ws, fixtures } = setup(t);
  seedSessionFixture(fixtures, 'feat:checkout', { 'sc-1.spec.mjs': '// x\n' });
  // Spend the ledger down to below SESSION_MIN_BUDGET (default 10) of headroom.
  fs.writeFileSync(path.join(ws, 'ledger.jsonl'),
    JSON.stringify({ useCase: 'S1', requests: 195 }) + '\n');

  const r = await runSession({ workspace: ws, slice: slice(), provider: 'mock', maxRequests: 200 });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'budget-exhausted');
  assert.match(r.detail, /floor of 10/);
  // No new files, and no session-turn ledger line was added.
  assert.equal(readLedger(ws).length, 1);
});

// ── degrade paths ────────────────────────────────────────────────────────────

test('a missing session fixture is engine-unavailable (drives C6 template fallback)', async (t) => {
  const { ws } = setup(t);   // no fixture seeded
  const r = await runSession({ workspace: ws, slice: slice(), provider: 'mock', maxRequests: 200 });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'engine-unavailable');
  assert.match(r.detail, /no session fixture/);
});

test('the copilot session stub degrades cleanly (P1)', async (t) => {
  const { ws } = setup(t);
  const r = await runSession({ workspace: ws, slice: slice(), provider: 'copilot', maxRequests: 200 });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'engine-unavailable');
  assert.match(r.detail, /P1/);
});

test('an unknown session engine throws', async (t) => {
  const { ws } = setup(t);
  await assert.rejects(
    () => runSession({ workspace: ws, slice: slice(), provider: 'gpt', maxRequests: 200 }),
    /unknown session engine "gpt"/,
  );
});
