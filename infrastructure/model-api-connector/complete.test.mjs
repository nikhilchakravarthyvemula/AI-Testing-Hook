// Contract tests for complete() — the C2a acceptance suite (p0-02 §4).
//
// These run against the `mock` provider (always, no credentials) and the
// `copilot` stub (expected-failure shape). The live `claude` provider has its
// own opt-in check in claude-provider.test.mjs, gated so CI never needs a login.
//
// Every property here is a promise complete()'s callers rely on to write their
// deterministic fallbacks: it never throws for an engine problem, the budget is
// never overspent, a cache hit is free, and every live call leaves a ledger line.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { complete } from './complete.mjs';
import { cacheKeyFor } from './cache.mjs';
import { readLedger, requestsSpent } from './ledger.mjs';
import { fixtureFile } from './providers/mock.mjs';

// ── harness ──────────────────────────────────────────────────────────────────

function setup(t) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'c2-'));
  fs.writeFileSync(path.join(ws, 'ledger.jsonl'), '');
  const fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'c2-fx-'));
  const prevFxDir = process.env.MOCK_FIXTURES_DIR;
  process.env.MOCK_FIXTURES_DIR = fixtures;
  t.after(() => {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(fixtures, { recursive: true, force: true });
    if (prevFxDir === undefined) delete process.env.MOCK_FIXTURES_DIR;
    else process.env.MOCK_FIXTURES_DIR = prevFxDir;
  });
  return { ws, fixtures };
}

/** Write a mock fixture for a given request so the engine "answers". */
function seedFixture(req, { text, model = 'mock-model', usage = { inputTokens: 10, outputTokens: 5 } }) {
  const key = req.cacheKey || cacheKeyFor(req);
  const file = fixtureFile(req.useCase, key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ text, model, usage }));
}

const S2_SCHEMA = {
  type: 'object',
  properties: { same: { type: 'boolean' }, confidence: { type: 'number' } },
  required: ['same', 'confidence'],
  additionalProperties: false,
};

// ── request validation ───────────────────────────────────────────────────────

test('missing required fields throw (a programming error, not an engine one)', async (t) => {
  const { ws } = setup(t);
  await assert.rejects(() => complete({ prompt: 'x', workspace: ws, provider: 'mock' }), /useCase/);
  await assert.rejects(() => complete({ useCase: 'S2', workspace: ws, provider: 'mock' }), /prompt/);
  await assert.rejects(() => complete({ useCase: 'S2', prompt: 'x', provider: 'mock' }), /workspace/);
});

// ── plain text ───────────────────────────────────────────────────────────────

test('a text completion returns text + usage + a ledger line', async (t) => {
  const { ws } = setup(t);
  const req = { useCase: 'S4', prompt: 'summarize', workspace: ws, provider: 'mock' };
  seedFixture(req, { text: 'a short summary', usage: { inputTokens: 20, outputTokens: 8 } });

  const r = await complete(req);
  assert.equal(r.ok, true);
  assert.equal(r.text, 'a short summary');
  assert.equal(r.cacheHit, false);
  assert.deepEqual(r.usage, { requests: 1, inputTokens: 20, outputTokens: 8 });

  const ledger = readLedger(ws);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].useCase, 'S4');
  assert.equal(ledger[0].requests, 1);
  assert.equal(ledger[0].cacheHit, false);
});

// ── schema ───────────────────────────────────────────────────────────────────

test('a schema completion parses and returns validated json', async (t) => {
  const { ws } = setup(t);
  const req = { useCase: 'S2', prompt: 'same?', schema: S2_SCHEMA, workspace: ws, provider: 'mock' };
  seedFixture(req, { text: '{"same": true, "confidence": 0.9}' });

  const r = await complete(req);
  assert.equal(r.ok, true);
  assert.deepEqual(r.json, { same: true, confidence: 0.9 });
  assert.equal(r.text, undefined, 'schema calls return json, not text');
});

test('a fenced json response is tolerated', async (t) => {
  const { ws } = setup(t);
  const req = { useCase: 'S2', prompt: 'same?', schema: S2_SCHEMA, workspace: ws, provider: 'mock' };
  seedFixture(req, { text: '```json\n{"same": false, "confidence": 0.1}\n```' });

  const r = await complete(req);
  assert.equal(r.ok, true);
  assert.deepEqual(r.json, { same: false, confidence: 0.1 });
});

