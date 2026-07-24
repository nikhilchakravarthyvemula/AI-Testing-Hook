// Shared item shape used by every topic file under output/indexed_output/.
//
// One source bundle can contribute multiple `observations` of the same
// item. The indexer dedupes by stable id, merges observations, and
// computes a `consensus` so consumers can quickly tell "did the LLM and
// the AST agree?" vs "only one source saw this".

/**
 * @typedef {"ast"|"code_regex"|"code_only"|"spec"|"live_observed"|"docs_extracted"|"diagram_text"|"diagram_image"|"user_answered"|"graph_extracted"} DiscoveryTier
 */

/**
 * @typedef {"agreed"|"single-source"|"conflicting"} ConsensusKind
 */

/**
 * Per-source observation of an item.
 * @typedef {Object} Observation
 * @property {string} sourceId           - e.g. "python-fastapi", "crawler", "graphify"
 * @property {DiscoveryTier} discoveryTier
 * @property {number} confidence         - 0..1
 * @property {string} [sourceFile]       - file the fact came from, when available
 * @property {Object} fields             - source-native shape; keep verbose for power users
 */

/**
 * One indexed item — what each topic file holds.
 * @typedef {Object} IndexedItem
 * @property {string} id                 - stable, dedup key (e.g. "GET:/api/v1/users")
 * @property {string} topic              - which topic file this belongs to
 * @property {Object} primary            - canonical view (best fields across observations)
 * @property {Observation[]} observations
 * @property {ConsensusKind} consensus
 */

/**
 * Top-level index summary written to output/indexed_output/index.json.
 * @typedef {Object} IndexSummary
 * @property {string} generatedAt
 * @property {string|null} target
 * @property {Object<string, {file: string, count: number, sources: string[]}>} topics
 */


// ── tier → base confidence (tier → base confidence; owned here) ─────────────

export const TIER_CONFIDENCE = Object.freeze({
  live_observed:   0.95,
  spec:            0.95,
  ast:             0.90,
  user_answered:   0.85,
  code_regex:      0.70,
  graph_extracted: 0.65,
  diagram_text:    0.60,
  docs_extracted:  0.55,
  diagram_image:   0.45,
  code_only:       0.40,
});


// ── consensus inference ───────────────────────────────────────────────────

/**
 * Decide consensus across observations.
 * - single-source: only one source saw this
 * - agreed: 2+ sources, no disagreement on `primary` fields
 * - conflicting: 2+ sources disagree on the primary field(s)
 *
 * Callers pass an `agreementChecker(obsA, obsB) -> boolean` that knows
 * which fields to compare for this topic (e.g. for APIs: same method+path
 * is "agreed"; for routes: same path; etc.).
 *
 * @param {Observation[]} observations
 * @param {(a: Observation, b: Observation) => boolean} [agreementChecker]
 * @returns {ConsensusKind}
 */
export function computeConsensus(observations, agreementChecker) {
  if (observations.length <= 1) return 'single-source';
  if (!agreementChecker) return 'agreed';
  const [first, ...rest] = observations;
  return rest.every(o => agreementChecker(first, o)) ? 'agreed' : 'conflicting';
}


// ── builders ──────────────────────────────────────────────────────────────

/**
 * Build a fresh observation from a source-native fact object.
 * @param {Object} opts
 * @param {string} opts.sourceId
 * @param {DiscoveryTier} opts.discoveryTier
 * @param {string} [opts.sourceFile]
 * @param {Object} opts.fields
 * @param {number} [opts.confidenceOverride]
 * @returns {Observation}
 */
export function observation({ sourceId, discoveryTier, sourceFile, fields, confidenceOverride }) {
  return {
    sourceId,
    discoveryTier,
    confidence: confidenceOverride ?? TIER_CONFIDENCE[discoveryTier] ?? 0.5,
    ...(sourceFile ? { sourceFile } : {}),
    fields,
  };
}

/**
 * @param {string} topic
 * @param {string} id
 * @param {Object} primary
 * @param {Observation[]} observations
 * @param {(a: Observation, b: Observation) => boolean} [agreementChecker]
 * @returns {IndexedItem}
 */
export function indexedItem(topic, id, primary, observations, agreementChecker) {
  return {
    id,
    topic,
    primary,
    observations,
    consensus: computeConsensus(observations, agreementChecker),
  };
}
