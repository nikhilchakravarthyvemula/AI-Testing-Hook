// C6 — the generation stage (use case A1).
//
// The one agentic stage. For each feature slice of the APPROVED plan, run one
// bounded agent session (runSession, C2b) whose agent reads context through the
// context-server MCP (C4) and writes runnable test files into the workspace.
// Everything the LLM can get wrong has a deterministic backstop:
//
//   session fails / writes nothing / a file won't parse → template that scenario
//
// and every scenario in the plan ends with exactly ONE manifest entry
// (generated | failed-generation) — nothing silently dropped (§1).
//
// Mirrors buildStore/createPlan: async, { ok, stats, degraded } return, engine +
// logging injected, sessionFn injectable for deterministic tests. The spine owns
// the pre-flight (checkpoint approval + planHash gate); this owns the generating.
//
// Spec reconciliation: p0-06 (Draft v1.0) predates OQ-4 — it describes a Python
// `agentic_harness` subprocess with exit codes 3/4/5. OQ-4 (p0-02) resolved C2b
// to an IN-PROCESS Node runSession() returning { ok:false, error }. This module
// is written to that real contract; the flow is otherwise as §2 specifies.

import fs from 'node:fs';
import path from 'node:path';

import { runSession } from '../../infrastructure/model-api-connector/index.mjs';
import { writeMcpConfig } from '../../context-layer/context-server/server.mjs';

import { writeSlices, sliceIsComplete, featureCount } from './lib/slices.mjs';
import { writeTemplateFile } from './lib/template-gen.mjs';
import { parseCheck, rejectFile } from './lib/validate.mjs';
import { readManifest, writeManifest, entriesById, makeEntry } from './lib/manifest.mjs';

const SPEC_SUFFIX = '.spec.mjs';

// One retry per slice, matching the executor's "one retry, infrastructure only"
// rule (p0-07 §6). Set GENERATE_SESSION_RETRIES=0 to disable when a retry costs
// more than it's worth (each attempt draws on the same run budget). Read at call
// time so the env var applies whenever it is set, not only before module load.
function sessionRetries() {
  return Number(process.env.GENERATE_SESSION_RETRIES ?? 1);
}

// Only a TRANSIENT engine failure earns a retry:
//   engine-unavailable — timeout, CLI crash, API blip. Might well succeed next time.
//   budget-exhausted   — never retried: the budget does not grow back, so a second
//                        attempt is guaranteed to fail the same way.
//   honesty-failure    — never retried: the session ran to completion and chose to
//                        write nothing. That usually means something systemic (no
//                        MCP context to work from), which a retry will not fix.
const RETRYABLE = new Set(['engine-unavailable']);

/**
 * @param {object} ctx
 * @param {string} ctx.workspace       run dir (reads plan/, writes tests/)
 * @param {string} [ctx.runId]         stamped into file headers + manifest
 * @param {object} [ctx.engine]        { provider, model, maxRequests }
 * @param {(m:string)=>void} [ctx.log]
 * @param {Function} [ctx.sessionFn]   injected for tests; defaults to runSession
 * @returns {Promise<{ ok:true, stats, degraded } | { ok:false, reason }>}
 */
export async function runGenerate(ctx) {
  const log = ctx.log ?? (() => {});
  const sessionFn = ctx.sessionFn ?? runSession;

  const planPath = path.join(ctx.workspace, 'plan', 'test-plan.json');
  let plan;
  try {
    plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  } catch (e) {
    return { ok: false, reason: `no approved plan to generate from: ${e.message}` };
  }

  // Context-server config (C4), written once — the session's only tool source.
  const mcpConfigPath = writeMcpConfig(ctx.workspace);

  const slices = writeSlices(plan, ctx.workspace);

  // Resume: keep entries from slices still current; everything else is rebuilt.
  const prior = readManifest(ctx.workspace, ctx.runId);
  const priorById = entriesById(prior);

  const entries = [];
  const degraded = [];
  const stats = {
    features: featureCount(slices), batches: slices.length, scenarios: 0,
    generated: 0, templated: 0, failed: 0, skippedResume: 0, slicesResumed: 0,
    sessionRetries: 0,
  };

  for (const slice of slices) {
    stats.scenarios += slice.scenarios.length;

    // ── resume: a still-current slice keeps its files + entries untouched ────
    if (sliceIsComplete(slice, priorById)) {
      for (const sc of slice.scenarios) {
        const e = priorById.get(sc.scenarioId);
        entries.push(e);
        if (e.status === 'generated') stats.generated += 1; else stats.failed += 1;
        stats.skippedResume += 1;
      }
      stats.slicesResumed += 1;
      log(`${slice.label}: resumed (${slice.scenarios.length} scenario(s) unchanged)`);
      continue;
    }

    // ── one session per slice, retried once on a transient failure ───────────
    const { result, filesWritten, attempts } = await runSliceSession({
      sessionFn, workspace: ctx.workspace, slice, mcpConfigPath, runId: ctx.runId,
      engine: ctx.engine, log,
    });
    if (attempts > 1) stats.sessionRetries += 1;

    // Files count whether the session ended ok or not. A session that died
    // mid-run still wrote what it wrote; discarding that to template over it
    // would throw away real work (and real budget) for no reason.
    const written = indexWritten(filesWritten);
    let fellBack = 0;

    for (const sc of slice.scenarios) {
      const entry = resolveScenario({
        workspace: ctx.workspace, slice, scenario: sc, runId: ctx.runId,
        writtenFile: written.get(sc.scenarioId),
      });
      if (entry.generator === 'template') fellBack += 1;
      if (entry.status === 'generated' && entry.generator === 'agent') stats.generated += 1;
      else if (entry.status === 'generated') stats.templated += 1;
      else stats.failed += 1;
      entries.push(entry);
    }

    if (!result.ok) {
      const kept = slice.scenarios.length - fellBack;
      degraded.push({
        useCase: 'A1', stage: 'generate',
        reason: `agent session unavailable (${result.error}) for feature "${slice.label}"` +
          (attempts > 1 ? ` after ${attempts} attempts` : '') +
          (result.detail ? ` — ${result.detail}` : ''),
        // Say what actually survived: "all 6 templated" and "4 kept, 2 templated"
        // are very different outcomes for the reader of the report.
        fallback: kept > 0
          ? `${kept} scenario(s) kept from the partial session, template test(s) for ${fellBack}`
          : `template test(s) for ${fellBack} scenario(s)`,
      });
    } else if (fellBack > 0) {
      degraded.push({
        useCase: 'A1', stage: 'generate',
        reason: `session for "${slice.label}" left ${fellBack} of ${slice.scenarios.length} scenario(s) ungenerated or unparseable`,
        fallback: `template test(s) for ${fellBack} scenario(s)`,
      });
    }
    log(`${slice.label}: ${slice.scenarios.length - fellBack} agent + ${fellBack} template`);
  }

  writeManifest(ctx.workspace, { runId: ctx.runId ?? plan.runId ?? null, entries });
  return { ok: true, stats, degraded };
}

