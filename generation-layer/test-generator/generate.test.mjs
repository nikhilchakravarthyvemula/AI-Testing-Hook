import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runGenerate } from './generate.mjs';

// ── a workspace with an approved plan on disk ────────────────────────────────

function planFixture(runId = 'r1') {
  return {
    runId, createdAt: '2026-07-20T00:00:00Z', source: 'llm',
    features: [
      { featureId: 'feat:checkout', name: 'Checkout', source: 'llm', scenarios: [
        { scenarioId: 'sc-0001', title: 'cart loads', kind: 'api', intent: 'GET the cart', mutation: false, targets: { endpoints: ['GET /api/v2/cart'] }, priority: 0.9, gapRefs: [] },
        { scenarioId: 'sc-0002', title: 'place order', kind: 'api', intent: 'POST an order', mutation: true, targets: { endpoints: ['POST /api/v2/orders'] }, priority: 0.5, gapRefs: [] },
      ] },
      { featureId: 'feat:ops', name: 'Ops', source: 'llm', scenarios: [
        { scenarioId: 'sc-0003', title: 'health', kind: 'api', intent: 'GET health', mutation: false, targets: { endpoints: ['GET /api/v2/health'] }, priority: 0, gapRefs: [] },
      ] },
    ],
    estimates: { scenarios: 3, llmRequests: 8 },
  };
}

function makeWorkspace(t, plan = planFixture()) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'c6-gen-'));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  fs.mkdirSync(path.join(ws, 'plan'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'plan', 'test-plan.json'), JSON.stringify(plan));
  return ws;
}

function readManifest(ws) {
  return JSON.parse(fs.readFileSync(path.join(ws, 'tests', 'manifest.json'), 'utf8'));
}

// A stand-in for runSession: writes files into tests/<featureId>/ exactly where
// the real session provider would, and returns filesWritten — so the honesty
// diff, parse gate, and manifest derivation behave identically to production.
function sessionWriting({ failFeatures = new Set(), fileKind = () => 'valid' } = {}) {
  return ({ workspace, slice }) => {
    if (failFeatures.has(slice.featureId)) {
      return { ok: false, error: 'engine-unavailable', detail: 'no session fixture' };
    }
    const filesWritten = [];
    for (const sc of slice.scenarios) {
      const kind = fileKind(sc.scenarioId);
      if (kind === 'missing') continue;
      const rel = path.join('tests', slice.featureId, `${sc.scenarioId}.spec.mjs`);
      const abs = path.join(workspace, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, kind === 'broken'
        ? 'export const x = ;;; this will not parse ('
        : `// agent\nexport const scenario = { id: '${sc.scenarioId}' };\nexport async function run() { return { ok: true }; }\n`);
      filesWritten.push(rel);
    }
    return { ok: true, filesWritten };
  };
}

/** Write one agent-style file, returning its workspace-relative path. */
function writeAgentFile(ws, featureId, scenarioId) {
  const rel = path.join('tests', featureId, `${scenarioId}.spec.mjs`);
  const abs = path.join(ws, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `// agent\nexport async function run() { return { ok: true }; }\n`);
  return rel;
}

/**
 * A session that fails its first `failures` attempts per feature — optionally
 * after finishing some scenarios' files, the way a timeout kills a session
 * mid-run — then succeeds.
 *
 * Mirrors production's honesty diff: an attempt only reports files that did NOT
 * already exist when it started, so a retry never re-reports what the previous
 * attempt wrote. That's what makes the accumulate-across-attempts logic testable.
 */
function flakySession({ failures = 1, error = 'engine-unavailable', partialOn = () => false } = {}) {
  const calls = [];
  const fn = ({ workspace, slice }) => {
    const nth = calls.filter((f) => f === slice.featureId).length + 1;
    calls.push(slice.featureId);

    const fresh = [];
    const emit = (scenarioId) => {
      const rel = path.join('tests', slice.featureId, `${scenarioId}.spec.mjs`);
      const existed = fs.existsSync(path.join(workspace, rel));
      writeAgentFile(workspace, slice.featureId, scenarioId);
      if (!existed) fresh.push(rel);
    };

    if (nth <= failures) {
      for (const sc of slice.scenarios) if (partialOn(sc.scenarioId)) emit(sc.scenarioId);
      return { ok: false, error, detail: 'simulated transient failure', filesWritten: fresh };
    }
    for (const sc of slice.scenarios) emit(sc.scenarioId);
    return { ok: true, filesWritten: fresh };
  };
  fn.calls = calls;
  return fn;
}

