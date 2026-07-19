// Build the lookup indexes that make the store queryable (p0-03 §3).
//
// These are the difference between "a big JSON blob" and "a store": every
// downstream question — the endpoints of a feature, the gaps of a feature, the
// pages of a feature, the fact behind an identity string — is an O(1) lookup
// instead of a scan. The MCP server (C4), the plan creator (C5), and the report
// (C8) all read through these, so they're built once, here.
//
// `remap` (from S2) rewrites every reference to a merged-away fact to its
// canonical survivor, so no index ever points at a fact that no longer exists.

/**
 * @param {object} args { facts, features, gaps, remap }
 * @returns {{ factsByKey, factsByFeature, gapsByFeature, pagesByFeature, featureIdByFact }}
 */
export function buildIndexes({ facts, features, gaps, remap = {} }) {
  const canonical = (id) => remap[id] ?? id;
  const factById = new Map(facts.map((f) => [f.factId, f]));

  // factsByKey — readable identity ("GET /api/v2/cart", "/cart") → factId, for
  // the queryable kinds. Others remain reachable by factId via the fact list.
  const factsByKey = {};
  for (const f of facts) {
    const key = identityString(f);
    if (key) factsByKey[key] = f.factId;
  }

  // factsByFeature / pagesByFeature — from each feature's member factIds,
  // remapped and dropped-if-vanished.
  const factsByFeature = {};
  const pagesByFeature = {};
  const featureIdByFact = {};
  for (const feature of features) {
    const memberIds = [
      ...(feature.members?.endpoints ?? []),
      ...(feature.members?.pages ?? []),
      ...(feature.members?.interactions ?? []),
      ...(feature.members?.redirects ?? []),
      ...(feature.members?.other ?? []),
    ].map(canonical);

    const present = [...new Set(memberIds)].filter((id) => factById.has(id));
    factsByFeature[feature.featureId] = present;
    for (const id of present) {
      if (!(id in featureIdByFact)) featureIdByFact[id] = feature.featureId;
    }

    pagesByFeature[feature.featureId] = (feature.members?.pages ?? [])
      .map(canonical)
      .map((id) => factById.get(id))
      .filter((f) => f && f.kind === 'page')
      .map((f) => f.key?.pathTemplate)
      .filter(Boolean);
  }

  // gapsByFeature — gaps carry a subject fact, not a feature, so we route each
  // gap through its (remapped) subject fact to the feature that owns it.
  const gapsByFeature = {};
  for (const gap of gaps) {
    const subjectId = canonical(gap.subject?.factId);
    const featureId = featureIdByFact[subjectId];
    if (!featureId) continue;                       // gap on an unassigned fact
    (gapsByFeature[featureId] ??= []).push(gap.gapId);
  }

  return { factsByKey, factsByFeature, gapsByFeature, pagesByFeature, featureIdByFact };
}

/** The human-readable identity of a fact, for factsByKey. */
export function identityString(fact) {
  if (fact.kind === 'endpoint' && fact.key?.method && fact.key?.pathTemplate) {
    return `${fact.key.method} ${fact.key.pathTemplate}`;
  }
  if (fact.kind === 'page' && fact.key?.pathTemplate) {
    return fact.key.pathTemplate;
  }
  return null;   // other kinds are reachable by factId, not by identity string
}
