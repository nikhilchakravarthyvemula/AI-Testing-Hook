import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createPlan } from './create.mjs';
import { validatePlan, countMutations } from '../../interfaces/cli/_lib/spine/plan-schema.mjs';
import { renderSummary } from '../../interfaces/cli/_lib/spine/checkpoint.mjs';

// ── a workspace with a store on disk (the shapes C3 actually writes) ──────────

function storeFixture() {
  return {
    runId: 'r1', builtAt: '2026-07-19T00:00:00Z',
    target: { url: 'https://app.example.com', profile: 'url+code' },
    facts: [
      { factId: 'e:get-cart', kind: 'endpoint', key: { method: 'GET', pathTemplate: '/api/v2/cart' },
        confidence: 0.95, provenance: { families: [{ class: 'runtime' }, { class: 'spec' }], corroborationCount: 2 }, attributes: {} },
      { factId: 'e:post-orders', kind: 'endpoint', key: { method: 'POST', pathTemplate: '/api/v2/orders' },
        confidence: 0.6, provenance: { families: [{ class: 'runtime' }], corroborationCount: 1 }, attributes: {} },
      { factId: 'p:cart', kind: 'page', key: { pathTemplate: '/cart' }, confidence: 0.9, provenance: {}, attributes: {} },
      { factId: 'e:health', kind: 'endpoint', key: { method: 'GET', pathTemplate: '/api/v2/health' },
        confidence: 0.5, provenance: { families: [{ class: 'runtime' }], corroborationCount: 1 }, attributes: {} },
    ],
    features: [
      { featureId: 'feat:checkout', name: 'Checkout', summary: 'buy things' },
      { featureId: 'feat:ops', name: 'Ops' },
    ],
    gaps: [
      { gapId: 'g:untested-orders', type: 'untested-endpoint', severity: 'medium', priority: 0.5,
        subject: { factId: 'e:post-orders', kind: 'endpoint', key: { method: 'POST', pathTemplate: '/api/v2/orders' } },
        title: 'Untested endpoint: POST /api/v2/orders', recommendation: 'Generate an API test covering this endpoint.' },
      { gapId: 'g:shadow-cart', type: 'shadow-endpoint', severity: 'high', priority: 0.9,
        subject: { factId: 'e:get-cart', kind: 'endpoint', key: { method: 'GET', pathTemplate: '/api/v2/cart' } },
        title: 'Undocumented endpoint: GET /api/v2/cart', recommendation: 'Confirm this endpoint is intended and covered by a contract test.' },
    ],
    indexes: {
      factsByKey: { 'GET /api/v2/cart': 'e:get-cart', 'POST /api/v2/orders': 'e:post-orders', '/cart': 'p:cart', 'GET /api/v2/health': 'e:health' },
      factsByFeature: { 'feat:checkout': ['e:get-cart', 'e:post-orders', 'p:cart'], 'feat:ops': ['e:health'] },
      gapsByFeature: { 'feat:checkout': ['g:shadow-cart', 'g:untested-orders'] },
      pagesByFeature: { 'feat:checkout': ['/cart'], 'feat:ops': [] },
    },
    stats: { facts: 4, features: 2, gaps: 2, s2Merges: 0, s2Skipped: 0 },
  };
}

function makeWorkspace(t) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'c5-plan-'));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  fs.mkdirSync(path.join(ws, 'store'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'store', 'knowledge.json'), JSON.stringify(storeFixture()));
  return ws;
}

function readPlan(ws) {
  return JSON.parse(fs.readFileSync(path.join(ws, 'plan', 'test-plan.json'), 'utf8'));
}

// An injected S1 that returns real targets for Checkout — plus one hallucinated
// and one duplicate scenario, which assembly must drop — and nothing for Ops.
function llmComplete({ prompt }) {
  if (prompt.includes('Feature: Checkout')) {
    return { ok: true, json: { scenarios: [
      { title: 'cart contents load', intent: 'fetch the cart and assert its shape',
        kind: 'api', targets: { endpoints: ['GET /api/v2/cart'] }, gapRefs: ['g:shadow-cart'], mutationOpinion: false },
      { title: 'place an order', intent: 'submit a new order and assert it is created',
        kind: 'api', targets: { endpoints: ['POST /api/v2/orders'] }, gapRefs: ['g:untested-orders'], mutationOpinion: true },
      { title: 'hits a made-up route', intent: 'exercise an endpoint that does not exist',
        kind: 'api', targets: { endpoints: ['GET /api/v2/nonexistent'] } },                     // hallucinated → dropped
      { title: 'Cart contents load', intent: 'same test again',
        kind: 'api', targets: { endpoints: ['GET /api/v2/cart'] } },                             // duplicate → dropped
    ] } };
  }
  // Ops feature — the model proposes a single read test.
  return { ok: true, json: { scenarios: [
    { title: 'health check', intent: 'GET the health endpoint', kind: 'api',
      targets: { endpoints: ['GET /api/v2/health'] } },
  ] } };
}

// ── acceptance 1, 3, 4 — the LLM path ────────────────────────────────────────