const allScenarioIds = (plan) => plan.features.flatMap((f) => f.scenarios.map((s) => s.scenarioId));

// Every scenario in the plan must have EXACTLY one manifest entry (§1 honesty).
function assertComplete(manifest, plan) {
  const ids = manifest.entries.map((e) => e.scenarioId).sort();
  assert.deepEqual(ids, allScenarioIds(plan).sort());
  assert.equal(new Set(ids).size, ids.length, 'no duplicate manifest entries');
}

// ── happy path — every scenario generated by the agent ───────────────────────

test('all-agent: complete manifest, files on disk, no degradation', async (t) => {
  const ws = makeWorkspace(t);
  const res = await runGenerate({ workspace: ws, runId: 'r1', sessionFn: sessionWriting(), engine: {} });
  assert.equal(res.ok, true);
  assert.equal(res.degraded.length, 0);

  const m = readManifest(ws);
  assertComplete(m, planFixture());
  assert.ok(m.entries.every((e) => e.generator === 'agent' && e.status === 'generated'));
  // the files the manifest names really exist, under the raw (colon) featureId.
  for (const e of m.entries) assert.ok(fs.existsSync(path.join(ws, e.file)), `${e.file} exists`);
  // mcp-config + slice files were written.
  assert.ok(fs.existsSync(path.join(ws, 'mcp-config.json')));
  assert.ok(fs.existsSync(path.join(ws, 'plan', 'slices', 'feat-checkout.json')));
  assert.equal(res.stats.generated, 3);
});

// ── acceptance 1 — a failed slice falls back to templates, stage still ok ─────

test('failed slice → template fallback, complete manifest, degradation recorded', async (t) => {
  const ws = makeWorkspace(t);
  const res = await runGenerate({
    workspace: ws, runId: 'r1', engine: {},
    sessionFn: sessionWriting({ failFeatures: new Set(['feat:ops']) }),
  });
  assert.equal(res.ok, true);
  assertComplete(readManifest(ws), planFixture());

  const m = readManifest(ws);
  const ops = m.entries.filter((e) => e.featureId === 'feat:ops');
  assert.ok(ops.every((e) => e.generator === 'template' && e.status === 'generated'));
  // the checkout slice still came from the agent.
  assert.ok(m.entries.filter((e) => e.featureId === 'feat:checkout').every((e) => e.generator === 'agent'));

  assert.equal(res.degraded.length, 1);
  assert.equal(res.degraded[0].useCase, 'A1');
  assert.equal(res.degraded[0].stage, 'generate');
  // the templated file exists and parse-checks (it was written + gated).
  assert.ok(fs.existsSync(path.join(ws, ops[0].file)));
});

// ── partial: session ok but skips one scenario's file → that one templates ────

test('session leaves one scenario ungenerated → template just that scenario', async (t) => {
  const ws = makeWorkspace(t);
  const res = await runGenerate({
    workspace: ws, runId: 'r1', engine: {},
    sessionFn: sessionWriting({ fileKind: (id) => (id === 'sc-0002' ? 'missing' : 'valid') }),
  });
  assert.equal(res.ok, true);
  const m = readManifest(ws);
  assertComplete(m, planFixture());
  assert.equal(entryFor(m, 'sc-0001').generator, 'agent');
  assert.equal(entryFor(m, 'sc-0002').generator, 'template');   // the skipped one
  assert.equal(entryFor(m, 'sc-0003').generator, 'agent');
  assert.equal(res.degraded.length, 1);                          // one partial slice
});

// ── §4 validation: an unparseable agent file is rejected, then templated ──────

test('unparseable agent file → moved to _rejected, scenario templated', async (t) => {
  const ws = makeWorkspace(t);
  const res = await runGenerate({
    workspace: ws, runId: 'r1', engine: {},
    sessionFn: sessionWriting({ fileKind: (id) => (id === 'sc-0001' ? 'broken' : 'valid') }),
  });
  assert.equal(res.ok, true);
  const m = readManifest(ws);
  assertComplete(m, planFixture());

  const sc1 = entryFor(m, 'sc-0001');
  assert.equal(sc1.generator, 'template');                       // fell back
  assert.equal(sc1.status, 'generated');
  // the broken original was moved out of the executor's path.
  assert.ok(fs.existsSync(path.join(ws, 'tests', '_rejected', 'feat:checkout', 'sc-0001.spec.mjs')));
  assert.ok(res.degraded.length >= 1);
});

