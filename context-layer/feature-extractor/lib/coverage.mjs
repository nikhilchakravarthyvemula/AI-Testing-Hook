// Per-feature coverage rollup (spec §5.4). A read-only aggregation of the
// gap-analyzer's gaps onto the feature that owns each gap's subject fact. No gap
// is created, mutated, or re-scored here.

import { UNASSIGNED } from './cluster.mjs';

/** A zeroed coverage block (used when gaps.json is absent). */
export function emptyCoverage() {
  return { openGaps: 0, byGapType: {}, highSeverityGaps: 0, testableEndpoints: 0 };
}

/**
 * Roll gaps up onto features by matching `gap.subject.factId` to a feature's
 * member factIds. Gaps whose subject belongs to no feature land on
 * `_unassigned`. Mutates each feature's `coverage` in place and returns the
 * features.
 *
 * @param {Object[]} features   each with `members` (kind→factId[]) and `coverage`
 * @param {Object[]} gaps       gap-analyzer Gap[]
 * @returns {Object[]}
 */
export function rollupCoverage(features, gaps) {
  // factId → owning feature (first match wins; membership is a hard partition).
  const owner = new Map();
  for (const feature of features) {
    for (const ids of Object.values(feature.members)) {
      for (const factId of ids) owner.set(factId, feature);
    }
  }
  const byId = new Map(features.map(f => [f.featureId, f]));
  const unassigned = byId.get(UNASSIGNED);

  for (const gap of gaps) {
    const factId = gap.subject?.factId;
    const feature = (factId && owner.get(factId)) || unassigned;
    if (!feature) continue;
    const cov = feature.coverage;
    cov.openGaps += 1;
    cov.byGapType[gap.type] = (cov.byGapType[gap.type] ?? 0) + 1;
    if (gap.severity === 'high') cov.highSeverityGaps += 1;
  }

  // testableEndpoints is a property of the feature (its endpoint members),
  // surfaced alongside the gap rollup.
  for (const feature of features) {
    feature.coverage.testableEndpoints = feature.members.endpoints.length;
  }
  return features;
}
