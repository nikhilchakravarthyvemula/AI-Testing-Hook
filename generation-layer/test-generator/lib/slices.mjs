// Splitting the approved plan into per-feature slices (p0-06 §2.1).
//
// A slice is the unit of generation: one feature + its scenarios + a hash of
// that content. The hash is what makes resume honest — a slice is only "already
// done" if the scenarios that produced its files are byte-identical to the ones
// in the plan now. Edit a scenario after a partial run and its slice regenerates;
// leave it untouched and a resume skips it.
//
// Slice files are written to plan/slices/<featureId>.json so the record of what
// each session was asked to do survives the run (and a human can read it).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Build slices from a validated plan and persist them under plan/slices/.
 *
 * @param {object} plan       the approved test-plan.json
 * @param {string} workspace  run dir
 * @returns {Array<{ featureId, name, sliceHash, scenarios }>}
 */
export function writeSlices(plan, workspace) {
  const dir = path.join(workspace, 'plan', 'slices');
  fs.mkdirSync(dir, { recursive: true });

  const slices = [];
  for (const feature of plan.features ?? []) {
    const scenarios = feature.scenarios ?? [];
    const slice = {
      featureId: feature.featureId,
      name: feature.name,
      sliceHash: hashScenarios(feature.featureId, scenarios),
      scenarios,
    };
    fs.writeFileSync(
      path.join(dir, `${safeName(feature.featureId)}.json`),
      JSON.stringify(slice, null, 2) + '\n',
    );
    slices.push(slice);
  }
  return slices;
}

/**
 * A slice is skippable on resume iff every one of its scenarios already has a
 * manifest entry stamped with THIS slice's hash. A missing scenario, or an
 * entry from a since-edited slice, means regenerate.
 *
 * @param {object} slice                    from writeSlices
 * @param {Map<string, object>} entriesById  scenarioId → existing manifest entry
 */
export function sliceIsComplete(slice, entriesById) {
  if (!slice.scenarios.length) return true;   // nothing to generate
  return slice.scenarios.every((sc) => {
    const e = entriesById.get(sc.scenarioId);
    return e && e.sliceHash === slice.sliceHash;
  });
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Hash only the content that determines generation — not volatile fields. */
function hashScenarios(featureId, scenarios) {
  const canonical = scenarios.map((sc) => ({
    scenarioId: sc.scenarioId,
    title: sc.title,
    kind: sc.kind,
    intent: sc.intent,
    mutation: sc.mutation,
    targets: {
      endpoints: [...(sc.targets?.endpoints ?? [])].sort(),
      pages: [...(sc.targets?.pages ?? [])].sort(),
    },
  }));
  const json = JSON.stringify({ featureId, scenarios: canonical });
  return 'sha256:' + crypto.createHash('sha256').update(json).digest('hex');
}

/** featureId → a filesystem-safe basename (feature ids contain ':'). */
export function safeName(featureId) {
  return String(featureId).replace(/[^a-zA-Z0-9._-]+/g, '-');
}
