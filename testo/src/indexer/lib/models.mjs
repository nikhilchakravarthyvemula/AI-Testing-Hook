// Shared item shape used by every topic file under output/indexed_output/.
//
// One source bundle can contribute multiple `observations` of the same
// item. The indexer dedupes by stable id, merges observations, and
// computes a `consensus` so consumers can quickly tell "did the LLM and
// the AST agree?" vs "only one source saw this".
//
// PROVENANCE IS PER-FACT (per-observation), not per-bundle. Every observation
// carries where it came from (sourceFile + line range, when the source knows)
// and a deterministic contentHash of its payload, so downstream staleness and
// lineage work at the granularity of a single fact rather than a whole source
// dump. Tier→confidence lives in knowledge-base/schema.mjs — the single source
// of truth — not here.

import { confidenceForTier, ALL_TIERS, contentHashOf } from '../../../knowledge-base/schema.mjs';

/** @typedef {import('../../../knowledge-base/schema.mjs').DiscoveryTier} DiscoveryTier */

/**
 * @typedef {"agreed"|"single-source"|"conflicting"} ConsensusKind
 */

/**
 * Per-source observation of an item. Provenance fields describe *this* fact
 * from *this* source; they are null when the source cannot localise it (e.g.
 * a runtime crawler has no source file or line range).
 * @typedef {Object} Observation
 * @property {string} sourceId           - e.g. "python-fastapi", "crawler", "graphify"
 * @property {DiscoveryTier} discoveryTier
 * @property {number} confidence         - 0..1
 * @property {string|null} sourceFile    - file the fact came from, when available
 * @property {number|null} sourceLineStart - 1-based start line, when the source knows it
 * @property {number|null} sourceLineEnd   - 1-based end line, when the source knows it
 * @property {string} contentHash        - 16-char deterministic hash of `fields`
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


// ── per-fact provenance extraction ─────────────────────────────────────────

/**
 * Pull provenance (source file + line range + content hash) off a raw source
 * entity, tolerant of the several shapes our heterogeneous extractors emit:
 *   - camelCase JS bundles:  { sourceFile, sourceLineStart, sourceLineEnd }
 *   - snake_case provenance: { provenance: { source_file, line_start, line_end } }
 *   - python-ast handlers:   { handler: { file, line } }
 *   - flat python nodes:     { file, line, endLine } / { lineno, end_lineno }
 * Any field the source doesn't carry comes back null (never fabricated).
 *
 * @param {Object} entity  a source-native fact object
 * @returns {{sourceFile: string|null, sourceLineStart: number|null, sourceLineEnd: number|null, contentHash: string|null}}
 */
export function provenanceOf(entity) {
  const p = entity?.provenance ?? {};
  const h = entity?.handler ?? {};
  const firstStr = (...vals) => vals.find(v => typeof v === 'string' && v.length > 0) ?? null;
  const firstNum = (...vals) => vals.find(v => Number.isFinite(v)) ?? null;
  return {
    sourceFile: firstStr(
      entity?.sourceFile, entity?.source_file, entity?.file,
      p.source_file, p.sourceFile, h.file,
    ),
    sourceLineStart: firstNum(
      entity?.sourceLineStart, entity?.line_start, entity?.line, entity?.lineno,
      p.line_start, p.lineStart, h.line,
    ),
    sourceLineEnd: firstNum(
      entity?.sourceLineEnd, entity?.line_end, entity?.endLine, entity?.end_lineno,
      p.line_end, p.lineEnd,
    ),
    contentHash: firstStr(entity?.contentHash, entity?.content_hash, p.content_hash, p.contentHash),
  };
}


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
 * Base confidence for a tier, delegating to the single source of truth in
 * schema.mjs but staying tolerant: an unrecognised tier from some future
 * extractor degrades to a neutral 0.5 (with a one-time warning) rather than
 * throwing and aborting the whole index.
 */
const _warnedTiers = new Set();
function _tierConfidence(tier) {
  if (ALL_TIERS.includes(tier)) return confidenceForTier(tier);
  if (!_warnedTiers.has(tier)) {
    _warnedTiers.add(tier);
    console.warn(`[indexer] unknown DiscoveryTier "${tier}" — defaulting confidence to 0.5`);
  }
  return 0.5;
}

/**
 * Build a fresh observation from a source-native fact object. Provenance
 * (sourceFile, line range) is carried through when the source provides it;
 * `contentHash` is always present — derived deterministically from `fields`
 * when the source didn't supply one — so every fact is diffable downstream.
 *
 * @param {Object} opts
 * @param {string} opts.sourceId
 * @param {DiscoveryTier} opts.discoveryTier
 * @param {Object} opts.fields
 * @param {string} [opts.sourceFile]
 * @param {number} [opts.sourceLineStart]
 * @param {number} [opts.sourceLineEnd]
 * @param {string} [opts.contentHash]        - precomputed; else derived from `fields`
 * @param {number} [opts.confidenceOverride]
 * @returns {Observation}
 */
export function observation({
  sourceId,
  discoveryTier,
  fields,
  sourceFile = null,
  sourceLineStart = null,
  sourceLineEnd = null,
  contentHash,
  confidenceOverride,
}) {
  return {
    sourceId,
    discoveryTier,
    confidence: confidenceOverride ?? _tierConfidence(discoveryTier),
    sourceFile: sourceFile ?? null,
    sourceLineStart: sourceLineStart ?? null,
    sourceLineEnd: sourceLineEnd ?? null,
    contentHash: contentHash ?? contentHashOf(fields),
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
