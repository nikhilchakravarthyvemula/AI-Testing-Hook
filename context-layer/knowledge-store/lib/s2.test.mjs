import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveResidue } from './s2.mjs';

// Two facts that form one candidate pair: a concrete observation and its template.
function facts() {
  return [
    { factId: 'concrete', kind: 'endpoint', key: { method: 'GET', pathTemplate: '/agent/get-by-name/Resume' },
      confidence: 0.6, observations: [{ sourceId: 'crawler' }],
      provenance: { families: [{ class: 'runtime' }], corroborationCount: 1 } },
    { factId: 'template', kind: 'endpoint', key: { method: 'GET', pathTemplate: '/agent/get-by-name/{id}' },
      confidence: 0.7, observations: [{ sourceId: 'openapi' }],
      provenance: { families: [{ class: 'spec' }], corroborationCount: 1 } },
  ];
}
const pairOf = (fs) => [{ concrete: fs[0], template: fs[1] }];
const engine = { workspace: '/tmp/x', provider: 'mock', maxRequests: 200 };

// An injected complete() that answers a fixed verdict, and counts its calls.
function stubComplete(verdict) {
  let calls = 0;
  const fn = async () => { calls += 1; return verdict; };
  fn.calls = () => calls;
  return fn;
}

test('a confident match merges concrete into template and corroborates it', async () => {
  const fs = facts();
  const r = await resolveResidue({
    facts: fs, pairs: pairOf(fs), engine,
    completeFn: stubComplete({ ok: true, json: { same: true, confidence: 0.95 } }),
  });

  assert.equal(r.merges, 1);
  assert.deepEqual(r.remap, { concrete: 'template' });
  assert.equal(r.facts.length, 1, 'the concrete fact is gone; the template survives');
  const survivor = r.facts[0];
  assert.equal(survivor.factId, 'template');
  // noisy-OR of 0.7 and 0.6 = 1 - 0.3*0.4 = 0.88
  assert.ok(Math.abs(survivor.confidence - 0.88) < 1e-9);
  assert.equal(survivor.provenance.corroborationCount, 2);
  assert.equal(survivor.observations.length, 2, 'both observations retained (explainability)');
  assert.deepEqual(survivor.provenance.s2.merged, ['concrete']);
});

test('same:false keeps both facts, and is NOT counted as a skip', async () => {
  const fs = facts();
  const r = await resolveResidue({
    facts: fs, pairs: pairOf(fs), engine,
    completeFn: stubComplete({ ok: true, json: { same: false, confidence: 0.9 } }),
  });
  assert.equal(r.merges, 0);
  assert.equal(r.skipped, 0);
  assert.equal(r.facts.length, 2);
  assert.deepEqual(r.remap, {});
});

test('a confident-but-wrong-direction low confidence does not merge', async () => {
  const fs = facts();
  const r = await resolveResidue({
    facts: fs, pairs: pairOf(fs), engine,
    completeFn: stubComplete({ ok: true, json: { same: true, confidence: 0.4 } }),  // below 0.7
  });
  assert.equal(r.merges, 0);
  assert.equal(r.facts.length, 2);
});

test('engine down → pairs stay unmerged, facts tagged skipped, one degradation', async () => {
  const fs = facts();
  const r = await resolveResidue({
    facts: fs, pairs: pairOf(fs), engine,
    completeFn: stubComplete({ ok: false, error: 'engine-unavailable', detail: 'no fixture' }),
  });
  assert.equal(r.merges, 0);
  assert.equal(r.skipped, 1);
  assert.equal(r.facts.length, 2, 'nothing merged when the engine is down');
  assert.equal(r.facts[0].provenance.s2, 'skipped');
  assert.equal(r.facts[1].provenance.s2, 'skipped');
  assert.equal(r.degraded.length, 1);
  assert.equal(r.degraded[0].useCase, 'S2');
  assert.equal(r.degraded[0].stage, 'store');
});

test('the volume cap bounds engine calls and reports what was dropped', async () => {
  // 60 candidate pairs, cap is 50 → 50 evaluated, 10 dropped, and a note says so.
  const many = [];
  const pairs = [];
  for (let i = 0; i < 60; i++) {
    const c = { factId: `c${i}`, kind: 'endpoint', key: { method: 'GET', pathTemplate: `/x/v${i}` },
      confidence: 0.5, observations: [], provenance: { corroborationCount: 1 } };
    const t = { factId: `t${i}`, kind: 'endpoint', key: { method: 'GET', pathTemplate: `/x/{id}${i}` },
      confidence: 0.5, observations: [], provenance: { corroborationCount: 1 } };
    many.push(c, t);
    pairs.push({ concrete: c, template: t });
  }
  const stub = stubComplete({ ok: true, json: { same: false, confidence: 0.9 } });
  const r = await resolveResidue({ facts: many, pairs, engine, completeFn: stub });

  assert.equal(stub.calls(), 50, 'never calls the engine more than the cap');
  assert.match(r.note, /60 pairs exceeded cap 50.*10 not evaluated/);
});