// ── the session, with its one retry ──────────────────────────────────────────

/**
 * Run one slice's session, retrying once on a transient engine failure.
 *
 * Files are accumulated ACROSS attempts, and that is the load-bearing part: each
 * attempt reports only the files that appeared during IT (the honesty diff is
 * before/after per call), so attempt 2 does not re-report what attempt 1 already
 * wrote. Union them and you have everything the slice produced; use only the
 * last attempt's list and a retry would silently template over attempt 1's work.
 *
 * @returns {{ result: object, filesWritten: string[], attempts: number }}
 *   `result` is the LAST attempt's outcome — what the degradation entry describes.
 */
async function runSliceSession({ sessionFn, workspace, slice, mcpConfigPath, runId, engine, log }) {
  const produced = new Set();
  const retries = sessionRetries();
  const maxAttempts = Math.max(1, retries + 1);
  let result;
  let attempts = 0;

  while (attempts < maxAttempts) {
    attempts += 1;
    result = await sessionFn({
      workspace, slice, mcpConfigPath, runId,
      provider: engine?.provider, model: engine?.model, maxRequests: engine?.maxRequests,
    });
    for (const f of result.filesWritten ?? []) produced.add(f);

    if (result.ok || !RETRYABLE.has(result.error)) break;
    if (attempts < maxAttempts) {
      log(`${slice.label}: session failed (${result.error}) — retrying ${attempts}/${retries}`);
    }
  }

  return { result, filesWritten: [...produced], attempts };
}

// ── per-scenario resolution (the backstop cascade) ───────────────────────────

/**
 * Decide one scenario's manifest entry: prefer a parse-clean agent file, else
 * template it (also parse-checked). A file that won't parse is rejected out of
 * the executor's path, never handed downstream as if it were good.
 *
 * `writtenFile` is honoured even when the SESSION failed — a file that exists
 * and parses is real output whatever happened to the session around it. The
 * parse gate below is what makes that safe: a half-written file fails it and
 * templates like any other.
 */
function resolveScenario({ workspace, slice, scenario, runId, writtenFile }) {
  const base = {
    scenarioId: scenario.scenarioId, featureId: slice.featureId,
    kind: scenario.kind, mutation: scenario.mutation, sliceHash: slice.sliceHash,
  };

  // 1. the agent wrote this scenario's file — accept it only if it parses.
  if (writtenFile) {
    const check = parseCheck(workspace, writtenFile);
    if (check.ok) {
      return makeEntry({ ...base, file: writtenFile, generator: 'agent', status: 'generated' });
    }
    rejectFile(workspace, writtenFile);   // move the unparseable file aside, then template
  }

  // 2. template fallback — deterministic, then parse-checked in turn.
  const templFile = writeTemplateFile(workspace, slice.featureId, scenario, runId);
  const templCheck = parseCheck(workspace, templFile);
  if (templCheck.ok) {
    return makeEntry({ ...base, file: templFile, generator: 'template', status: 'generated' });
  }

  // 3. even the template won't parse (should never happen) — fail honestly.
  const rejected = rejectFile(workspace, templFile);
  return makeEntry({ ...base, file: rejected, generator: 'template', status: 'failed-generation' });
}

/** scenarioId → workspace-relative file, from a session's filesWritten. */
function indexWritten(filesWritten) {
  const map = new Map();
  for (const rel of filesWritten ?? []) {
    const nameId = fileScenarioId(rel);
    if (nameId) map.set(nameId, rel);
  }
  return map;
}

/** The scenarioId a filename encodes (filename === <scenarioId>.spec.mjs, §memory). */
function fileScenarioId(rel) {
  const b = path.basename(rel);
  if (b.endsWith(SPEC_SUFFIX)) return b.slice(0, -SPEC_SUFFIX.length);
  return null;
}
