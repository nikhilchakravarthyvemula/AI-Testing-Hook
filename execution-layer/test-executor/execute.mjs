// C7 — the execution stage.
//
// Reads the manifest, enforces safe/full mode and the safety floor IN CODE, runs
// each allowed test as a bounded local child process, and records what happened
// per scenario in results/results.json (p0-00 §8). Every manifest entry appears
// in the results exactly once — passed | failed | skipped-mutation | error —
// nothing silently dropped.
//
// Mirrors the other stages: async, { ok, stats, degraded } return, runner
// injectable for deterministic tests. The runner is an interface (runner-child
// today) so a Docker/E2B backend can slot in without touching this file.

import fs from 'node:fs';
import path from 'node:path';

import { classify } from './lib/enforce.mjs';
import { parseAllowlist } from './lib/safety-floor.mjs';
import { runChildProcess } from './lib/runner-child.mjs';
import { resultEntry, summarize, writeResults } from './lib/results.mjs';
import { resolveAuth, authEnv } from './lib/auth.mjs';

const DEFAULT_TIMEOUT_MS = Number(process.env.TEST_TIMEOUT_MS || 120_000);
const DEFAULT_MAX_MINUTES = Number(process.env.EXECUTE_MAX_MINUTES || 60);

/**
 * @param {object} ctx
 * @param {string} ctx.workspace     run dir (reads tests/, plan/, writes results/)
 * @param {string} [ctx.mode]        'safe' (default) | 'full'
 * @param {object} [ctx.target]      { url } → BASE_URL for the tests
 * @param {string} [ctx.runId]
 * @param {Set<string>} [ctx.allowlist]  overrides SAFETY_ALLOWLIST (tests)
 * @param {(m:string)=>void} [ctx.log]
 * @param {Function} [ctx.runnerFn]  injected backend; defaults to runChildProcess
 * @param {number} [ctx.timeoutMs]   per-test timeout
 * @param {number} [ctx.maxMinutes]  stage wall-clock
 * @returns {Promise<{ ok:true, stats, degraded } | { ok:false, reason }>}
 */
export async function runExecute(ctx) {
  const log = ctx.log ?? (() => {});
  const runner = ctx.runnerFn ?? runChildProcess;
  const mode = ctx.mode ?? 'safe';

  const manifest = readJson(path.join(ctx.workspace, 'tests', 'manifest.json'));
  if (!manifest || !Array.isArray(manifest.entries)) {
    return { ok: false, reason: 'no test manifest to execute — run the generate stage first' };
  }
  // The plan carries the title/intent/targets the safety floor reads; the
  // manifest doesn't. Joined by scenarioId. Approved before we got here.
  const plan = readJson(path.join(ctx.workspace, 'plan', 'test-plan.json'));
  if (!plan) return { ok: false, reason: 'no approved plan to enforce the safety floor against' };
  const scenarioById = new Map(
    (plan.features ?? []).flatMap((f) => (f.scenarios ?? []).map((sc) => [sc.scenarioId, sc])),
  );

  const allowlist = ctx.allowlist ?? parseAllowlist(process.env.SAFETY_ALLOWLIST);
  const baseUrl = ctx.target?.url ?? process.env.BASE_URL ?? null;

  // Auth is resolved ONCE for the run, before any test runs: harvesting a token
  // costs a browser launch, and every test needs the same credentials anyway.
  // Missing/stale auth degrades — it never stops the stage (lib/auth.mjs).
  const auth = ctx.auth ?? await resolveAuth({ repoRoot: ctx.repoRoot, baseUrl, log });
  const degraded = [...(auth.degraded ?? [])];

  const config = {
    workspace: ctx.workspace,
    baseUrl,
    timeoutMs: ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    storageState: auth.storageState ?? null,
    authToken: auth.token ?? null,
    env: { ...authEnv(auth), ...(ctx.env ?? {}) },
  };

  const deadline = Date.now() + (ctx.maxMinutes ?? DEFAULT_MAX_MINUTES) * 60_000;
  const entries = [];

  for (const entry of manifest.entries) {
    // Stage wall clock: once past it, remaining entries are honestly marked
    // stage-timeout rather than silently dropped (p0-07 §3).
    if (Date.now() > deadline) {
      entries.push(resultEntry(entry, 'error', { reason: 'stage-timeout' }));
      continue;
    }

    const scenario = scenarioById.get(entry.scenarioId) ?? {};
    const decision = classify(entry, scenario, { mode, allowlist });

    if (decision.decision !== 'run') {
      entries.push(resultEntry(entry, decision.status, { reason: decision.reason }));
      log(`  ${entry.scenarioId}: ${decision.status} (${decision.reason})`);
      continue;
    }

    let r = await runner(entry, config);
    // One retry, only on an INFRASTRUCTURE error (spawn failure) — never on a
    // test failure (that's S5/heal territory, P1).
    if (r.status === 'error' && typeof r.reason === 'string' && r.reason.startsWith('spawn')) {
      log(`  ${entry.scenarioId}: spawn error — retrying once`);
      r = await runner(entry, config);
    }
    entries.push(resultEntry(entry, r.status, { durationMs: r.durationMs, artifacts: r.artifacts, reason: r.reason }));
    log(`  ${entry.scenarioId}: ${r.status}${r.reason ? ` (${r.reason})` : ''} ${r.durationMs ?? 0}ms`);
  }

  const summary = summarize(entries);
  writeResults(ctx.workspace, { runId: ctx.runId ?? manifest.runId ?? null, summary, entries });

  return { ok: true, stats: summary, degraded };
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
