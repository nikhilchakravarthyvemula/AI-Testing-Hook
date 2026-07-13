// Provenance + confidence schema, ported from testing-agent's
// src/testing_agent/context_layer/models.py (DiscoveryTier + _confidence_for_tier).
//
// Every fact in knowledge.json carries provenance: which source produced it,
// what kind of extraction was used, and how much we trust it. This file is
// the single source of truth for those semantics across the entire system.
// Nothing else may declare its own tier→confidence table (see the indexer's
// models.mjs, which imports confidenceForTier from here rather than mirroring it).

import { createHash } from 'node:crypto';

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
 * Combine two confidence values when the same fact is corroborated by two
 * **independent** sources — the noisy-OR rule: `1 − (1 − a)(1 − b)`.
 *
 * Rationale: two independent 0.90 observations of the same endpoint should
 * make us *more* sure than either alone (→ 0.99), not merely as sure (MAX).
 * Noisy-OR is monotonic, commutative, associative, and stays within [0, 1],
 * so it folds cleanly across any number of sources.
 *
 * INDEPENDENCE MATTERS. This must only be folded across sources whose evidence
 * is not derived from one another. Correlated observations (e.g. two AST passes
 * over the same file) would be double-counted and inflate confidence — collapse
 * those to a single value with MAX *before* combining families here. The
 * Knowledge-Synthesizer (Component 2) enforces exactly that: MAX within a source
 * family, noisy-OR across families.
 *
 * Both inputs are assumed to be in [0, 1] and to describe the *same* fact
 * (agreement is the caller's responsibility — this function does not check it).
 */
export function combineConfidence(a, b) {
  return 1 - (1 - a) * (1 - b);
}

// ── content hashing (staleness / lineage) ──────────────────────────────────

/**
 * Deterministic content hash for a fact's payload — the anchor for staleness
 * detection and incremental (Merkle-style) re-indexing downstream. Equal
 * content ⇒ equal hash across runs and machines, so a fact only counts as
 * "changed" when its content actually changed.
 *
 * Keys are sorted recursively before hashing so that object key order (which
 * carries no meaning in JSON) never perturbs the hash. Returns a 16-char
 * SHA-256 prefix — short enough to store per-fact, wide enough to avoid
 * collisions at our scale.
 *
 * @param {unknown} value  any JSON-serialisable fact payload
 * @returns {string} 16-char lowercase hex
 */
export function contentHashOf(value) {
  return createHash('sha256').update(_canonicalJson(value)).digest('hex').slice(0, 16);
}

/** Stable JSON: object keys sorted recursively; arrays keep their order. */
function _canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(_canonicalJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${_canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}
