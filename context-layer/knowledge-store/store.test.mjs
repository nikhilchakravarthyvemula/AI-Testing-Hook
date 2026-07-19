import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  load, openStore, featureContext, queryEndpoints, listGaps, getFeature, listFeatures,
} from './store.mjs';

// A hand-built store fixture with the shapes C3 actually produces.
function fixtureStore() {
  return {
    runId: 'r1', builtAt: '2026-07-19T00:00:00Z',
    target: { url: 'https://app.example.com', profile: 'url+code' },
    facts: [
      { factId: 'e:get-cart', kind: 'endpoint', key: { method: 'GET', pathTemplate: '/api/v2/cart' },
        confidence: 0.95, provenance: { families: [{ class: 'runtime' }, { class: 'spec' }], corroborationCount: 2 }, attributes: {} },
      { factId: 'e:post-orders', kind: 'endpoint', key: { method: 'POST', pathTemplate: '/api/v2/orders' },
        confidence: 0.6, provenance: { families: [{ class: 'runtime' }], corroborationCount: 1 }, attributes: {} },
      { factId: 'p:cart', kind: 'page', key: { pathTemplate: '/cart' }, confidence: 0.9, provenance: {}, attributes: {} },
      { factId: 'e:other', kind: 'endpoint', key: { method: 'GET', pathTemplate: '/api/v2/health' },
        confidence: 0.5, provenance: { families: [{ class: 'runtime' }], corroborationCount: 1 }, attributes: {} },
    ],
    features: [
      { featureId: 'feat:checkout', name: 'Checkout', summary: 'buy things' },
      { featureId: 'feat:ops', name: 'Ops' },
    ],
    gaps: [
      { gapId: 'g:untested-orders', type: 'untested-endpoint', severity: 'medium', priority: 0.5,
        subject: { factId: 'e:post-orders' } },
      { gapId: 'g:shadow-cart', type: 'shadow-endpoint', severity: 'high', priority: 0.9,
        subject: { factId: 'e:get-cart' } },
    ],
    indexes: {
      factsByKey: { 'GET /api/v2/cart': 'e:get-cart', 'POST /api/v2/orders': 'e:post-orders', '/cart': 'p:cart', 'GET /api/v2/health': 'e:other' },
      factsByFeature: { 'feat:checkout': ['e:get-cart', 'e:post-orders', 'p:cart'], 'feat:ops': ['e:other'] },
      gapsByFeature: { 'feat:checkout': ['g:untested-orders', 'g:shadow-cart'] },
      pagesByFeature: { 'feat:checkout': ['/cart'], 'feat:ops': [] },
    },
    stats: { facts: 4, features: 2, gaps: 2, s2Merges: 0, s2Skipped: 0 },
  };
}

// ── featureContext (the shared composite) ────────────────────────────────────

test('featureContext returns endpoints (confidence-ranked, provenance-tagged), pages, gaps', () => {
  const s = fixtureStore();
  const ctx = featureContext(s, 'feat:checkout');

  assert.equal(ctx.feature.name, 'Checkout');
  // endpoints ranked by confidence desc: get-cart (0.95) before post-orders (0.6)
  assert.deepEqual(ctx.endpoints.map((e) => e.factId), ['e:get-cart', 'e:post-orders']);
  assert.deepEqual(ctx.endpoints[0].provenance.families, ['runtime', 'spec']);
  assert.equal(ctx.endpoints[0].provenance.corroborationCount, 2);
  // pages come through as paths, not factIds
  assert.deepEqual(ctx.pages, ['/cart']);
  // gaps ranked by priority desc: shadow-cart (0.9) before untested-orders (0.5)
  assert.deepEqual(ctx.gaps.map((g) => g.gapId), ['g:shadow-cart', 'g:untested-orders']);
});

test('featureContext resolves a feature by NAME too, case-insensitively', () => {
  const s = fixtureStore();
  assert.equal(featureContext(s, 'checkout').feature.featureId, 'feat:checkout');
  assert.equal(featureContext(s, 'CHECKOUT').feature.featureId, 'feat:checkout');
});

test('featureContext of an unknown feature is null (caller distinguishes)', () => {
  assert.equal(featureContext(fixtureStore(), 'feat:nope'), null);
});

// ── queryEndpoints ───────────────────────────────────────────────────────────

test('queryEndpoints filters by method, path, feature, confidence', () => {
  const s = fixtureStore();
  assert.deepEqual(queryEndpoints(s, { method: 'get' }).map((e) => e.factId).sort(), ['e:get-cart', 'e:other']);
  assert.deepEqual(queryEndpoints(s, { pathContains: 'orders' }).map((e) => e.factId), ['e:post-orders']);
  assert.deepEqual(queryEndpoints(s, { featureId: 'feat:checkout', method: 'POST' }).map((e) => e.factId), ['e:post-orders']);
  assert.deepEqual(queryEndpoints(s, { minConfidence: 0.9 }).map((e) => e.factId), ['e:get-cart']);
});

test('queryEndpoints never returns non-endpoint facts', () => {
  const s = fixtureStore();
  assert.ok(queryEndpoints(s, {}).every((e) => e.method));   // pages have no method
  assert.equal(queryEndpoints(s, {}).some((e) => e.factId === 'p:cart'), false);
});

// ── listGaps ─────────────────────────────────────────────────────────────────

test('listGaps filters by feature and severity, ranked by priority', () => {
  const s = fixtureStore();
  assert.deepEqual(listGaps(s, {}).map((g) => g.gapId), ['g:shadow-cart', 'g:untested-orders']);
  assert.deepEqual(listGaps(s, { severity: 'high' }).map((g) => g.gapId), ['g:shadow-cart']);
  assert.deepEqual(listGaps(s, { featureId: 'feat:checkout', severity: 'medium' }).map((g) => g.gapId), ['g:untested-orders']);
  assert.deepEqual(listGaps(s, { featureId: 'feat:ops' }), []);
});

// ── listFeatures / getFeature ────────────────────────────────────────────────

test('listFeatures reports per-feature counts', () => {
  const rows = listFeatures(fixtureStore());
  const checkout = rows.find((r) => r.featureId === 'feat:checkout');
  assert.equal(checkout.endpointCount, 2);
  assert.equal(checkout.pageCount, 1);
  assert.equal(checkout.gapCount, 2);
});

test('getFeature returns null for unknown', () => {
  assert.equal(getFeature(fixtureStore(), 'nope'), null);
});

// ── openStore round-trip ─────────────────────────────────────────────────────

test('openStore loads from disk and binds accessors that match the pure ones', (t) => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'c3-store-'));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  fs.mkdirSync(path.join(ws, 'store'), { recursive: true });
  const s = fixtureStore();
  fs.writeFileSync(path.join(ws, 'store', 'knowledge.json'), JSON.stringify(s));

  const opened = openStore(ws);
  // Proves the C4 MCP tool and a direct store.mjs call return identical data
  // (acceptance 3): the bound accessor and the pure function agree.
  assert.deepEqual(opened.featureContext('feat:checkout'), featureContext(load(ws), 'feat:checkout'));
  assert.equal(opened.listFeatures().length, 2);
});

test('load throws a clear error when there is no store yet', (t) => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'c3-nostore-'));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  assert.throws(() => load(ws), /no store at/);
});
