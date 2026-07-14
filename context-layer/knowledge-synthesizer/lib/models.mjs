// CanonicalFact assembly + envelope builder (spec §7).
//
// The CanonicalFact is THE contract every downstream component reads. factId is
// identity-addressed (derived from the canonical key, stable across runs);
// content drift moves provenance.contentHash, never the factId — so Component 5
// can diff by contentHash without the identity shifting under it.

import { contentHashOf } from '../../../knowledge-base/schema.mjs';

/**
 * @param {{factId: string, kind: string, key: Object, observations: Object[], equivalenceGroup: string[]}} group
 * @param {ReturnType<import('./fusion.mjs').fuse>} fuseResult
 * @param {{attributes: Object, conflicts: Array}} attrResult
 * @returns {Object} CanonicalFact
 */
export function toCanonicalFact(group, fuseResult, attrResult) {
  const { attributes, conflicts } = attrResult;
  const contentHash = contentHashOf({ key: group.key, attributes });
  return {
    factId: group.factId,
    kind: group.kind,
    key: group.key,
    attributes,
    confidence: fuseResult.confidence,
    provenance: {
      families: fuseResult.families,
      fusion: fuseResult.fusion,
      tiers: fuseResult.tiers,
      corroborationCount: fuseResult.corroborationCount,
      highestTier: fuseResult.highestTier,
      contentHash,
    },
    observations: group.observations,
    equivalenceGroup: [...group.equivalenceGroup].sort(),
    conflicts,
  };
}

/**
 * `generatedAt` reflects the input's vintage (the indexer's run timestamp), not
 * wall-clock, so unchanged input yields a byte-identical file (spec §8) and the
 * timestamp means "how fresh is this data" for downstream lineage.
 *
 * @param {Object} opts
 * @param {string|null} opts.target
 * @param {string[]} opts.sourceTopics
 * @param {Object[]} opts.facts
 * @param {Object} opts.stats
 * @param {string|null} [opts.generatedAt]
 * @returns {Object} the facts.json envelope
 */
export function buildEnvelope({ target, sourceTopics, facts, stats, generatedAt }) {
  return {
    generatedAt: generatedAt ?? new Date().toISOString(),
    target: target ?? null,
    sourceTopics: [...sourceTopics].sort(),
    stats,
    facts,
  };
}
