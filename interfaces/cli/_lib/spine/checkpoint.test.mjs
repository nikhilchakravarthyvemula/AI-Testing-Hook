import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createWorkspace, readRun } from './workspace.mjs';
import { runCheckpoint, verifyPlanHash, renderSummary } from './checkpoint.mjs';

// ── harness ────────────────────────────────────────────────────────────────

function setup(t, { plan, mode = 'safe', budget = 200 } = {}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-cp-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));

  const ws = createWorkspace({
    repoRoot: repo, url: 'https://app.example.com', codebasePath: null,
    mode, budget, engine: 'mock',
  });
  const p = plan ?? validPlan(ws.runId);
  fs.writeFileSync(ws.paths.planJson, JSON.stringify(p, null, 2));
  return ws;
}

/** A scripted operator: answers in order, and edits by applying `edits` shift-by-shift. */
function fakeIo(answers, edits = []) {
  const lines = [];
  return {
    lines,
    out: (m) => lines.push(String(m)),
    prompt: async () => {
      if (!answers.length) throw new Error('checkpoint asked more questions than the test scripted');
      return answers.shift();
    },
    openEditor: (file) => {
      const edit = edits.shift();
      if (edit) edit(file);
      return { ok: true, code: 0 };
    },
    text: () => lines.join('\n'),
  };
}

function validPlan(runId) {
  return {
    runId,
    createdAt: '2026-07-17T09:15:00.000Z',
    source: 'llm',
    features: [{
      featureId: 'feat:checkout', name: 'Checkout',
      scenarios: [
        { scenarioId: 'sc-1', title: 'cart loads', kind: 'ui', intent: 'the cart page renders',
          mutation: false, priority: 1, targets: { pages: ['/cart'] } },
        { scenarioId: 'sc-2', title: 'create order', kind: 'api', intent: 'a valid cart creates an order',
          mutation: true, priority: 2, targets: { endpoints: ['POST /api/v2/orders'] } },
      ],
    }],
    estimates: { scenarios: 2, llmRequests: 40 },
  };
}

// ── summary ────────────────────────────────────────────────────────────────

test('summary states what the mode MEANS for this plan', (t) => {
  const ws = setup(t);
  const plan = JSON.parse(fs.readFileSync(ws.paths.planJson, 'utf8'));

  const safe = renderSummary(plan, { mode: 'safe', maxRequests: 200, spent: 27 });
  assert.match(safe, /2 scenarios \(1 safe \/ 1 mutation\)/);
  assert.match(safe, /est\. 40 engine requests of 173 remaining/);
  assert.match(safe, /1 mutation scenario will be SKIPPED/);

  const full = renderSummary(plan, { mode: 'full', maxRequests: 200, spent: 0 });
  assert.match(full, /WILL write to the target application/);
});

test('summary warns when the plan outruns the budget', (t) => {
  const ws = setup(t);
  const plan = JSON.parse(fs.readFileSync(ws.paths.planJson, 'utf8'));
  const s = renderSummary(plan, { mode: 'safe', maxRequests: 200, spent: 190 });
  assert.match(s, /Estimate exceeds remaining budget/);
});

test('summary discloses a template plan at the gate', (t) => {
  const ws = setup(t);
  const plan = { ...JSON.parse(fs.readFileSync(ws.paths.planJson, 'utf8')), source: 'template' };
  assert.match(renderSummary(plan, { mode: 'safe', maxRequests: 200, spent: 0 }), /engine unavailable/);
});

// ── the gate ───────────────────────────────────────────────────────────────

test('y approves and pins the plan hash', async (t) => {
  const ws = setup(t);
  const io = fakeIo(['y']);
  const result = await runCheckpoint({ dir: ws.dir, planPath: ws.paths.planJson, run: ws.run, io });

  assert.equal(result.approved, true);
  const run = readRun(ws.dir);
  assert.ok(run.checkpoint.approvedAt);
  assert.equal(run.checkpoint.approvedBy, 'operator');
  assert.match(run.checkpoint.planHash, /^sha256:/);
  assert.equal(result.planHash, run.checkpoint.planHash);
});

test('N declines, and nothing is approved', async (t) => {
  const ws = setup(t);
  const result = await runCheckpoint({ dir: ws.dir, planPath: ws.paths.planJson, run: ws.run, io: fakeIo(['N']) });

  assert.equal(result.approved, false);
  const run = readRun(ws.dir);
  assert.equal(run.checkpoint.approvedAt, null);
  assert.equal(run.checkpoint.planHash, null);
});

test('a bare Enter is No — the default must be the safe answer', async (t) => {
  const ws = setup(t);
  const result = await runCheckpoint({ dir: ws.dir, planPath: ws.paths.planJson, run: ws.run, io: fakeIo(['']) });
  assert.equal(result.approved, false);
  assert.equal(readRun(ws.dir).checkpoint.approvedAt, null);
});

test('anything unrecognised is No, not a retry', async (t) => {
  const ws = setup(t);
  const result = await runCheckpoint({ dir: ws.dir, planPath: ws.paths.planJson, run: ws.run, io: fakeIo(['maybe']) });
  assert.equal(result.approved, false);
});

