// The checkpoint — the run's one human gate.
//
// Between `plan` and `generate` the spine stops and shows the operator what it
// intends to do, then waits. Nothing has touched the target application yet;
// nothing will until someone types y. That ordering is the whole point, and it
// is why this lives in the spine rather than inside a generator: the gate must
// not be something an LLM can talk its way past.
//
// On approval we hash the plan file. The generate and execute stages re-check
// that hash before running, so a plan edited *after* approval doesn't quietly
// execute something the operator never saw (docs/specs/p0-01 §4).

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import readline from 'node:readline/promises';

import { hashFile, updateRun, requestsSpent } from './workspace.mjs';
import { validatePlan, allScenarios, countMutations, formatErrors } from './plan-schema.mjs';

// ── summary ────────────────────────────────────────────────────────────────

/**
 * The text the operator's decision is based on. Every number here is one they
 * would otherwise have to derive by reading the plan file themselves.
 */
export function renderSummary(plan, { mode, maxRequests, spent }) {
  const features = plan.features?.length ?? 0;
  const scenarios = allScenarios(plan);
  const mutations = countMutations(plan);
  const safe = scenarios.length - mutations;
  const remaining = Math.max(0, maxRequests - spent);
  const est = plan.estimates?.llmRequests ?? 0;

  const lines = [];
  lines.push(
    `Plan ready: ${features} ${plural(features, 'feature')}, ${scenarios.length} ` +
    `${plural(scenarios.length, 'scenario')} (${safe} safe / ${mutations} mutation), ` +
    `est. ${est} engine ${plural(est, 'request')} of ${remaining} remaining.`
  );

  // Say what the mode MEANS for this plan, not just what it's set to — "safe"
  // is abstract; "6 scenarios will be skipped" is the thing they're agreeing to.
  if (mode === 'safe') {
    lines.push(mutations > 0
      ? `Mode: safe — ${mutations} mutation ${plural(mutations, 'scenario')} will be SKIPPED (reported as coverage gaps).`
      : `Mode: safe — no mutation scenarios in this plan.`);
  } else {
    lines.push(mutations > 0
      ? `Mode: FULL — ${mutations} mutation ${plural(mutations, 'scenario')} WILL write to the target application.`
      : `Mode: FULL — no mutation scenarios in this plan.`);
  }

  if (plan.source === 'template') {
    // Provenance matters at the gate: a template plan means the engine was
    // unavailable, and the operator is approving deterministic scaffolding.
    lines.push('Source: template (engine unavailable — scenarios are deterministic scaffolding).');
  }

  if (est > remaining) {
    lines.push(`⚠ Estimate exceeds remaining budget — generation will degrade to templates partway through.`);
  }

  return lines.join('\n');
}

// ── the gate ───────────────────────────────────────────────────────────────

/**
 * Run the checkpoint.
 *
 * @param {object} args
 * @param {string} args.dir           workspace dir
 * @param {string} args.planPath      plan/test-plan.json
 * @param {object} args.run           the run record
 * @param {boolean} [args.autoApprove] --yes
 * @param {object} [args.io]          injected for tests: { out, prompt, openEditor }
 * @returns {Promise<{approved: boolean, planHash?: string, reason?: string}>}
 */
export async function runCheckpoint({ dir, planPath, run, autoApprove = false, io = defaultIo() }) {
  let plan;
  try {
    plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  } catch (e) {
    return { approved: false, reason: `plan unreadable: ${e.message}` };
  }

  let check = validatePlan(plan, { runId: run.runId });
  const ctx = { mode: run.mode, maxRequests: run.budget.maxRequests, spent: requestsSpent(dir) };

  // --yes is for CI and dev loops. It still records HOW the run was approved,
  // because the report's transparency section has to disclose that no human
  // actually looked at this plan.
  if (autoApprove) {
    if (!check.valid) {
      return { approved: false, reason: `plan is invalid:\n${formatErrors(check.errors)}` };
    }
    io.out(renderSummary(plan, ctx));
    io.out('Auto-approved (--yes).\n');
    return { approved: true, planHash: approve(dir, planPath, '--yes flag') };
  }

  for (;;) {
    io.out('');
    if (check.valid) {
      io.out(renderSummary(plan, ctx));
    } else {
      io.out('Plan has validation errors:');
      io.out(formatErrors(check.errors));
      io.out('\nFix them with [e], or abort with [N].');
    }

    const answer = (await io.prompt('Approve and execute? [y/N/e] ')).trim().toLowerCase();

    if (answer === 'e') {
      const edited = io.openEditor(planPath);
      if (!edited.ok) {
        io.out(`Editor exited ${edited.code} — plan left unchanged.`);
      }
      try {
        plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
        check = validatePlan(plan, { runId: run.runId });
      } catch (e) {
        // A JSON syntax error is a validation failure like any other — say
        // where, and let them go straight back into the editor.
        check = { valid: false, errors: [{ path: '/', message: `not valid JSON: ${e.message}` }] };
      }
      continue;
    }

    if (answer === 'y') {
      if (!check.valid) {
        io.out('\nCannot approve an invalid plan — fix it with [e] or abort with [N].');
        continue;
      }
      return { approved: true, planHash: approve(dir, planPath, 'operator') };
    }

    // Anything else, including a bare Enter, is No. The default must be the
    // safe answer: an operator who walks away has not approved anything.
    return { approved: false, reason: 'operator declined at checkpoint' };
  }
}

function approve(dir, planPath, approvedBy) {
  // Hash AFTER any edits — the thing we pin is what they actually saw last.
  const planHash = hashFile(planPath);
  updateRun(dir, (run) => {
    run.checkpoint.approvedAt = new Date().toISOString();
    run.checkpoint.planHash = planHash;
    run.checkpoint.approvedBy = approvedBy;
  });
  return planHash;
}

// ── post-approval integrity ────────────────────────────────────────────────

/**
 * Verify the plan on disk is still the plan that was approved.
 *
 * Called by generate/execute before they act. Cheap, and it closes the window
 * between "operator approved" and "harness fires requests at a live app".
 */
export function verifyPlanHash(dir, planPath, run) {
  if (!run.checkpoint?.planHash) {
    return { ok: false, reason: 'run has no approved plan' };
  }
  if (!fs.existsSync(planPath)) {
    return { ok: false, reason: `approved plan is missing: ${planPath}` };
  }
  const actual = hashFile(planPath);
  if (actual !== run.checkpoint.planHash) {
    return {
      ok: false,
      reason: 'plan changed after approval — re-run the checkpoint before executing ' +
              `(approved ${run.checkpoint.planHash.slice(0, 19)}…, found ${actual.slice(0, 19)}…)`,
    };
  }
  return { ok: true };
}

// ── io ─────────────────────────────────────────────────────────────────────
//
// Injected so the gate's logic is testable without a tty or a real $EDITOR —
// this is the one piece of the spine that MUST work correctly, so it has to be
// exercisable in a unit test.

export function defaultIo() {
  return {
    out: (msg) => console.log(msg),

    prompt: async (question) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },

    openEditor: (file) => {
      const editor = process.env.EDITOR || process.env.VISUAL || 'vi';
      const r = spawnSync(editor, [file], { stdio: 'inherit' });
      return { ok: r.status === 0, code: r.status ?? -1 };
    },
  };
}

function plural(n, word) {
  return n === 1 ? word : `${word}s`;
}
