// Tests for the two pieces of `stages.mjs` that carry real weight:
//
//  - assertFreshAcquisition: the guard that lets the context layer keep writing
//    to the shared output/ dir without a run ever reporting on a PREVIOUS run's
//    observations. It stands in for per-run output isolation, so it has to hold.
//  - snapshotContext: what makes the workspace an immutable record of this run.
//
// The stage runner itself is exercised end-to-end via `testo run --dry-run`.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createWorkspace, readRun, updateRun, hashFile } from './workspace.mjs';
import { assertFreshAcquisition, snapshotContext, STAGES } from './stages.mjs';

// ── harness ────────────────────────────────────────────────────────────────

function setup(t) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-stages-'));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  const ws = createWorkspace({
    repoRoot, url: 'https://app.example.com', codebasePath: null,
    mode: 'safe', budget: 200, engine: 'mock',
  });

  const lines = [];
  const ctx = {
    repoRoot, dir: ws.dir, paths: ws.paths, run: ws.run,
    opts: { dryRun: false },
    io: { out: (m) => lines.push(String(m)) },
  };
  return { ctx, lines, repoRoot };
}

/** Write output/content-extraction-index.json the way content-extractor does. */
function writeIndex(repoRoot, { generatedAt = new Date().toISOString(), sources = [] } = {}) {
  const p = path.join(repoRoot, 'output', 'content-extraction-index.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ generatedAt, sources, outputDir: 'output/sources/' }, null, 2));
  return p;
}

const okCrawler = { id: 'crawler', kind: 'primary', ok: true, durationMs: 1200 };

// ── freshness ──────────────────────────────────────────────────────────────

test('a fresh acquisition with a working crawler passes', (t) => {
  const { ctx, repoRoot } = setup(t);
  const startedAt = Date.now();
  writeIndex(repoRoot, { sources: [okCrawler, { id: 'python-fastapi', ok: true }] });

  assert.deepEqual(assertFreshAcquisition(ctx, startedAt), { ok: true });
  assert.deepEqual(readRun(ctx.dir).degraded, []);
});

test('a STALE index aborts the run — the core guarantee', (t) => {
  // This is the failure the project already hit once: a component leaves last
  // run's artifacts in output/, and we index them as if they were fresh. A
  // report built on them would describe an app this run never observed.
  const { ctx, repoRoot } = setup(t);
  writeIndex(repoRoot, {
    generatedAt: '2026-07-01T00:00:00.000Z',       // a previous run
    sources: [okCrawler],
  });

  const r = assertFreshAcquisition(ctx, Date.now());
  assert.equal(r.ok, false);
  assert.match(r.reason, /stale/);
  assert.match(r.reason, /previous run/);
});

test('a missing index aborts', (t) => {
  const { ctx } = setup(t);
  const r = assertFreshAcquisition(ctx, Date.now());
  assert.equal(r.ok, false);
  assert.match(r.reason, /no extraction index/);
});

test('an unparseable index aborts rather than throwing', (t) => {
  const { ctx, repoRoot } = setup(t);
  const p = path.join(repoRoot, 'output', 'content-extraction-index.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '{ truncated');

  const r = assertFreshAcquisition(ctx, Date.now());
  assert.equal(r.ok, false);
  assert.match(r.reason, /unreadable/);
});

test('an index with no usable generatedAt aborts', (t) => {
  const { ctx, repoRoot } = setup(t);
  writeIndex(repoRoot, { generatedAt: 'whenever', sources: [okCrawler] });
  const r = assertFreshAcquisition(ctx, Date.now());
  assert.equal(r.ok, false);
  assert.match(r.reason, /generatedAt/);
});

test('a failed crawl aborts — no live observations, no audit', (t) => {
  const { ctx, repoRoot } = setup(t);
  writeIndex(repoRoot, {
    sources: [{ id: 'crawler', ok: false, error: 'net::ERR_CONNECTION_REFUSED' }],
  });

  const r = assertFreshAcquisition(ctx, Date.now());
  assert.equal(r.ok, false);
  assert.match(r.reason, /no live observations of https:\/\/app\.example\.com/);
  assert.match(r.reason, /ERR_CONNECTION_REFUSED/);
});

test('a crawler that never ran aborts', (t) => {
  const { ctx, repoRoot } = setup(t);
  writeIndex(repoRoot, { sources: [{ id: 'python-fastapi', ok: true }] });
  const r = assertFreshAcquisition(ctx, Date.now());
  assert.equal(r.ok, false);
  assert.match(r.reason, /crawler did not run/);
});

test('a broken code-extractor degrades, it does not abort', (t) => {
  // Losing one perspective is survivable and disclosable; losing the live crawl
  // is not. The report's gap section is what makes this honest.
  const { ctx, lines, repoRoot } = setup(t);
  writeIndex(repoRoot, {
    sources: [
      okCrawler,
      { id: 'python-fastapi', ok: false, error: 'SyntaxError in routes.py' },
      { id: 'nextjs-app', ok: false, error: 'tsconfig unreadable' },
      { id: 'java-spring', ok: true, skipped: false },
    ],
  });

  assert.deepEqual(assertFreshAcquisition(ctx, Date.now()), { ok: true });

  const { degraded } = readRun(ctx.dir);
  assert.equal(degraded.length, 2);
  assert.deepEqual(degraded.map((d) => d.useCase).sort(), ['nextjs-app', 'python-fastapi']);
  assert.equal(degraded[0].stage, 'acquire');
  assert.match(degraded[0].reason, /SyntaxError/);
  assert.match(lines.join('\n'), /2 source\(s\) failed/);
});

test('a skipped source is not a degradation', (t) => {
  // "Skipped" means we had no input for it (no codebase → no code extractors).
  // Reporting that as a degradation would cry wolf on every url-only run.
  const { ctx, repoRoot } = setup(t);
  writeIndex(repoRoot, {
    sources: [okCrawler, { id: 'graphify', ok: false, skipped: 'no TARGET_CODEBASE' }],
  });

  assert.deepEqual(assertFreshAcquisition(ctx, Date.now()), { ok: true });
  assert.deepEqual(readRun(ctx.dir).degraded, []);
});

test('clock skew of a second or two does not fail a good run', (t) => {
  const { ctx, repoRoot } = setup(t);
  const startedAt = Date.now();
  writeIndex(repoRoot, {
    generatedAt: new Date(startedAt - 1000).toISOString(),   // stamped just before
    sources: [okCrawler],
  });
  assert.deepEqual(assertFreshAcquisition(ctx, startedAt), { ok: true });
});

// ── snapshot ───────────────────────────────────────────────────────────────

test('snapshotContext copies the run\'s understanding into the workspace', (t) => {
  const { ctx, repoRoot } = setup(t);
  const out = path.join(repoRoot, 'output');
  fs.mkdirSync(path.join(out, 'synthesized'), { recursive: true });
  fs.mkdirSync(path.join(out, 'features'), { recursive: true });
  fs.mkdirSync(path.join(out, 'sources'), { recursive: true });
  fs.writeFileSync(path.join(out, 'synthesized', 'facts.json'), '{"facts":[]}');
  fs.writeFileSync(path.join(out, 'features', 'features.json'), '{"features":[]}');
  fs.writeFileSync(path.join(out, 'sources', 'crawler.json'), '{}');
  writeIndex(repoRoot, { sources: [okCrawler] });

  assert.deepEqual(snapshotContext(ctx), { ok: true });

  const ctxDir = ctx.paths.context;
  assert.ok(fs.existsSync(path.join(ctxDir, 'synthesized', 'facts.json')));
  assert.ok(fs.existsSync(path.join(ctxDir, 'features', 'features.json')));
  assert.ok(fs.existsSync(path.join(ctxDir, 'sources', 'crawler.json')));
  assert.ok(fs.existsSync(path.join(ctxDir, 'content-extraction-index.json')));
});

test('the snapshot is a copy — a later run cannot rewrite this run\'s record', (t) => {
  const { ctx, repoRoot } = setup(t);
  const facts = path.join(repoRoot, 'output', 'synthesized', 'facts.json');
  fs.mkdirSync(path.dirname(facts), { recursive: true });
  fs.writeFileSync(facts, '{"facts":["this run"]}');

  snapshotContext(ctx);
  fs.writeFileSync(facts, '{"facts":["a later run"]}');   // output/ moves on

  const snapshot = fs.readFileSync(path.join(ctx.paths.context, 'synthesized', 'facts.json'), 'utf8');
  assert.match(snapshot, /this run/);
});

test('snapshotContext fails when understand produced nothing', (t) => {
  const { ctx } = setup(t);
  const r = snapshotContext(ctx);
  assert.equal(r.ok, false);
  assert.match(r.reason, /no artifacts/);
});

// ── registry ───────────────────────────────────────────────────────────────

test('the registry is the pipeline, in order, with the gate before generate', (t) => {
  assert.deepEqual(STAGES.map((s) => s.name), [
    'acquire', 'understand', 'store', 'plan', 'checkpoint', 'generate', 'execute', 'report',
  ]);
  const gate = STAGES.findIndex((s) => s.name === 'checkpoint');
  assert.ok(gate < STAGES.findIndex((s) => s.name === 'generate'));
  assert.ok(gate < STAGES.findIndex((s) => s.name === 'execute'));
  assert.ok(gate > STAGES.findIndex((s) => s.name === 'plan'));
});

test('stages that must not silently continue are declared abort', (t) => {
  const failMode = Object.fromEntries(STAGES.map((s) => [s.name, s.failMode]));
  assert.equal(failMode.acquire, 'abort');      // nothing to test without observations
  assert.equal(failMode.understand, 'abort');
  assert.equal(failMode.execute, 'abort');      // results are the report's substance
  assert.equal(failMode.report, 'abort');       // the report IS the product
});

// ── planHash re-verification at execute (p0-01 §5 — the resume guard) ─────────

const runStage = (ctx, name) => STAGES.find((s) => s.name === name).run(ctx);

/** Approve a minimal plan (+ empty manifest) into the workspace and pin its hash. */
function approvePlan(ctx) {
  const plan = { runId: ctx.run.runId, createdAt: new Date().toISOString(),
    source: 'template', features: [], estimates: { scenarios: 0, llmRequests: 0 } };
  fs.writeFileSync(ctx.paths.planJson, JSON.stringify(plan));
  fs.mkdirSync(path.dirname(ctx.paths.manifest), { recursive: true });
  fs.writeFileSync(ctx.paths.manifest, JSON.stringify({ runId: ctx.run.runId, entries: [] }));
  updateRun(ctx.dir, (run) => {
    run.checkpoint.approvedAt = new Date().toISOString();
    run.checkpoint.planHash = hashFile(ctx.paths.planJson);
    run.checkpoint.approvedBy = 'operator';
  });
  ctx.run = readRun(ctx.dir);
}

test('execute ABORTS on a plan edited after approval — the resume hole (p0-01 §5)', async (t) => {
  // The exact --resume scenario: generate is already `done` (so its own
  // planHash gate is skipped), the plan file is edited in the gap, and execute
  // runs next. Without its own re-check, execute would enforce the safety floor
  // against — and run tests derived from — a plan the operator never approved.
  const { ctx } = setup(t);
  approvePlan(ctx);
  fs.appendFileSync(ctx.paths.planJson, '\n');    // tamper AFTER approval

  const r = await runStage(ctx, 'execute');
  assert.equal(r.ok, false);
  assert.match(r.reason, /changed after approval/);
  // nothing ran against the target — no results were written.
  assert.equal(fs.existsSync(ctx.paths.resultsJson), false);
});

test('execute proceeds when the plan still matches its approved hash', async (t) => {
  const { ctx } = setup(t);
  approvePlan(ctx);                                // no tamper

  const r = await runStage(ctx, 'execute');
  assert.equal(r.ok, true);
  assert.ok(fs.existsSync(ctx.paths.resultsJson)); // the gate let it run
});
