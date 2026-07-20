// C5 — the test-plan-creator (use case S1).
//
// The `plan` stage: turn the per-run knowledge store into the ONE artifact a
// human reviews before anything touches the target app — plan/test-plan.json
// (p0-00 §6). For each feature it makes a single S1 call proposing scenarios,
// then hands the result to deterministic assembly (assemble.mjs) that guards
// against hallucinated targets, de-dupes, flags mutations fail-safe, and prices
// the plan. When the engine can't answer for a feature it falls back to template
// scenarios (template.mjs) — the plan comes out either way, same shape (§3).
//
// Mirrors buildStore (C3): pure-ish async function, { ok, stats, degraded }
// return, engine + logging injected, so the spine wires it exactly as it wires
// the store stage. The connector is injectable (`completeFn`) for deterministic
// tests, the same seam s2.mjs uses.

import fs from 'node:fs';
import path from 'node:path';

import { complete } from '../../infrastructure/model-api-connector/index.mjs';
import { openStore } from '../../context-layer/knowledge-store/store.mjs';

import { SCENARIOS, SYSTEM_PROMPT, buildPrompt } from './lib/schema.mjs';
import { buildTargetIndex, assembleFeature } from './lib/assemble.mjs';
import { templateScenarios } from './lib/template.mjs';

// A1 generation is estimated at ~2 engine calls per scenario (p0-05 §4). Tuned
// once C6's real cost is measured; kept here as the single source of the number.
const A1_CALLS_PER_SCENARIO = 2;

/**
 * @param {object} ctx
 * @param {string} ctx.workspace       run dir (reads store/, writes plan/test-plan.json)
 * @param {string} [ctx.runId]
 * @param {object} [ctx.engine]        { provider, model, maxRequests } for S1
 * @param {(m:string)=>void} [ctx.log]
 * @param {Function} [ctx.completeFn]  injected for tests; defaults to the real connector
 * @returns {Promise<{ ok:true, stats, degraded } | { ok:false, reason }>}
 */
export async function createPlan(ctx) {
  const log = ctx.log ?? (() => {});
  const completeFn = ctx.completeFn ?? complete;

  let opened;
  try {
    opened = openStore(ctx.workspace);
  } catch (e) {
    return { ok: false, reason: e.message };
  }
  const { store } = opened;

  const targetIndex = buildTargetIndex(opened);
  const gapById = new Map(store.gaps.map((g) => [g.gapId, g]));

  const counter = { n: 0 };
  const stats = {
    features: store.features.length,
    scenarios: 0,
    mutations: 0,
    degradedFeatures: 0,
    dropped: { hallucinated: 0, noTarget: 0, duplicate: 0 },
  };
  const degraded = [];
  const planFeatures = [];
  let s1Calls = 0;

  for (const feature of store.features) {
    const featureCtx = opened.featureContext(feature.featureId);

    // ── S1: one call proposing scenarios for this feature ──────────────────
    s1Calls += 1;
    const r = await completeFn({
      useCase: 'S1',
      workspace: ctx.workspace,
      provider: ctx.engine?.provider,
      model: ctx.engine?.model,
      maxRequests: ctx.engine?.maxRequests,
      schema: SCENARIOS,
      system: SYSTEM_PROMPT,
      prompt: buildPrompt(featureCtx),
    });

    let raw;
    let source;
    if (r.ok) {
      raw = Array.isArray(r.json?.scenarios) ? r.json.scenarios : [];
      source = 'llm';
    } else {
      // Engine down or budget spent for this feature — template it (§3).
      raw = templateScenarios(featureCtx);
      source = 'template';
      stats.degradedFeatures += 1;
      degraded.push({
        useCase: 'S1',
        stage: 'plan',
        reason: `scenario ideation unavailable (${r.error}) for feature "${feature.name}"`,
        fallback: 'template scenarios',
      });
    }

    const scenarios = assembleFeature({ feature, raw, targetIndex, gapById, counter, stats });
    planFeatures.push({
      featureId: feature.featureId,
      name: feature.name,
      source,
      scenarios,
    });
    log(`${feature.name}: ${scenarios.length} scenario(s) [${source}]`);
  }

  const allScenarios = planFeatures.flatMap((f) => f.scenarios);
  stats.scenarios = allScenarios.length;
  stats.mutations = allScenarios.filter((s) => s.mutation).length;

  // Plan-level source is "template" only on a FULL engine outage — every feature
  // fell back. A partial outage stays "llm"; the per-feature degradations are
  // recorded in `degraded` and disclosed by the report (p0-00 §6, acceptance 2).
  const source =
    store.features.length > 0 && stats.degradedFeatures === store.features.length
      ? 'template'
      : 'llm';

  const plan = {
    runId: ctx.runId ?? store.runId ?? null,
    createdAt: new Date().toISOString(),
    source,
    features: planFeatures,
    estimates: {
      scenarios: stats.scenarios,
      // S1 calls already spent + the A1 generation still to come (§4).
      llmRequests: s1Calls + stats.scenarios * A1_CALLS_PER_SCENARIO,
    },
    stats,
  };

  const outPath = path.join(ctx.workspace, 'plan', 'test-plan.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(plan, null, 2) + '\n');

  return { ok: true, stats, degraded };
}
