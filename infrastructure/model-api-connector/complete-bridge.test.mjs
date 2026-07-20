// The S4 bridge (bin/complete.mjs) — the Python→Node single-shot path (OQ-5).
//
// Proves the bridge is a faithful CLI face of complete(): a subprocess call
// draws from the same cache, writes the same ledger line, and reports engine
// outages as structured results (not crashes). The last test crosses the actual
// language boundary — python3 → s4_bridge.py → node bin/complete.mjs — which is
// the whole point of the bridge existing.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { cacheKeyFor } from './cache.mjs';
import { fixtureFile } from './providers/mock.mjs';
import { readLedger } from './ledger.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BRIDGE = path.join(__dirname, 'bin', 'complete.mjs');
const GRAPHIFY_DIR = path.join(REPO_ROOT, 'context-layer', 'content-extractor', 'graphify');

const SCHEMA = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false };
const PROMPT = 'Summarise the checkout module in one phrase.';
const ANSWER = { summary: 'a checkout module' };

// A workspace with the bits complete() writes into.
function makeWorkspace(t) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 's4-ws-'));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  fs.mkdirSync(path.join(ws, 'cache'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'ledger.jsonl'), '');
  return ws;
}

// A shared mock-fixtures dir; optionally seed the S4 answer keyed by the same
// content hash complete() will compute.
function makeFixtures(t, { seed = true } = {}) {
  const fx = fs.mkdtempSync(path.join(os.tmpdir(), 's4-fx-'));
  t.after(() => fs.rmSync(fx, { recursive: true, force: true }));
  if (seed) {
    const key = cacheKeyFor({ useCase: 'S4', system: undefined, prompt: PROMPT, schema: SCHEMA });
    const prev = process.env.MOCK_FIXTURES_DIR;
    process.env.MOCK_FIXTURES_DIR = fx;                 // so fixtureFile resolves here
    const file = fixtureFile('S4', key);
    if (prev === undefined) delete process.env.MOCK_FIXTURES_DIR; else process.env.MOCK_FIXTURES_DIR = prev;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ text: JSON.stringify(ANSWER), model: 'mock', usage: { inputTokens: 5, outputTokens: 3 } }));
  }
  return fx;
}

function callBridge(payload, { fx, env = {} } = {}) {
  const r = spawnSync(process.execPath, [BRIDGE], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, MOCK_FIXTURES_DIR: fx ?? '', ...env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr, json: parseLast(r.stdout) };
}

function parseLast(s) {
  const line = String(s).trim().split('\n').filter(Boolean).pop();
  try { return JSON.parse(line); } catch { return null; }
}

// A schema call routed through the connector's cache + ledger + budget.
const req = (ws) => ({ useCase: 'S4', prompt: PROMPT, workspace: ws, schema: SCHEMA, provider: 'mock', maxRequests: 100 });

// ── happy path + cache ────────────────────────────────────────────────────────

test('bridge returns the engine JSON and writes one ledger line', (t) => {
  const ws = makeWorkspace(t);
  const fx = makeFixtures(t);

  const r = callBridge(req(ws), { fx });
  assert.equal(r.code, 0);
  assert.equal(r.json.ok, true, JSON.stringify(r.json));
  assert.deepEqual(r.json.json, ANSWER);
  assert.equal(r.json.cacheHit, false);

  const ledger = readLedger(ws);
  assert.equal(ledger.filter((l) => l.useCase === 'S4').length, 1);
});

test('a second identical bridge call is a cache hit (no new engine request)', (t) => {
  const ws = makeWorkspace(t);
  const fx = makeFixtures(t);

  callBridge(req(ws), { fx });
  const second = callBridge(req(ws), { fx });
  assert.equal(second.json.ok, true);
  assert.equal(second.json.cacheHit, true);
  assert.equal(second.json.usage.requests, 0);
});

// ── engine outage is a RESULT, not a crash (exit 0, ok:false) ─────────────────

test('no fixture → structured engine-unavailable, exit 0, degraded ledger line', (t) => {
  const ws = makeWorkspace(t);
  const fx = makeFixtures(t, { seed: false });

  const r = callBridge(req(ws), { fx });
  assert.equal(r.code, 0);                              // the bridge worked…
  assert.equal(r.json.ok, false);                       // …the engine did not
  assert.equal(r.json.error, 'engine-unavailable');
  assert.ok(readLedger(ws).some((l) => l.useCase === 'S4' && l.degraded));
});

// ── budget ────────────────────────────────────────────────────────────────────

test('budget exhausted returns budget-exhausted without an engine call', (t) => {
  const ws = makeWorkspace(t);
  const fx = makeFixtures(t);
  // Pre-spend the budget: one prior request in the ledger, cap of 1.
  fs.appendFileSync(path.join(ws, 'ledger.jsonl'),
    JSON.stringify({ useCase: 'X', caller: 'connector', requests: 1 }) + '\n');

  const r = callBridge({ ...req(ws), maxRequests: 1 }, { fx });
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error, 'budget-exhausted');
});

// ── malformed invocation is a caller bug → exit 2 ─────────────────────────────

test('malformed JSON on stdin → exit 2, bad-request', () => {
  const r = spawnSync(process.execPath, [BRIDGE], { input: 'not json{', encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.equal(parseLast(r.stdout).error, 'bad-request');
});

test('missing required field → exit 2, bad-request', (t) => {
  const ws = makeWorkspace(t);
  const r = callBridge({ useCase: 'S4', workspace: ws /* no prompt */ });
  assert.equal(r.code, 2);
  assert.match(r.json.detail, /prompt/);
});

// ── the crossing that matters: python3 → s4_bridge.py → node bridge ───────────

test('python client drives the bridge end-to-end (cross-language round-trip)', (t) => {
  const ws = makeWorkspace(t);
  const fx = makeFixtures(t);

  const driver = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 's4-py-')), 'driver.py');
  t.after(() => fs.rmSync(path.dirname(driver), { recursive: true, force: true }));
  fs.writeFileSync(driver, `
import sys, json, os
sys.path.insert(0, ${JSON.stringify(GRAPHIFY_DIR)})
from s4_bridge import s4_complete, BridgeError
res = s4_complete(
    prompt=${JSON.stringify(PROMPT)},
    workspace=${JSON.stringify(ws)},
    schema=json.loads(${JSON.stringify(JSON.stringify(SCHEMA))}),
    provider="mock",
    max_requests=100,
)
print(json.dumps(res))
`);

  const r = spawnSync('python3', [driver], {
    encoding: 'utf8',
    env: { ...process.env, MOCK_FIXTURES_DIR: fx, NODE_BIN: process.execPath },
  });
  assert.equal(r.status, 0, `python driver failed: ${r.stderr}`);
  const res = parseLast(r.stdout);
  assert.equal(res.ok, true, r.stdout);
  assert.deepEqual(res.json, ANSWER);
  // the call went through the connector: it's on the ledger.
  assert.ok(readLedger(ws).some((l) => l.useCase === 'S4'));
});
