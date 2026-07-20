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

import { writeSlices, sliceIsComplete } from './lib/slices.mjs';
import { writeTemplateFile } from './lib/template-gen.mjs';
import { parseCheck, rejectFile } from './lib/validate.mjs';
import { readManifest, writeManifest, entriesById, makeEntry } from './lib/manifest.mjs';

const SPEC_SUFFIX = '.spec.mjs';

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
    features: slices.length, scenarios: 0,
    generated: 0, templated: 0, failed: 0, skippedResume: 0, slicesResumed: 0,
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
      log(`${slice.name}: resumed (${slice.scenarios.length} scenario(s) unchanged)`);
      continue;
    }

    // ── one session per slice ────────────────────────────────────────────────
    const result = await sessionFn({
      workspace: ctx.workspace, slice, mcpConfigPath, runId: ctx.runId,
      provider: ctx.engine?.provider, model: ctx.engine?.model, maxRequests: ctx.engine?.maxRequests,
    });

    const written = result.ok ? indexWritten(result.filesWritten) : new Map();
    let fellBack = 0;

    for (const sc of slice.scenarios) {
      const entry = resolveScenario({
        workspace: ctx.workspace, slice, scenario: sc, runId: ctx.runId,
        writtenFile: written.get(sc.scenarioId), sessionOk: result.ok,
      });
      if (entry.generator === 'template') fellBack += 1;
      if (entry.status === 'generated' && entry.generator === 'agent') stats.generated += 1;
      else if (entry.status === 'generated') stats.templated += 1;
      else stats.failed += 1;
      entries.push(entry);
    }

    if (!result.ok) {
      degraded.push({
        useCase: 'A1', stage: 'generate',
        reason: `agent session unavailable (${result.error}) for feature "${slice.name}" — ${result.detail ?? ''}`.trim(),
        fallback: `template test(s) for ${slice.scenarios.length} scenario(s)`,
      });
    } else if (fellBack > 0) {
      degraded.push({
        useCase: 'A1', stage: 'generate',
        reason: `session for "${slice.name}" left ${fellBack} of ${slice.scenarios.length} scenario(s) ungenerated or unparseable`,
        fallback: `template test(s) for ${fellBack} scenario(s)`,
      });
    }
    log(`${slice.name}: ${slice.scenarios.length - fellBack} agent + ${fellBack} template`);
  }

  writeManifest(ctx.workspace, { runId: ctx.runId ?? plan.runId ?? null, entries });
  return { ok: true, stats, degraded };
}

// ── per-scenario resolution (the backstop cascade) ───────────────────────────

/**
 * Decide one scenario's manifest entry: prefer a parse-clean agent file, else
 * template it (also parse-checked). A file that won't parse is rejected out of
 * the executor's path, never handed downstream as if it were good.
 */
function resolveScenario({ workspace, slice, scenario, runId, writtenFile, sessionOk }) {
  const base = {
    scenarioId: scenario.scenarioId, featureId: slice.featureId,
    kind: scenario.kind, mutation: scenario.mutation, sliceHash: slice.sliceHash,
  };

  // 1. the agent wrote this scenario's file — accept it only if it parses.
  if (sessionOk && writtenFile) {
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
