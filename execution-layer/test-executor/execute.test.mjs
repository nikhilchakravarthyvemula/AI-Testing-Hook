import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runExecute } from './execute.mjs';
import { STATUSES } from './lib/results.mjs';

// ── workspace with a manifest + plan on disk ─────────────────────────────────

function makeWorkspace(t, { manifest, plan, files = {} }) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'c7-exec-'));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  fs.mkdirSync(path.join(ws, 'tests'), { recursive: true });
  fs.mkdirSync(path.join(ws, 'plan'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'tests', 'manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(ws, 'plan', 'test-plan.json'), JSON.stringify(plan));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(ws, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return ws;
}

function readResults(ws) {
  return JSON.parse(fs.readFileSync(path.join(ws, 'results', 'results.json'), 'utf8'));
}

const entry = (scenarioId, { mutation = false, status = 'generated', featureId = 'feat:f' } = {}) =>
  ({ scenarioId, featureId, file: `tests/${featureId}/${scenarioId}.spec.mjs`, kind: 'api', mutation, generator: 'agent', status });

const scenario = (scenarioId, { title = scenarioId, intent = 'do a thing', targets = { endpoints: ['GET /x'] } } = {}) =>
  ({ scenarioId, title, kind: 'api', intent, mutation: false, targets, priority: 0, gapRefs: [] });

// every manifest entry appears exactly once, with a legal status.
function assertOnePerEntry(results, manifest) {
  const ids = results.entries.map((e) => e.scenarioId).sort();
  assert.deepEqual(ids, manifest.entries.map((e) => e.scenarioId).sort());
  assert.ok(results.entries.every((e) => STATUSES.includes(e.status)));
}

// Most tests exercise enforcement/the runner, not auth: resolving auth for real
// would launch a browser. Inject an explicit "no credentials" instead.
const NO_AUTH = { storageState: null, token: null, credentials: null, degraded: [] };

const passing = () => ({ status: 'passed', durationMs: 5, artifacts: { screenshots: [], log: 'results/raw/x.log' } });

// ── acceptance 1 — safe mode enforcement ─────────────────────────────────────

test('safe mode: 3 run, 2 mutation skipped, 1 failed-generation carried', async (t) => {
  const manifest = { runId: 'r1', entries: [
    entry('sc-01'), entry('sc-02'), entry('sc-03'),
    entry('sc-04', { mutation: true }), entry('sc-05', { mutation: true }),
    entry('sc-06', { status: 'failed-generation' }),
  ] };
  const plan = { runId: 'r1', features: [{ featureId: 'feat:f', scenarios:
    ['sc-01', 'sc-02', 'sc-03', 'sc-04', 'sc-05', 'sc-06'].map((id) => scenario(id)) }] };
  const ws = makeWorkspace(t, { manifest, plan });

  let ran = 0;
  const res = await runExecute({ workspace: ws, runId: 'r1', mode: 'safe', allowlist: new Set(),
    auth: NO_AUTH, runnerFn: () => { ran += 1; return passing(); } });
  assert.equal(res.ok, true);

  const results = readResults(ws);
  assertOnePerEntry(results, manifest);
  assert.equal(ran, 3, 'only the 3 safe scenarios reach the runner');
  assert.deepEqual(results.summary, { passed: 3, failed: 0, skippedMutation: 2, error: 1 });

  // the mutation skips cite safe-mode; the carried one cites failed-generation.
  assert.equal(results.entries.find((e) => e.scenarioId === 'sc-04').reason, 'safe-mode');
  assert.equal(results.entries.find((e) => e.scenarioId === 'sc-06').status, 'error');
  assert.equal(results.entries.find((e) => e.scenarioId === 'sc-06').reason, 'failed-generation');
});

// ── acceptance 2 — full mode + safety floor ──────────────────────────────────

test('full mode runs mutations, but the safety floor still skips (no allowlist)', async (t) => {
  const manifest = { runId: 'r1', entries: [
    entry('sc-mut', { mutation: true }),
    entry('sc-danger'),                      // trips the floor via its plan text
  ] };
  const plan = { runId: 'r1', features: [{ featureId: 'feat:f', scenarios: [
    scenario('sc-mut', { title: 'place order' }),
    scenario('sc-danger', { title: 'delete the account', intent: 'remove the user' }),
  ] }] };
  const ws = makeWorkspace(t, { manifest, plan });

  const touched = [];
  const res = await runExecute({ workspace: ws, runId: 'r1', mode: 'full', allowlist: new Set(),
    auth: NO_AUTH, runnerFn: (e) => { touched.push(e.scenarioId); return passing(); } });

  const results = readResults(ws);
  assert.deepEqual(touched, ['sc-mut'], 'mutation runs in full mode; the floor scenario does not');
  assert.equal(results.entries.find((e) => e.scenarioId === 'sc-danger').reason, 'safety-floor');
  assert.equal(res.stats.skippedMutation, 1);
});

test('SAFETY_ALLOWLIST lets a specific floor scenario through, even in safe mode', async (t) => {
  const manifest = { runId: 'r1', entries: [entry('sc-danger')] };
  const plan = { runId: 'r1', features: [{ featureId: 'feat:f', scenarios: [scenario('sc-danger', { title: 'delete the account' })] }] };
  const ws = makeWorkspace(t, { manifest, plan });

  const touched = [];
  await runExecute({ workspace: ws, runId: 'r1', mode: 'safe', allowlist: new Set(['sc-danger']),
    auth: NO_AUTH, runnerFn: (e) => { touched.push(e.scenarioId); return passing(); } });
  assert.deepEqual(touched, ['sc-danger']);
});

// ── auth: credentials reach the tests, and their absence is disclosed ────────

test('the run\'s credentials are handed to every test it runs', async (t) => {
  const manifest = { runId: 'r1', entries: [entry('sc-01')] };
  const plan = { runId: 'r1', features: [{ featureId: 'feat:f', scenarios: [scenario('sc-01')] }] };
  const ws = makeWorkspace(t, { manifest, plan });

  let seen = null;
  await runExecute({
    workspace: ws, runId: 'r1', mode: 'safe', allowlist: new Set(),
    auth: { storageState: '/tmp/auth-state.json', token: 'tok-123', degraded: [] },
    runnerFn: (e, config) => { seen = config; return passing(); },
  });

  // the runner passes these into the child process, where harness.mjs turns them
  // into ctx.storageState / ctx.authToken.
  assert.equal(seen.storageState, '/tmp/auth-state.json');
  assert.equal(seen.authToken, 'tok-123');
  // …and the env aliases a generated test might reach for instead.
  assert.equal(seen.env.AUTH_TOKEN, 'tok-123');
  assert.equal(seen.env.BEARER_TOKEN, 'tok-123');
  assert.equal(seen.env.STORAGE_STATE, '/tmp/auth-state.json');
});

test('missing auth is a disclosed degradation, not a stage failure', async (t) => {
  const manifest = { runId: 'r1', entries: [entry('sc-01')] };
  const plan = { runId: 'r1', features: [{ featureId: 'feat:f', scenarios: [scenario('sc-01')] }] };
  const ws = makeWorkspace(t, { manifest, plan });

  const res = await runExecute({
    workspace: ws, runId: 'r1', mode: 'safe', allowlist: new Set(),
    auth: { ...NO_AUTH, degraded: [{ useCase: 'auth', stage: 'execute', reason: 'no saved login', fallback: 'unauthenticated' }] },
    runnerFn: () => passing(),
  });

  assert.equal(res.ok, true, 'the stage still runs — auth is not a gate');
  assert.equal(res.degraded.length, 1);
  assert.equal(res.degraded[0].useCase, 'auth');
  // the test still ran; it just ran without credentials.
  assert.equal(readResults(ws).summary.passed, 1);
});

test('a test with no credentials gets nulls, never a stale or invented token', async (t) => {
  const manifest = { runId: 'r1', entries: [entry('sc-01')] };
  const plan = { runId: 'r1', features: [{ featureId: 'feat:f', scenarios: [scenario('sc-01')] }] };
  const ws = makeWorkspace(t, { manifest, plan });

  let seen = null;
  await runExecute({
    workspace: ws, runId: 'r1', mode: 'safe', allowlist: new Set(),
    auth: NO_AUTH,
    runnerFn: (e, config) => { seen = config; return passing(); },
  });

  assert.equal(seen.storageState, null);
  assert.equal(seen.authToken, null);
  assert.equal(seen.env.AUTH_TOKEN, '');      // empty ⇒ harness.mjs yields null
});

// ── missing manifest / plan → hard stop ──────────────────────────────────────

test('no manifest → ok:false (stage aborts)', async (t) => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'c7-nomani-'));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  const res = await runExecute({ workspace: ws, runId: 'r1' });
  assert.equal(res.ok, false);
  assert.match(res.reason, /no test manifest/);
});

