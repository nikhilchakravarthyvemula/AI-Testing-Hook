// Provenance + confidence schema, ported from testing-agent's
// src/testing_agent/context_layer/models.py (DiscoveryTier + _confidence_for_tier).
//
// Every fact in knowledge.json carries provenance: which source produced it,
// what kind of extraction was used, and how much we trust it. This file is
// the single source of truth for those semantics across the entire system.

// ── enums ──────────────────────────────────────────────────────────────────

/**
 * How an entity was discovered. Drives base confidence.
 * Tiers map roughly to source kinds; some sources can produce
 * entities at multiple tiers (e.g. codebase produces `ast` for
 * Python and `code_regex` for Java).
 */
export const DiscoveryTier = Object.freeze({
  AST:             'ast',              // real AST parse (Python `ast`, `tomllib`)
  CODE_REGEX:      'code_regex',       // regex over source text
  CODE_ONLY:       'code_only',        // filesystem layout only
  SPEC:            'spec',             // declared in an authoritative spec
  LIVE_OBSERVED:   'live_observed',    // observed during runtime / network capture
  DOCS_EXTRACTED:  'docs_extracted',   // pulled from documentation
  DIAGRAM_TEXT:    'diagram_text',     // text extracted from diagrams
  DIAGRAM_IMAGE:   'diagram_image',    // image extracted from diagrams
  USER_ANSWERED:   'user_answered',    // explicitly answered by the user
  GRAPH_EXTRACTED: 'graph_extracted',  // pulled from a knowledge graph (e.g. graphify)
});

// All valid tier values for validation.
export const ALL_TIERS = Object.values(DiscoveryTier);

// ── confidence table ───────────────────────────────────────────────────────

const _CONFIDENCE_BY_TIER = {
  [DiscoveryTier.LIVE_OBSERVED]:   0.95,
  [DiscoveryTier.SPEC]:            0.95,
  [DiscoveryTier.AST]:             0.90,
  [DiscoveryTier.USER_ANSWERED]:   0.85,
  [DiscoveryTier.CODE_REGEX]:      0.70,
  [DiscoveryTier.GRAPH_EXTRACTED]: 0.65,
  [DiscoveryTier.DIAGRAM_TEXT]:    0.60,
  [DiscoveryTier.DOCS_EXTRACTED]:  0.55,
  [DiscoveryTier.DIAGRAM_IMAGE]:   0.45,
  [DiscoveryTier.CODE_ONLY]:       0.40,
};

/**
 * Base confidence per tier — adjustable for staleness / corroboration.
 */
export function confidenceForTier(tier) {
  const value = _CONFIDENCE_BY_TIER[tier];
  if (value === undefined) {
    throw new Error(`Unknown DiscoveryTier: ${tier}`);
  }
  return value;
}

// ── provenance helpers ─────────────────────────────────────────────────────

/**
 * Build an ExtractionProvenance object. Carry this on every entity in
 * knowledge.json so consumers know where each fact came from.
 *
 * @param {Object} opts
 * @param {string} opts.sourceId       e.g. "live-links", "codebase-graphify"
 * @param {string} opts.tier           one of DiscoveryTier values
 * @param {string} opts.extractedBy    e.g. "python_fastapi" (framework-specific extractor)
 * @param {string} [opts.sourceFile]   absolute path to the file the fact came from
 * @param {number} [opts.sourceLineStart]
 * @param {number} [opts.sourceLineEnd]
 * @param {string} [opts.contentHash]  optional content-hash for staleness checks
 * @param {Date}   [opts.extractedAt]  defaults to now
 */
export function provenance({
  sourceId,
  tier,
  extractedBy,
  sourceFile = null,
  sourceLineStart = null,
  sourceLineEnd = null,
  contentHash = '',
  extractedAt = new Date(),
}) {
  if (!ALL_TIERS.includes(tier)) {
    throw new Error(`Invalid DiscoveryTier "${tier}"; must be one of ${ALL_TIERS.join(', ')}`);
  }
  return {
    sourceId,
    tier,
    extractedBy,
    sourceFile,
    sourceLineStart,
    sourceLineEnd,
    contentHash,
    extractedAt: extractedAt.toISOString(),
    confidence: confidenceForTier(tier),
  };
}

/**
 * Combine two confidence values when the same fact is seen by two sources.
 * Conservative: returns the max of the two — not strict Bayesian, but
 * sensible: if any high-confidence source confirms a fact, we trust it.
 * Both sources must agree on the fact (compare by content); this function
 * doesn't check that.
 */
export function combineConfidence(a, b) {
  return Math.max(a, b);
}
