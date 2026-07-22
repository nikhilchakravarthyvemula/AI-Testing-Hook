// Splitting the approved plan into generation slices (p0-06 §2.1).
//
// A slice is the unit of generation: one agent session writes exactly its
// scenarios. Historically a slice was a whole feature — but depth-first planning
// (p0-05) makes a feature carry dozens of scenarios, and one session cannot write
// dozens of files inside its turn/time budget. So a feature is BATCHED: its
// scenarios are chunked (GENERATE_BATCH_SIZE, default 8), and each chunk is its
// own slice with its own session. Batches for one feature all write into the same
// tests/<featureId>/ dir; because they run sequentially and every file is named
// <scenarioId>.spec.mjs, the honesty diff (session.mjs) and resume both stay
// correct — each keys on scenarioId + sliceHash, never on the batch boundary.
//
// The sliceHash is what makes resume honest — a slice is only "already done" if
// the scenarios that produced its files are byte-identical to the ones in the
// plan now. Edit a scenario after a partial run and its batch regenerates; leave
// it untouched and a resume skips it.
//
// Slice files are written to plan/slices/<featureId>[-<n>].json so the record of
// what each session was asked to do survives the run (and a human can read it).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Read at call time (not module load) so the env var applies whenever it is set.
function batchSize() {
  return Math.max(1, Number(process.env.GENERATE_BATCH_SIZE || 8));
}

/**
 * Build slices from a validated plan and persist them under plan/slices/.
 * A feature with more than GENERATE_BATCH_SIZE scenarios yields several slices.
 *
 * @param {object} plan       the approved test-plan.json
 * @param {string} workspace  run dir
 * @returns {Array<{ featureId, name, label, batchIndex, batchCount, sliceHash, scenarios }>}
 */
export function writeSlices(plan, workspace) {
  const dir = path.join(workspace, 'plan', 'slices');
  fs.mkdirSync(dir, { recursive: true });
  const size = batchSize();

  const slices = [];
  for (const feature of plan.features ?? []) {
    const scenarios = feature.scenarios ?? [];
    // An empty feature still yields one (empty) slice, so its "nothing to do" is
    // explicit in the slice record rather than a silent absence.
    const batches = scenarios.length ? chunk(scenarios, size) : [[]];
    const batchCount = batches.length;

    batches.forEach((batchScenarios, i) => {
      const slice = {
        featureId: feature.featureId,
        name: feature.name,
        label: batchCount > 1 ? `${feature.name} (batch ${i + 1}/${batchCount})` : feature.name,
        batchIndex: i,
        batchCount,
        sliceHash: hashScenarios(feature.featureId, i, batchScenarios),
        scenarios: batchScenarios,
      };
      const base = batchCount > 1
        ? `${safeName(feature.featureId)}-${i + 1}`
        : safeName(feature.featureId);
      fs.writeFileSync(path.join(dir, `${base}.json`), JSON.stringify(slice, null, 2) + '\n');
      slices.push(slice);
    });
  }
  return slices;
}

/**
 * A slice is skippable on resume iff every one of its scenarios already has a
 * manifest entry stamped with THIS slice's hash. A missing scenario, or an
 * entry from a since-edited slice (or a re-batched one), means regenerate.
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

/** How many distinct features these slices came from — for stats/logging. */
export function featureCount(slices) {
  return new Set(slices.map((s) => s.featureId)).size;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Hash only the content that determines generation — not volatile fields. The
 * batch index is folded in so re-batching (a changed GENERATE_BATCH_SIZE) yields
 * fresh hashes and a clean regenerate rather than a false resume hit.
 */
function hashScenarios(featureId, batchIndex, scenarios) {
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
  const json = JSON.stringify({ featureId, batchIndex, scenarios: canonical });
  return 'sha256:' + crypto.createHash('sha256').update(json).digest('hex');
}

/** featureId → a filesystem-safe basename (feature ids contain ':'). */
export function safeName(featureId) {
  return String(featureId).replace(/[^a-zA-Z0-9._-]+/g, '-');
}