test('LLM path: valid plan, targets resolve, mutations flagged, hallucination + dup dropped', async (t) => {
  const ws = makeWorkspace(t);
  const res = await createPlan({ workspace: ws, runId: 'r1', completeFn: llmComplete, engine: {} });
  assert.equal(res.ok, true);

  const plan = readPlan(ws);

  // (acceptance 1) validates against the shared contract the checkpoint enforces.
  const v = validatePlan(plan, { runId: 'r1' });
  assert.ok(v.valid, `plan should be valid, got: ${JSON.stringify(v.errors)}`);
  assert.equal(plan.source, 'llm');

  const checkout = plan.features.find((f) => f.featureId === 'feat:checkout');
  const ops = plan.features.find((f) => f.featureId === 'feat:ops');

  // hallucinated + duplicate scenarios are gone; two survive for checkout.
  assert.equal(checkout.scenarios.length, 2);
  assert.equal(ops.scenarios.length, 1);
  assert.equal(res.stats.dropped.hallucinated, 1);      // (acceptance 3) counted
  assert.equal(res.stats.dropped.duplicate, 1);

  // every surviving target resolves in the store.
  const store = JSON.parse(fs.readFileSync(path.join(ws, 'store', 'knowledge.json'), 'utf8'));
  for (const sc of plan.features.flatMap((f) => f.scenarios)) {
    for (const ep of sc.targets.endpoints ?? []) assert.ok(store.indexes.factsByKey[ep], `unknown endpoint ${ep}`);
  }

  // (acceptance 1) mutation flags: the POST is a mutation, the GET is not.
  const post = checkout.scenarios.find((s) => (s.targets.endpoints ?? []).includes('POST /api/v2/orders'));
  const get = checkout.scenarios.find((s) => (s.targets.endpoints ?? []).includes('GET /api/v2/cart'));
  assert.equal(post.mutation, true);
  assert.equal(get.mutation, false);

  // scenarios are ranked by gap-derived priority: shadow-cart (0.9) before orders (0.5).
  assert.deepEqual(checkout.scenarios.map((s) => s.title), ['cart contents load', 'place an order']);

  // ids are plan-unique; estimates price S1-spent + A1-to-come (§4).
  const ids = plan.features.flatMap((f) => f.scenarios.map((s) => s.scenarioId));
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(plan.estimates.scenarios, 3);
  assert.equal(plan.estimates.llmRequests, 2 /*features*/ + 3 * 2 /*scenarios×2*/);

  // (acceptance 4) the checkpoint summary renders from a real plan.
  const summary = renderSummary(plan, { mode: 'safe', maxRequests: 200, spent: 2 });
  assert.match(summary, /2 features, 3 scenarios \(2 safe \/ 1 mutation\)/);
  assert.match(summary, /1 mutation scenario will be SKIPPED/);
  assert.equal(countMutations(plan), 1);
});

// ── acceptance 2 — full engine outage → template plan, same shape ─────────────

const outage = () => ({ ok: false, error: 'engine-unavailable', detail: 'no fixture' });

test('template path: full outage produces a valid template plan, source=template', async (t) => {
  const ws = makeWorkspace(t);
  const res = await createPlan({ workspace: ws, runId: 'r1', completeFn: outage, engine: {} });
  assert.equal(res.ok, true);

  const plan = readPlan(ws);
  const v = validatePlan(plan, { runId: 'r1' });
  assert.ok(v.valid, `template plan should be valid, got: ${JSON.stringify(v.errors)}`);

  // every feature fell back ⇒ plan-level source is template (checkpoint discloses).
  assert.equal(plan.source, 'template');
  assert.equal(res.stats.degradedFeatures, 2);
  assert.equal(res.degraded.length, 2);
  assert.ok(res.degraded.every((d) => d.useCase === 'S1' && d.stage === 'plan'));

  // checkout: 1 smoke (page) + 2 endpoint-gap scenarios; ops has no page/gap ⇒ 0.
  const checkout = plan.features.find((f) => f.featureId === 'feat:checkout');
  assert.equal(checkout.source, 'template');
  const titles = checkout.scenarios.map((s) => s.title);
  assert.ok(titles.includes('Smoke: /cart loads'));
  assert.ok(titles.some((t) => t.includes('POST /api/v2/orders')));
  assert.equal(plan.features.find((f) => f.featureId === 'feat:ops').scenarios.length, 0);

  // the templated POST scenario is a mutation; the smoke UI load is not.
  const post = checkout.scenarios.find((s) => (s.targets.endpoints ?? []).includes('POST /api/v2/orders'));
  const smoke = checkout.scenarios.find((s) => (s.targets.pages ?? []).includes('/cart'));
  assert.equal(post.mutation, true);
  assert.equal(smoke.mutation, false);

  // the summary announces template provenance.
  const summary = renderSummary(plan, { mode: 'safe', maxRequests: 200, spent: 0 });
  assert.match(summary, /Source: template/);
});

// ── partial outage stays LLM-sourced ─────────────────────────────────────────

test('partial outage: some features templated, plan source stays llm', async (t) => {
  const ws = makeWorkspace(t);
  const completeFn = ({ prompt }) =>
    prompt.includes('Feature: Checkout') ? llmComplete({ prompt }) : outage();

  const res = await createPlan({ workspace: ws, runId: 'r1', completeFn, engine: {} });
  const plan = readPlan(ws);

  assert.ok(validatePlan(plan, { runId: 'r1' }).valid);
  assert.equal(plan.source, 'llm');                 // not a full outage
  assert.equal(res.stats.degradedFeatures, 1);
  assert.equal(res.degraded.length, 1);
  assert.equal(plan.features.find((f) => f.featureId === 'feat:checkout').source, 'llm');
  assert.equal(plan.features.find((f) => f.featureId === 'feat:ops').source, 'template');
});

// ── no store ─────────────────────────────────────────────────────────────────

test('createPlan fails cleanly when there is no store', async (t) => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'c5-nostore-'));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  const res = await createPlan({ workspace: ws, runId: 'r1', completeFn: llmComplete });
  assert.equal(res.ok, false);
  assert.match(res.reason, /no store at/);
});