test('e round-trips an edit and approves the edited plan', async (t) => {
  const ws = setup(t);
  const io = fakeIo(['e', 'y'], [
    (file) => {
      const plan = JSON.parse(fs.readFileSync(file, 'utf8'));
      plan.features[0].scenarios.pop();           // operator drops the mutation scenario
      plan.estimates.scenarios = 1;
      fs.writeFileSync(file, JSON.stringify(plan, null, 2));
    },
  ]);

  const result = await runCheckpoint({ dir: ws.dir, planPath: ws.paths.planJson, run: ws.run, io });
  assert.equal(result.approved, true);

  // The pinned hash must be of what they saw LAST, not what C5 originally wrote.
  const onDisk = JSON.parse(fs.readFileSync(ws.paths.planJson, 'utf8'));
  assert.equal(onDisk.features[0].scenarios.length, 1);
  assert.equal(verifyPlanHash(ws.dir, ws.paths.planJson, readRun(ws.dir)).ok, true);
  assert.match(io.text(), /1 scenario \(1 safe \/ 0 mutation\)/);
});

test('an edit that breaks the plan is explained, then re-prompted', async (t) => {
  const ws = setup(t);
  const io = fakeIo(['e', 'e', 'y'], [
    (file) => fs.writeFileSync(file, '{ this is not json'),
    (file) => fs.writeFileSync(file, JSON.stringify(validPlan(readRun(ws.dir).runId), null, 2)),
  ]);

  const result = await runCheckpoint({ dir: ws.dir, planPath: ws.paths.planJson, run: ws.run, io });
  assert.equal(result.approved, true);
  assert.match(io.text(), /not valid JSON/);
});

test('an invalid plan cannot be approved with y', async (t) => {
  const ws = setup(t);
  const io = fakeIo(['y', 'N'], []);
  // Break the plan on disk before the gate reads it.
  const plan = validPlan(ws.runId);
  delete plan.features[0].scenarios[0].mutation;
  fs.writeFileSync(ws.paths.planJson, JSON.stringify(plan));

  const result = await runCheckpoint({ dir: ws.dir, planPath: ws.paths.planJson, run: ws.run, io });
  assert.equal(result.approved, false);
  assert.match(io.text(), /Cannot approve an invalid plan/);
  assert.equal(readRun(ws.dir).checkpoint.approvedAt, null);
});

test('a plan from another run is refused', async (t) => {
  const ws = setup(t, { plan: validPlan('some-other-run') });
  const io = fakeIo(['y', 'N']);
  const result = await runCheckpoint({ dir: ws.dir, planPath: ws.paths.planJson, run: ws.run, io });
  assert.equal(result.approved, false);
  assert.match(io.text(), /belongs to run "some-other-run"/);
});

test('--yes auto-approves but records that no human looked', async (t) => {
  const ws = setup(t);
  const io = fakeIo([]);   // asking anything would throw
  const result = await runCheckpoint({
    dir: ws.dir, planPath: ws.paths.planJson, run: ws.run, autoApprove: true, io,
  });

  assert.equal(result.approved, true);
  assert.equal(readRun(ws.dir).checkpoint.approvedBy, '--yes flag');
  assert.match(io.text(), /Auto-approved/);
});

test('--yes still refuses an invalid plan', async (t) => {
  const ws = setup(t);
  fs.writeFileSync(ws.paths.planJson, JSON.stringify({ runId: ws.runId }));
  const result = await runCheckpoint({
    dir: ws.dir, planPath: ws.paths.planJson, run: ws.run, autoApprove: true, io: fakeIo([]),
  });
  assert.equal(result.approved, false);
  assert.match(result.reason, /invalid/);
});

test('a missing plan file is reported, not thrown', async (t) => {
  const ws = setup(t);
  fs.rmSync(ws.paths.planJson);
  const result = await runCheckpoint({ dir: ws.dir, planPath: ws.paths.planJson, run: ws.run, io: fakeIo([]) });
  assert.equal(result.approved, false);
  assert.match(result.reason, /unreadable/);
});

// ── post-approval integrity ────────────────────────────────────────────────

test('a plan edited AFTER approval is caught before execution', async (t) => {
  const ws = setup(t);
  await runCheckpoint({ dir: ws.dir, planPath: ws.paths.planJson, run: ws.run, io: fakeIo(['y']) });
  assert.equal(verifyPlanHash(ws.dir, ws.paths.planJson, readRun(ws.dir)).ok, true);

  // Someone slips a mutation scenario in after the human walked away.
  const plan = JSON.parse(fs.readFileSync(ws.paths.planJson, 'utf8'));
  plan.features[0].scenarios.push({
    scenarioId: 'sc-99', title: 'delete everything', kind: 'api', intent: 'wipe',
    mutation: true, priority: 1, targets: { endpoints: ['DELETE /api/v2/orders'] },
  });
  fs.writeFileSync(ws.paths.planJson, JSON.stringify(plan, null, 2));

  const check = verifyPlanHash(ws.dir, ws.paths.planJson, readRun(ws.dir));
  assert.equal(check.ok, false);
  assert.match(check.reason, /changed after approval/);
});

test('verifyPlanHash refuses an unapproved run', (t) => {
  const ws = setup(t);
  const check = verifyPlanHash(ws.dir, ws.paths.planJson, readRun(ws.dir));
  assert.equal(check.ok, false);
  assert.match(check.reason, /no approved plan/);
});

test('verifyPlanHash reports a vanished plan', async (t) => {
  const ws = setup(t);
  await runCheckpoint({ dir: ws.dir, planPath: ws.paths.planJson, run: ws.run, io: fakeIo(['y']) });
  fs.rmSync(ws.paths.planJson);
  const check = verifyPlanHash(ws.dir, ws.paths.planJson, readRun(ws.dir));
  assert.equal(check.ok, false);
  assert.match(check.reason, /missing/);
});
