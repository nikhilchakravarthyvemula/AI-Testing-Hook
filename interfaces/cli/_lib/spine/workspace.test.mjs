import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  newRunId, slugifyHost, createWorkspace, openWorkspace, workspacePaths,
  readRun, stageStart, stageEnd, markDegraded, finalizeRun, hashFile,
  requestsSpent, STAGE_NAMES,
} from './workspace.mjs';

function tmpRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-ws-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const baseCfg = (repoRoot) => ({
  repoRoot, url: 'https://app.example.com', codebasePath: null,
  mode: 'safe', budget: 200, engine: 'mock',
});

// ── ids ────────────────────────────────────────────────────────────────────

test('runId is time-sortable and names its target', () => {
  const id = newRunId('https://logtrim.example.com/dash', new Date('2026-07-17T09:15:00'));
  assert.equal(id, '20260717-091500-logtrim-example-com');
});

test('slugifyHost survives junk input', () => {
  assert.equal(slugifyHost('https://www.Example.COM'), 'example-com');
  assert.equal(slugifyHost('not a url'), 'not-a-url');
  assert.equal(slugifyHost(''), 'target');
});

// ── create ─────────────────────────────────────────────────────────────────

test('createWorkspace builds the p0-00 §3 layout', (t) => {
  const repo = tmpRepo(t);
  const { dir, paths } = createWorkspace(baseCfg(repo));

  for (const d of ['cache', 'context', 'store', 'plan', 'tests', 'results', 'report']) {
    assert.ok(fs.statSync(path.join(dir, d)).isDirectory(), `${d}/ should exist`);
  }
  // The ledger must be readable unconditionally — the budget check and the
  // report both read it before anything has written a line.
  assert.equal(fs.readFileSync(paths.ledger, 'utf8'), '');
  assert.deepEqual(requestsSpent(dir), 0);
});

test('run.json matches the p0-00 §4 shape', (t) => {
  const repo = tmpRepo(t);
  const { dir, run } = createWorkspace({ ...baseCfg(repo), codebasePath: '/src/app', mode: 'full', budget: 50 });

  assert.equal(run.target.url, 'https://app.example.com');
  assert.equal(run.target.codebasePath, '/src/app');
  assert.equal(run.profile, 'url+code');
  assert.equal(run.mode, 'full');
  assert.deepEqual(run.budget, { maxRequests: 50 });
  assert.equal(run.engine.provider, 'mock');
  assert.equal(run.outcome, null);
  assert.deepEqual(run.degraded, []);
  assert.deepEqual(run.checkpoint, { approvedAt: null, planHash: null });
  assert.deepEqual(Object.keys(run.stages), STAGE_NAMES);
  for (const s of Object.values(run.stages)) {
    assert.deepEqual(s, { status: 'pending', startedAt: null, endedAt: null });
  }
  assert.deepEqual(readRun(dir), run, 'what we return is what we wrote');
});

test('profile is derived from whether a codebase was given', (t) => {
  const repo = tmpRepo(t);
  assert.equal(createWorkspace(baseCfg(repo)).run.profile, 'url-only');
});

test('createWorkspace refuses to clobber an existing run', (t) => {
  const repo = tmpRepo(t);
  const cfg = { ...baseCfg(repo), runId: 'fixed-id' };
  createWorkspace(cfg);
  assert.throws(() => createWorkspace(cfg), /already exists/);
});

// ── stage status ───────────────────────────────────────────────────────────

test('stage transitions are stamped', (t) => {
  const repo = tmpRepo(t);
  const { dir } = createWorkspace(baseCfg(repo));

  stageStart(dir, 'acquire');
  let s = readRun(dir).stages.acquire;
  assert.equal(s.status, 'running');
  assert.ok(s.startedAt);
  assert.equal(s.endedAt, null);

  stageEnd(dir, 'acquire', 'done');
  s = readRun(dir).stages.acquire;
  assert.equal(s.status, 'done');
  assert.ok(s.endedAt);
});

