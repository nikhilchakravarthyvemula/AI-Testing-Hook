// Load everything the report renders from — from the run workspace ONLY
// (blank-slate: no previous runs, no history) — into one model the section
// renderers consume.
//
// Defensive on purpose: C8 is the last stage and the report IS the product, so a
// thin or degraded run must still produce a report (p0-08 acceptance 2). Every
// input is optional here; a missing one becomes a null the sections render an
// honest explanation for, never a crash.

import fs from 'node:fs';
import path from 'node:path';

import { readLedger } from '../../../infrastructure/model-api-connector/ledger.mjs';
import { openStore } from '../../../context-layer/knowledge-store/store.mjs';

/**
 * @param {string} workspace
 * @returns {object} the report model (see fields below)
 */
export function gather(workspace) {
  const run = readJson(path.join(workspace, 'run.json')) ?? {};
  const ledger = safe(() => readLedger(workspace), []);
  const plan = readJson(path.join(workspace, 'plan', 'test-plan.json'));
  const manifest = readJson(path.join(workspace, 'tests', 'manifest.json'));
  const results = readJson(path.join(workspace, 'results', 'results.json'));

  // The store throws if absent — a url-only run that failed understand still
  // gets a report, just without §B/§C substance.
  let store = null;
  try { store = openStore(workspace); } catch { store = null; }

  // ── joins used across sections, computed once ─────────────────────────────
  const scenarioById = new Map();
  for (const f of plan?.features ?? []) {
    for (const sc of f.scenarios ?? []) {
      scenarioById.set(sc.scenarioId, { ...sc, featureId: f.featureId, featureName: f.name, featureSource: f.source ?? plan?.source });
    }
  }
  const manifestById = new Map((manifest?.entries ?? []).map((e) => [e.scenarioId, e]));
  const resultById = new Map((results?.entries ?? []).map((e) => [e.scenarioId, e]));

  return {
    workspace, run, ledger, plan, manifest, results, store,
    scenarioById, manifestById, resultById,
    profile: run.profile ?? (run.target?.codebasePath ? 'url+code' : 'url-only'),
    hasCodebase: Boolean(run.target?.codebasePath) || run.profile === 'url+code',
    generatedAt: run.endedAt ?? null,   // stamped by the caller if null (no Date in pure fns)
  };
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function safe(fn, fallback) {
  try { return fn(); } catch { return fallback; }
}
