// Live A1 check — OPT-IN (ENGINE_LIVE_TEST=1).
//
// The unit tests inject a fake session: they prove the manifest cascade, resume,
// and validation, but never that a REAL agent session — driving the real
// context-server MCP (C4) over the real store — writes a parse-clean test file
// that runGenerate accepts as `agent`/`generated`. This is p0-06 Acceptance §2
// (generated spec parse-checks, targets only stored surface), the sibling of
// p0-02's session-live and p0-05's create-live.
//
//   ENGINE_LIVE_TEST=1 node --test generation-layer/test-generator/generate-live.test.mjs
//
// runGenerate writes mcp-config.json pointing at the real context-server with
// this workspace, so the live agent reads THIS store — no extra wiring needed.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runGenerate } from './generate.mjs';

const LIVE = process.env.ENGINE_LIVE_TEST === '1';
const MODEL = process.env.ENGINE_LIVE_MODEL || 'claude-haiku-4-5';

function liveStore(runId) {
  return {
    runId, builtAt: '2026-07-20T00:00:00Z', target: { url: 'https://app.example.com', profile: 'url+code' },
    facts: [
      { factId: 'e:get-cart', kind: 'endpoint', key: { method: 'GET', pathTemplate: '/api/v2/cart' },
        confidence: 0.95, provenance: { families: [{ class: 'runtime' }, { class: 'spec' }], corroborationCount: 2 }, attributes: {} },
      { factId: 'p:cart', kind: 'page', key: { pathTemplate: '/cart' }, confidence: 0.9, provenance: {}, attributes: {} },
    ],
    features: [{ featureId: 'feat:checkout', name: 'Checkout', summary: 'view the cart' }],
    gaps: [],
    indexes: {
      factsByKey: { 'GET /api/v2/cart': 'e:get-cart', '/cart': 'p:cart' },
      factsByFeature: { 'feat:checkout': ['e:get-cart', 'p:cart'] },
      gapsByFeature: {}, pagesByFeature: { 'feat:checkout': ['/cart'] },
    },
    stats: { facts: 2, features: 1, gaps: 0, s2Merges: 0, s2Skipped: 0 },
  };
}

function livePlan(runId) {
  return {
    runId, createdAt: '2026-07-20T00:00:00Z', source: 'llm',
    features: [{ featureId: 'feat:checkout', name: 'Checkout', source: 'llm', scenarios: [
      { scenarioId: 'sc-0001', title: 'the cart page loads', kind: 'ui', intent: 'the cart page renders without error',
        mutation: false, targets: { pages: ['/cart'] }, priority: 0.5, gapRefs: [] },
    ] }],
    estimates: { scenarios: 1, llmRequests: 3 },
  };
}

function liveWorkspace(t, runId = 'live-1') {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'c6-live-'));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  fs.mkdirSync(path.join(ws, 'store'), { recursive: true });
  fs.mkdirSync(path.join(ws, 'plan'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'ledger.jsonl'), '');
  fs.writeFileSync(path.join(ws, 'store', 'knowledge.json'), JSON.stringify(liveStore(runId)));
  fs.writeFileSync(path.join(ws, 'plan', 'test-plan.json'), JSON.stringify(livePlan(runId)));
  return ws;
}

test('a real agent session writes a parse-clean test via the live MCP', { skip: !LIVE }, async (t) => {
  const ws = liveWorkspace(t);

  // No sessionFn → the REAL runSession, real `claude` CLI, real context-server MCP.
  const res = await runGenerate({
    workspace: ws, runId: 'live-1',
    engine: { provider: 'claude', model: MODEL, maxRequests: 200 },
    log: (m) => t.diagnostic(m),
  });
  assert.equal(res.ok, true, res.reason);

  const manifest = JSON.parse(fs.readFileSync(path.join(ws, 'tests', 'manifest.json'), 'utf8'));

  // §1: every scenario has exactly one entry.
  assert.equal(manifest.entries.length, 1);
  const e = manifest.entries[0];

  // §2: the live agent produced it (not the template fallback) and it exists.
  assert.equal(e.generator, 'agent', 'expected a live agent file, got the template fallback');
  assert.equal(e.status, 'generated');
  assert.ok(fs.existsSync(path.join(ws, e.file)), `${e.file} should exist`);

  // §2/§4: the file parse-checks — it earned `generated` only by passing node --check.
  const src = fs.readFileSync(path.join(ws, e.file), 'utf8');
  assert.match(src, /scenario:\s*sc-0001/);         // the header convention held
  // the unified execution contract (C7): the file exports run() so the executor
  // can drive it exactly like a template file.
  assert.match(src, /export\s+(async\s+)?function\s+run\b/, 'agent file must export run(ctx)');
  assert.equal(res.stats.generated, 1);

  // an A1 session call was ledgered.
  const ledger = fs.readFileSync(path.join(ws, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(ledger.some((x) => x.useCase === 'A1' && x.requests >= 1), 'expected an A1 ledger entry');
});