// ── REAL child processes: pass / fail / no-run-export ─────────────────────────

test('real runner: passing test → passed, failing test → failed, no-run → error', async (t) => {
  const manifest = { runId: 'r1', entries: [
    entry('sc-pass'), entry('sc-fail'), entry('sc-norun'),
  ] };
  const plan = { runId: 'r1', features: [{ featureId: 'feat:f', scenarios:
    ['sc-pass', 'sc-fail', 'sc-norun'].map((id) => scenario(id)) }] };
  const ws = makeWorkspace(t, { manifest, plan, files: {
    'tests/feat:f/sc-pass.spec.mjs': 'export async function run() { return { ok: true }; }\n',
    'tests/feat:f/sc-fail.spec.mjs': 'export async function run() { throw new Error("boom"); }\n',
    'tests/feat:f/sc-norun.spec.mjs': 'export const scenario = { id: "sc-norun" };\n',   // no run()
  } });

  // real runChildProcess (runnerFn omitted).
  const res = await runExecute({ workspace: ws, runId: 'r1', mode: 'safe', allowlist: new Set(), auth: NO_AUTH, timeoutMs: 15_000 });
  assert.equal(res.ok, true);

  const byId = Object.fromEntries(readResults(ws).entries.map((e) => [e.scenarioId, e]));
  assert.equal(byId['sc-pass'].status, 'passed');
  assert.equal(byId['sc-fail'].status, 'failed');
  assert.equal(byId['sc-norun'].status, 'error');
  assert.equal(byId['sc-norun'].reason, 'no-run-export');
  // the failing test's log was captured.
  const log = fs.readFileSync(path.join(ws, byId['sc-fail'].artifacts.log), 'utf8');
  assert.match(log, /boom/);
});