test('a failed stage records why, and later stages stay pending', (t) => {
  const repo = tmpRepo(t);
  const { dir } = createWorkspace(baseCfg(repo));

  stageStart(dir, 'store');
  stageEnd(dir, 'store', 'failed', { reason: 'not implemented yet' });
  finalizeRun(dir, 'aborted');

  const run = readRun(dir);
  assert.equal(run.stages.store.status, 'failed');
  assert.equal(run.stages.store.reason, 'not implemented yet');
  assert.equal(run.stages.report.status, 'pending', 'run.json stays truthful about what never ran');
  assert.equal(run.outcome, 'aborted');
  assert.ok(run.endedAt);
});

// ── degradation ────────────────────────────────────────────────────────────

test('markDegraded appends an auditable entry', (t) => {
  const repo = tmpRepo(t);
  const { dir } = createWorkspace(baseCfg(repo));

  markDegraded(dir, { useCase: 'S1', stage: 'plan', reason: 'engine unavailable', fallback: 'template scenarios' });
  markDegraded(dir, { useCase: 'S2', stage: 'store', reason: 'budget exhausted', fallback: 'left unmerged' });

  const { degraded } = readRun(dir);
  assert.equal(degraded.length, 2);
  assert.equal(degraded[0].useCase, 'S1');
  assert.ok(degraded[0].at, 'each degradation is timestamped');
});

test('markDegraded rejects an incomplete entry', (t) => {
  const repo = tmpRepo(t);
  const { dir } = createWorkspace(baseCfg(repo));
  // A degradation the report cannot explain is worse than none: it would show
  // up as an unexplained asterisk on the transparency section.
  assert.throws(() => markDegraded(dir, { useCase: 'S1', stage: 'plan' }), /needs/);
});

// ── resume ─────────────────────────────────────────────────────────────────

test('openWorkspace re-derives config from the run record', (t) => {
  const repo = tmpRepo(t);
  const { runId } = createWorkspace({ ...baseCfg(repo), mode: 'full', budget: 7 });
  stageEnd(repo && runDirOf(repo, runId), 'acquire', 'done');

  const reopened = openWorkspace(repo, runId);
  assert.equal(reopened.run.mode, 'full', 'a resumed run keeps its original terms');
  assert.equal(reopened.run.budget.maxRequests, 7);
  assert.equal(reopened.run.stages.acquire.status, 'done');
});

test('openWorkspace fails loudly on an unknown runId', (t) => {
  const repo = tmpRepo(t);
  assert.throws(() => openWorkspace(repo, 'no-such-run'), /no such run/);
});

// ── integrity ──────────────────────────────────────────────────────────────

test('hashFile is stable and content-addressed', (t) => {
  const repo = tmpRepo(t);
  const f = path.join(repo, 'plan.json');
  fs.writeFileSync(f, '{"a":1}');
  const first = hashFile(f);
  assert.match(first, /^sha256:[0-9a-f]{64}$/);
  assert.equal(hashFile(f), first);

  fs.writeFileSync(f, '{"a":2}');
  assert.notEqual(hashFile(f), first);
});

test('run.json survives a partial write', (t) => {
  // Atomic rename means a run killed mid-write still has a parseable record —
  // which is the whole reason the record exists.
  const repo = tmpRepo(t);
  const { dir } = createWorkspace(baseCfg(repo));
  stageStart(dir, 'acquire');
  assert.ok(readRun(dir).runId);
  assert.equal(fs.existsSync(workspacePaths(dir).runJson + '.tmp'), false, 'no tmp file left behind');
});

// ── ledger ─────────────────────────────────────────────────────────────────

test('requestsSpent sums the ledger and ignores junk lines', (t) => {
  const repo = tmpRepo(t);
  const { dir, paths } = createWorkspace(baseCfg(repo));
  fs.appendFileSync(paths.ledger,
    JSON.stringify({ useCase: 'S1', requests: 3 }) + '\n' +
    'not json\n' +
    JSON.stringify({ useCase: 'S2', requests: 2, cacheHit: false }) + '\n' +
    JSON.stringify({ useCase: 'S2', requests: 0, cacheHit: true }) + '\n');
  assert.equal(requestsSpent(dir), 5);
});

function runDirOf(repoRoot, runId) {
  return path.join(repoRoot, 'output', 'runs', runId);
}
