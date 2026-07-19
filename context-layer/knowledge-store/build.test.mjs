// Integration test for buildStore(): a synthetic context/ dir in, a valid,
// indexed store out. Uses the mock engine with no fixtures so S2 degrades
// deterministically (acceptance 2) — the merge logic itself is covered in
// lib/s2.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildStore } from './build.mjs';
import { openStore } from './store.mjs';

function writeContext(ws, { facts, gaps, features }) {
  const c = path.join(ws, 'context');
  for (const [sub, name, arrKey, arr] of [
    ['synthesized', 'facts.json', 'facts', facts],
    ['gaps', 'gaps.json', 'gaps', gaps],
    ['features', 'features.json', 'features', features],
  ]) {
    fs.mkdirSync(path.join(c, sub), { recursive: true });
    fs.writeFileSync(path.join(c, sub, name),
      JSON.stringify({ generatedAt: '2026-07-19T00:00:00Z', target: { baseUrl: 'https://app.example.com' }, [arrKey]: arr }));
  }
}

function setup(t) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'c3-build-'));
  fs.writeFileSync(path.join(ws, 'ledger.jsonl'), '');
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  return ws;
}

const ep = (method, p, extra = {}) => ({
  factId: `endpoint::${method}::same-origin::${p}`, kind: 'endpoint',
  key: { method, originKey: 'same-origin', pathTemplate: p },
  confidence: 0.9, observations: [], provenance: { families: [{ class: 'runtime' }], corroborationCount: 1 },
  ...extra,
});
const page = (p) => ({ factId: `page::${p}`, kind: 'page', key: { pathTemplate: p }, confidence: 0.9, provenance: {} });

// ── happy path (no residue) ──────────────────────────────────────────────────

test('builds a valid, indexed store from a clean context', async (t) => {
  const ws = setup(t);
  const facts = [ep('GET', '/api/v2/cart'), ep('POST', '/api/v2/orders'), page('/cart')];
  writeContext(ws, {
    facts,
    gaps: [{ gapId: 'g1', type: 'untested-endpoint', severity: 'medium', priority: 0.5, subject: { factId: facts[1].factId } }],
    features: [{ featureId: 'feat:checkout', name: 'Checkout',
      members: { endpoints: [facts[0].factId, facts[1].factId], pages: [facts[2].factId] } }],
  });

  const r = await buildStore({ workspace: ws, runId: 'r1', target: { url: 'https://app.example.com', profile: 'url+code' },
    engine: { provider: 'mock', maxRequests: 200 } });
  assert.equal(r.ok, true);
  assert.equal(r.stats.s2Candidates, 0, 'no concrete-vs-template residue here');
  assert.deepEqual(r.degraded, []);

  // The store validates against the §3 shape and its indexes resolve.
  const s = openStore(ws);
  assert.equal(s.store.runId, 'r1');
  assert.equal(s.store.target.url, 'https://app.example.com');
  const ctx = s.featureContext('feat:checkout');
  assert.deepEqual(ctx.pages, ['/cart']);
  assert.deepEqual(ctx.endpoints.map((e) => e.path).sort(), ['/api/v2/cart', '/api/v2/orders']);
  assert.deepEqual(ctx.gaps.map((g) => g.gapId), ['g1']);
});

test('every fact is reachable through at least one index (acceptance 1)', async (t) => {
  const ws = setup(t);
  const facts = [ep('GET', '/api/v2/cart'), page('/cart')];
  writeContext(ws, { facts, gaps: [],
    features: [{ featureId: 'f', name: 'F', members: { endpoints: [facts[0].factId], pages: [facts[1].factId] } }] });

  await buildStore({ workspace: ws, engine: { provider: 'mock', maxRequests: 200 } });
  const { store } = openStore(ws);

  const reachable = new Set([
    ...Object.values(store.indexes.factsByKey),
    ...Object.values(store.indexes.factsByFeature).flat(),
  ]);
  for (const f of store.facts) {
    assert.ok(reachable.has(f.factId), `${f.factId} is orphaned from every index`);
  }
});

// ── S2 degrade path (acceptance 2) ───────────────────────────────────────────

test('with a residue and no engine fixtures, S2 skips but the store still builds', async (t) => {
  const ws = setup(t);
  // A concrete-vs-template pair → one candidate → S2 called → mock has no
  // fixture → engine-unavailable → skipped + degraded, store still produced.
  const concrete = ep('GET', '/agent/get-by-name/Resume');
  const template = ep('GET', '/agent/get-by-name/{id}', { confidence: 0.7 });
  writeContext(ws, {
    facts: [concrete, template],
    gaps: [],
    features: [{ featureId: 'feat:agent', name: 'Agent', members: { endpoints: [concrete.factId, template.factId] } }],
  });

  const r = await buildStore({ workspace: ws, engine: { provider: 'mock', maxRequests: 200 } });
  assert.equal(r.ok, true, 'a degraded S2 must not fail the build');
  assert.equal(r.stats.s2Candidates, 1);
  assert.equal(r.stats.s2Merges, 0);
  assert.ok(r.stats.s2Skipped >= 1);
  assert.equal(r.degraded.length, 1);
  assert.equal(r.degraded[0].useCase, 'S2');

  // Both facts survive and are tagged skipped.
  const { store } = openStore(ws);
  assert.equal(store.facts.length, 2);
  assert.ok(store.facts.every((f) => f.provenance.s2 === 'skipped'));
});

// ── error handling ───────────────────────────────────────────────────────────

test('a missing facts.json fails cleanly, not with a stack trace', async (t) => {
  const ws = setup(t);
  fs.mkdirSync(path.join(ws, 'context'), { recursive: true });   // context exists but empty
  const r = await buildStore({ workspace: ws, engine: { provider: 'mock', maxRequests: 200 } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /required input missing/);
});