// ── REAL child process: hang killed at timeout, NO ORPHAN (acceptance 1 & 3) ──

test('a hanging test is killed at timeout (error), and its grandchild is not orphaned', async (t) => {
  const pidfile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'c7-pid-')), 'gc.pid');
  t.after(() => fs.rmSync(path.dirname(pidfile), { recursive: true, force: true }));

  const manifest = { runId: 'r1', entries: [entry('sc-hang')] };
  const plan = { runId: 'r1', features: [{ featureId: 'feat:f', scenarios: [scenario('sc-hang')] }] };
  // run() spawns a long-lived grandchild in the SAME process group, records its
  // pid, then hangs forever. Killing only the node process would orphan the
  // grandchild; killing the GROUP takes it too.
  const hang = `
export async function run() {
  const { spawn } = await import('node:child_process');
  const fs = await import('node:fs');
  const gc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 100000)'], { stdio: 'ignore' });
  fs.writeFileSync(process.env.GC_PIDFILE, String(gc.pid));
  await new Promise(() => {});   // hang
}
`;
  const ws = makeWorkspace(t, { manifest, plan, files: { 'tests/feat:f/sc-hang.spec.mjs': hang } });

  const res = await runExecute({ workspace: ws, runId: 'r1', mode: 'safe', allowlist: new Set(),
    auth: NO_AUTH, timeoutMs: 800, env: { GC_PIDFILE: pidfile } });
  assert.equal(res.ok, true);

  const e = readResults(ws).entries[0];
  assert.equal(e.status, 'error');
  assert.equal(e.reason, 'timeout');

  // the grandchild pid must be dead — poll briefly for the group-kill to reap it.
  const gpid = Number(fs.readFileSync(pidfile, 'utf8').trim());
  assert.ok(Number.isInteger(gpid) && gpid > 0);
  assert.ok(await eventuallyDead(gpid), `grandchild ${gpid} was orphaned (still alive)`);
});

// poll process liveness for up to ~3s.
async function eventuallyDead(pid) {
  for (let i = 0; i < 30; i++) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !alive(pid);
}
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }   // EPERM = exists but not ours; ESRCH = gone
}
