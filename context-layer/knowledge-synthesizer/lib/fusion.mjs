// Confidence fusion (spec §5.2).
//
// MAX within a source family (correlated evidence, don't double-count) then
// noisy-OR across independent families (corroboration should raise confidence).
// A single-family fact keeps its tier confidence exactly; more independent
// families push it monotonically toward — but never past — 1.

import { combineConfidence, confidenceForTier, ALL_TIERS } from '../../../knowledge-base/schema.mjs';
import { familyOf } from './families.mjs';

/** Round to 6 dp so fused confidences are stable and comparable across runs. */
function round6(x) {
  return Math.round(x * 1e6) / 1e6;
}

/**
 * Fuse a fact's valid observations into a confidence + provenance summary.
 *
 * @param {import('../../indexer/lib/models.mjs').Observation[]} validObs
 *        observations whose discoveryTier is known (unknown tiers are excluded
 *        upstream — spec §6.5 — and must not reach here)
 * @returns {{
 *   confidence: number,
 *   families: {key: string, class: string, sourceIds: string[]}[],
 *   fusion: {method: string, familyCount: number},
 *   tiers: string[],
 *   corroborationCount: number,
 *   highestTier: string|null,
 * }}
 */
export function fuse(validObs) {
  /** @type {Map<string, {key: string, class: string, sourceIds: Set<string>, maxConfidence: number}>} */
  const families = new Map();
  const tiers = new Set();

  for (const obs of validObs) {
    const fam = familyOf(obs);
    let f = families.get(fam.key);
    if (!f) {
      f = { key: fam.key, class: fam.class, sourceIds: new Set(), maxConfidence: 0 };
      families.set(fam.key, f);
    }
    f.sourceIds.add(obs.sourceId);
    f.maxConfidence = Math.max(f.maxConfidence, obs.confidence);
    tiers.add(obs.discoveryTier);
  }

  // Sort families by key so the fold order — and the emitted list — is stable.
  const famArr = [...families.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const confidence = round6(famArr.reduce((acc, f) => combineConfidence(acc, f.maxConfidence), 0));

  const tierList = [...tiers].sort();
  const highestTier = tierList.reduce(
    (best, t) => (best === null || confidenceForTier(t) > confidenceForTier(best) ? t : best),
    /** @type {string|null} */ (null),
  );

  return {
    confidence,
    families: famArr.map(f => ({ key: f.key, class: f.class, sourceIds: [...f.sourceIds].sort() })),
    fusion: { method: 'noisy-or-of-family-max', familyCount: famArr.length },
    tiers: tierList,
    corroborationCount: famArr.length,
    highestTier,
  };
}

/** Is a discoveryTier one the schema recognises? (drives §6.5 exclusion) */
export function isKnownTier(tier) {
  return ALL_TIERS.includes(tier);
}
