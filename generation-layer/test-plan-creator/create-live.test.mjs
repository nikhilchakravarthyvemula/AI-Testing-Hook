// Live S1 check — OPT-IN (ENGINE_LIVE_TEST=1).
//
// The unit tests (create.test.mjs) inject a fake completeFn: they prove the
// deterministic assembly, but never that a real S1 call round-trips through the
// actual SCENARIOS schema + prompt against a live model. This is the evidence
// behind p0-05 Acceptance §1 ("against the store with a live engine: plan
// validates; every target resolves; mutation flags correct — all POST/PUT/DELETE
// flagged"), the sibling of p0-02's session-live and p0-04's stdio smoke.
//
//   ENGINE_LIVE_TEST=1 node --test generation-layer/test-plan-creator/create-live.test.mjs
//
// Skipped by default so `npm test` stays credential-free and deterministic.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createPlan } from './create.mjs';
import { endpointMethod } from './lib/mutation.mjs';
import { validatePlan } from '../../interfaces/cli/_lib/spine/plan-schema.mjs';
import { readLedger } from '../../infrastructure/model-api-connector/ledger.mjs';

const LIVE = process.env.ENGINE_LIVE_TEST === '1';
const MODEL = process.env.ENGINE_LIVE_MODEL || 'claude-haiku-4-5';
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// A small but REAL store on disk — a read endpoint, a write endpoint, a page,
// and an untested-endpoint gap on the write, so a live S1 has an obvious reason
// to propose a mutating scenario (the case §1's mutation check exists to catch).
function liveStore(runId) {
  return {
    runId, builtAt: '2026-07-20T00:00:00Z',
    target: { url: 'https://app.example.com', profile: 'url+code' },
    facts: [
      { factId: 'e:get-cart', kind: 'endpoint', key: { method: 'GET', pathTemplate: '/api/v2/cart' },
        confidence: 0.95, provenance: { families: [{ class: 'runtime' }, { class: 'spec' }], corroborationCount: 2 }, attributes: {} },
      { factId: 'e:post-orders', kind: 'endpoint', key: { method: 'POST', pathTemplate: '/api/v2/orders' },
        confidence: 0.7, provenance: { families: [{ class: 'runtime' }, { class: 'spec' }], corroborationCount: 2 }, attributes: {} },
      { factId: 'p:cart', kind: 'page', key: { pathTemplate: '/cart' }, confidence: 0.9, provenance: {}, attributes: {} },
    ],
    features: [{ featureId: 'feat:checkout', name: 'Checkout', summary: 'view the cart and place an order' }],
    gaps: [
      { gapId: 'g:untested-orders', type: 'untested-endpoint', severity: 'high', priority: 0.8,
        subject: { factId: 'e:post-orders', kind: 'endpoint', key: { method: 'POST', pathTemplate: '/api/v2/orders' } },
        title: 'Untested endpoint: POST /api/v2/orders', recommendation: 'Generate an API test covering this endpoint.' },
    ],
    indexes: {
      factsByKey: { 'GET /api/v2/cart': 'e:get-cart', 'POST /api/v2/orders': 'e:post-orders', '/cart': 'p:cart' },
      factsByFeature: { 'feat:checkout': ['e:get-cart', 'e:post-orders', 'p:cart'] },
      gapsByFeature: { 'feat:checkout': ['g:untested-orders'] },
      pagesByFeature: { 'feat:checkout': ['/cart'] },
    },
    stats: { facts: 3, features: 1, gaps: 1, s2Merges: 0, s2Skipped: 0 },
  };
}

function liveWorkspace(t) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'c5-live-'));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  fs.mkdirSync(path.join(ws, 'store'), { recursive: true });
  fs.mkdirSync(path.join(ws, 'cache'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'ledger.jsonl'), '');
  fs.writeFileSync(path.join(ws, 'store', 'knowledge.json'), JSON.stringify(liveStore('live-1')));
  return ws;
}

test('a real S1 call round-trips through the schema/prompt into a valid plan', { skip: !LIVE }, async (t) => {
  const ws = liveWorkspace(t);

  // No completeFn → the REAL connector, real `claude` CLI, real schema retry.
  const res = await createPlan({
    workspace: ws, runId: 'live-1',
    engine: { provider: 'claude', model: MODEL, maxRequests: 200 },
    log: (m) => t.diagnostic(m),
  });
  assert.equal(res.ok, true, res.reason);

  const plan = JSON.parse(fs.readFileSync(path.join(ws, 'plan', 'test-plan.json'), 'utf8'));
  const store = JSON.parse(fs.readFileSync(path.join(ws, 'store', 'knowledge.json'), 'utf8'));

  // §1: it's a real LLM plan, not the template fallback.
  assert.equal(plan.source, 'llm', 'expected a live LLM plan, got the template fallback');

  // §1: validates against the shared contract the checkpoint enforces.
  const v = validatePlan(plan, { runId: 'live-1' });
  assert.ok(v.valid, `plan invalid: ${JSON.stringify(v.errors)}`);

  const scenarios = plan.features.flatMap((f) => f.scenarios);
  assert.ok(scenarios.length >= 1, 'a live S1 should propose at least one scenario');

  for (const sc of scenarios) {
    // §1: every target resolves in the store — the hallucination guard held.
    for (const ep of sc.targets.endpoints ?? []) {
      assert.ok(store.indexes.factsByKey[ep], `scenario ${sc.scenarioId} targets unknown endpoint "${ep}"`);
    }
    for (const pg of sc.targets.pages ?? []) {
      assert.ok(store.indexes.factsByKey[pg], `scenario ${sc.scenarioId} targets unknown page "${pg}"`);
    }
    // §1: mutation flag correct on real output — any write-method target ⇒ flagged.
    const writesToApi = (sc.targets.endpoints ?? []).some((ep) => {
      const m = endpointMethod(ep);
      return m === null || !READ_METHODS.has(m);
    });
    if (writesToApi) {
      assert.equal(sc.mutation, true, `scenario ${sc.scenarioId} targets a write endpoint but mutation=false`);
    }
  }

  // A real S1 call was ledgered (cost is auditable), like the C2b live test.
  const s1 = readLedger(ws).find((e) => e.useCase === 'S1' && !e.cacheHit);
  assert.ok(s1 && s1.requests >= 1, 'expected at least one live S1 ledger entry');
  assert.match(String(s1.model ?? ''), /claude/i);
});