// ── retry: a transient engine failure gets one more attempt ──────────────────

test('a transient session failure is retried once, and the retry\'s work is used', async (t) => {
  const ws = makeWorkspace(t);
  const session = flakySession();                       // fails once per feature, then succeeds
  const res = await runGenerate({ workspace: ws, runId: 'r1', engine: {}, sessionFn: session });

  assert.equal(res.ok, true);
  assert.equal(session.calls.length, 4, '2 features × (1 failure + 1 retry)');
  assert.equal(res.stats.sessionRetries, 2);

  const m = readManifest(ws);
  assertComplete(m, planFixture());
  assert.ok(m.entries.every((e) => e.generator === 'agent'), 'the retry succeeded — nothing templated');
  // A slice that RECOVERED is not a degradation: the output is fully agent-made.
  // The failed attempt is still auditable — the connector ledgers it.
  assert.equal(res.degraded.length, 0);
});

test('partial work from a session that never recovers is kept, not templated over', async (t) => {
  const ws = makeWorkspace(t);
  // sc-0001's file is finished before the session dies; it never recovers, so
  // the retry also fails — and re-reports nothing, since the file now exists.
  const session = flakySession({ failures: 99, partialOn: (id) => id === 'sc-0001' });
  const res = await runGenerate({ workspace: ws, runId: 'r1', engine: {}, sessionFn: session });

  assert.equal(res.ok, true);
  const m = readManifest(ws);
  assertComplete(m, planFixture());

  // the one file the dying session actually finished survives as agent work…
  assert.equal(entryFor(m, 'sc-0001').generator, 'agent');
  // …and only the scenarios with no file of their own fall back.
  assert.equal(entryFor(m, 'sc-0002').generator, 'template');
  assert.equal(entryFor(m, 'sc-0003').generator, 'template');

  // the degradation reports what SURVIVED, not "the whole slice fell back".
  const checkout = res.degraded.find((d) => d.reason.includes('Checkout'));
  assert.match(checkout.reason, /after 2 attempts/);
  assert.match(checkout.fallback, /1 scenario\(s\) kept/);
});

test('budget-exhausted is never retried — the budget does not grow back', async (t) => {
  const ws = makeWorkspace(t);
  const session = flakySession({ failures: 99, error: 'budget-exhausted' });
  const res = await runGenerate({ workspace: ws, runId: 'r1', engine: {}, sessionFn: session });

  assert.equal(res.ok, true);
  assert.equal(session.calls.length, 2, 'one attempt per feature, no retry');
  assert.equal(res.stats.sessionRetries, 0);
  assert.ok(readManifest(ws).entries.every((e) => e.generator === 'template'));
});

// ── acceptance 3 — resume regenerates only incomplete slices ──────────────────

test('resume: complete slices are skipped, incomplete ones regenerated', async (t) => {
  const ws = makeWorkspace(t);

  // First pass: everything generated.
  await runGenerate({ workspace: ws, runId: 'r1', sessionFn: sessionWriting(), engine: {} });

  // Simulate a kill BEFORE feat:ops finished: drop its manifest entries + file.
  const m1 = readManifest(ws);
  const trimmed = { ...m1, entries: m1.entries.filter((e) => e.featureId !== 'feat:ops') };
  fs.writeFileSync(path.join(ws, 'tests', 'manifest.json'), JSON.stringify(trimmed));
  fs.rmSync(path.join(ws, 'tests', 'feat:ops'), { recursive: true, force: true });

  // Second pass: checkout is unchanged (resumed); ops is regenerated. Spy on
  // which slices actually hit the session.
  const touched = [];
  const spy = (args) => { touched.push(args.slice.featureId); return sessionWriting()(args); };
  const res = await runGenerate({ workspace: ws, runId: 'r1', sessionFn: spy, engine: {} });

  assert.equal(res.stats.slicesResumed, 1);
  assert.deepEqual(touched, ['feat:ops']);          // only the incomplete slice ran
  assertComplete(readManifest(ws), planFixture());
});

// ── no plan ───────────────────────────────────────────────────────────────────

test('runGenerate fails cleanly when there is no approved plan', async (t) => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'c6-noplan-'));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  const res = await runGenerate({ workspace: ws, runId: 'r1', sessionFn: sessionWriting() });
  assert.equal(res.ok, false);
  assert.match(res.reason, /no approved plan/);
});

function entryFor(manifest, scenarioId) {
  return manifest.entries.find((e) => e.scenarioId === scenarioId);
}
