// Attribute fusion + conflict surfacing (spec §6).
//
// For every attribute any source reported, pick one canonical value by
// precedence, and — when independent sources materially disagree — record the
// disagreement so the Gap-Analyzer can turn it into a coverage question.
//
// VOLATILE attributes (latency, status counts, sample headers, …) legitimately
// differ on every crawl sample; they still get a fused value but their
// disagreement is suppressed, or it would drown real semantic conflicts.

import { confidenceForTier } from '../../../knowledge-base/schema.mjs';

/**
 * Attributes that vary sample-to-sample at runtime. They get a canonical value
 * (last write / highest tier) but never raise a conflict entry. ~20 fields,
 * matching what real crawls surfaced as noise (spec §6.3).
 */
export const VOLATILE = new Set([
  'avgRequestMs', 'avgResponseBytes', 'statusCounts', 'contentTypes',
  'sampleRequestHeaders', 'sampleResponseHeaders', 'sampleCount', 'samples',
  'triggeredByPages', 'consoleMessages', 'elementText',
  'observedJwtClaims', 'observedAuth', 'queryParamNames',
  'latencyMs', 'responseTimeMs', 'timestamp', 'lastSeen',
  'requestId', 'etag', 'headers', 'cookies',
]);

/**
 * Runtime-authoritative attributes: whatever the live crawler observed wins,
 * regardless of tier ranking (spec §6.1). These are facts about behaviour that
 * only runtime can know.
 */
const RUNTIME_AUTHORITATIVE = new Set([
  'statusCounts', 'contentTypes', 'observedAuth', 'observedJwtClaims',
  'avgRequestMs', 'avgResponseBytes', 'triggeredByPages', 'sampleCount',
  'queryParamNames',
]);

/** Stable JSON for value comparison / grouping (key order made irrelevant). */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Whitespace/case-insensitive equality key for a value (spec §6.2). */
function comparisonKey(value) {
  if (typeof value === 'string') return `s:${value.trim().toLowerCase()}`;
  return `j:${canonicalJson(value)}`;
}

function isEmpty(v) {
  return v === null || v === undefined || (Array.isArray(v) && v.length === 0);
}

/**
 * Fuse the observations' `fields` into one canonical attribute set, surfacing
 * material disagreements as conflicts.
 *
 * @param {import('../../indexer/lib/models.mjs').Observation[]} validObs
 * @returns {{attributes: Object, conflicts: Array}}
 */
export function fuseAttributes(validObs) {
  // attribute -> comparisonKey -> { value, sources:Set, bestTierRank, obsCount, live }
  /** @type {Map<string, Map<string, {value: any, sources: Set<string>, bestTierRank: number, count: number, live: boolean}>>} */
  const perAttr = new Map();

  for (const obs of validObs) {
    const fields = obs.fields ?? {};
    const tierRank = confidenceForTier(obs.discoveryTier);
    const live = obs.discoveryTier === 'live_observed';
    for (const [attr, value] of Object.entries(fields)) {
      if (isEmpty(value)) continue;
      if (!perAttr.has(attr)) perAttr.set(attr, new Map());
      const groups = perAttr.get(attr);
      const ck = comparisonKey(value);
      let g = groups.get(ck);
      if (!g) {
        g = { value, sources: new Set(), bestTierRank: -1, count: 0, live: false };
        groups.set(ck, g);
      }
      g.sources.add(obs.sourceId);
      g.count += 1;
      g.live = g.live || live;
      if (tierRank > g.bestTierRank) { g.bestTierRank = tierRank; g.value = value; }
    }
  }

  const attributes = {};
  const conflicts = [];

  // Sort attribute names for deterministic output.
  for (const attr of [...perAttr.keys()].sort()) {
    const groups = [...perAttr.get(attr).values()];

    // Choose the canonical group: runtime-authoritative → prefer a live group;
    // otherwise highest tier, then most-corroborated, then stable by value.
    const chosen = [...groups].sort((a, b) => rankGroup(attr, b) - rankGroup(attr, a)
      || (canonicalJson(a.value) < canonicalJson(b.value) ? -1 : 1))[0];
    attributes[attr] = chosen.value;

    // A conflict needs ≥2 materially different values from real sources, and
    // the attribute must not be volatile noise.
    if (groups.length >= 2 && !VOLATILE.has(attr)) {
      conflicts.push({
        attribute: attr,
        values: groups
          .map(g => ({ value: g.value, sources: [...g.sources].sort() }))
          .sort((a, b) => (canonicalJson(a.value) < canonicalJson(b.value) ? -1 : 1)),
        resolution: 'kept-highest-tier',
        chosen: true,
      });
    }
  }

  return { attributes, conflicts };
}

/** Score a value-group for canonical selection (higher wins). */
function rankGroup(attr, g) {
  const runtimeBoost = RUNTIME_AUTHORITATIVE.has(attr) && g.live ? 1e6 : 0;
  return runtimeBoost + g.bestTierRank * 100 + g.count;
}