test('output that never validates → bad-output after one retry (2 requests)', async (t) => {
  const { ws } = setup(t);
  // The mock is deterministic per key, so both the attempt and the retry get the
  // same bad answer — exactly the "model can't produce the shape" case.
  const req = { useCase: 'S2', prompt: 'same?', schema: S2_SCHEMA, workspace: ws, provider: 'mock' };
  seedFixture(req, { text: '{"same": "yes"}' });   // wrong type, missing confidence

  const r = await complete(req);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'bad-output');
  assert.match(r.detail, /after one retry/);
  assert.equal(requestsSpent(ws), 2, 'initial + one retry both hit the engine');
});

// ── cache ────────────────────────────────────────────────────────────────────

test('the same request twice hits the engine once', async (t) => {
  const { ws } = setup(t);
  const req = { useCase: 'S1', prompt: 'ideate', workspace: ws, provider: 'mock' };
  seedFixture(req, { text: 'scenario list' });

  const first = await complete(req);
  assert.equal(first.cacheHit, false);

  const second = await complete(req);
  assert.equal(second.ok, true);
  assert.equal(second.cacheHit, true);
  assert.deepEqual(second.usage, { requests: 0, inputTokens: 0, outputTokens: 0 });
  assert.equal(second.text, 'scenario list');

  // Two ledger lines (one live, one hit), one billable request.
  assert.equal(readLedger(ws).length, 2);
  assert.equal(requestsSpent(ws), 1);
});

test('a cache hit is returned even when the budget is spent', async (t) => {
  const { ws } = setup(t);
  const req = { useCase: 'S1', prompt: 'ideate', workspace: ws, provider: 'mock', maxRequests: 1 };
  seedFixture(req, { text: 'cached answer' });

  await complete(req);                        // spends the 1 request, writes cache
  const again = await complete(req);          // budget now spent...
  assert.equal(again.ok, true, 'cache is checked before budget');
  assert.equal(again.cacheHit, true);
});

// ── budget ───────────────────────────────────────────────────────────────────

test('budget-exhausted stops a live call without making one', async (t) => {
  const { ws } = setup(t);
  const a = { useCase: 'S1', prompt: 'first', workspace: ws, provider: 'mock', maxRequests: 1 };
  const b = { useCase: 'S1', prompt: 'second', workspace: ws, provider: 'mock', maxRequests: 1 };
  seedFixture(a, { text: 'one' });
  seedFixture(b, { text: 'two' });

  const r1 = await complete(a);
  assert.equal(r1.ok, true);

  const r2 = await complete(b);
  assert.equal(r2.ok, false);
  assert.equal(r2.error, 'budget-exhausted');
  // No ledger line for the blocked call — nothing was attempted.
  assert.equal(readLedger(ws).filter((e) => e.note?.includes('second')).length, 0);
  assert.equal(requestsSpent(ws), 1);
});

// ── engine down ──────────────────────────────────────────────────────────────

test('a missing fixture is engine-unavailable, never a throw', async (t) => {
  const { ws } = setup(t);
  const r = await complete({ useCase: 'S1', prompt: 'no fixture here', workspace: ws, provider: 'mock' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'engine-unavailable');
  assert.match(r.detail, /no fixture/);
  // The failed live call is still ledgered (degraded), so the report can show it.
  const ledger = readLedger(ws);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].degraded, true);
  assert.equal(ledger[0].requests, 1);
});

// ── copilot stub ─────────────────────────────────────────────────────────────

test('the copilot stub degrades cleanly (its P1 contract)', async (t) => {
  const { ws } = setup(t);
  const r = await complete({ useCase: 'S1', prompt: 'x', workspace: ws, provider: 'copilot' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'engine-unavailable');
  assert.match(r.detail, /P1/);
});

// ── unknown provider ─────────────────────────────────────────────────────────

test('an unknown engine is a configuration error, and throws', async (t) => {
  const { ws } = setup(t);
  await assert.rejects(
    () => complete({ useCase: 'S1', prompt: 'x', workspace: ws, provider: 'gpt' }),
    /unknown engine "gpt"/,
  );
});

// ── record → replay ──────────────────────────────────────────────────────────

test('MOCK_RECORD is a no-op on the mock engine (never records its own replay)', async (t) => {
  const { ws } = setup(t);
  const req = { useCase: 'S1', prompt: 'x', workspace: ws, provider: 'mock' };
  seedFixture(req, { text: 'y' });

  process.env.MOCK_RECORD = '1';
  t.after(() => { delete process.env.MOCK_RECORD; });
  const r = await complete(req);
  assert.equal(r.ok, true);   // recording a mock answer as a fixture would be circular
});
