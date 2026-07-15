// Clustering (spec §5.1 grouping + §5.2 co-occurrence + §5.5 min-size).
//
// Takes per-fact structural keys, fills in keyless facts from the interaction
// graph when unambiguous, groups by key, and demotes too-small clusters to the
// reserved `_unassigned` bucket. Nothing is ever silently dropped.

import { STRONG_SIGNALS } from './feature-key.mjs';

export const UNASSIGNED = '_unassigned';

/**
 * Place keyless facts by co-occurrence with the interaction graph (spec §5.2):
 * a fact with no structural key inherits the feature of the graph neighbours it
 * connects to — but ONLY when every known neighbour agrees (conservative). Never
 * overrides a structural key. Best-effort: if the graph exposes no usable edges,
 * this places nothing and the facts fall through to `_unassigned`.
 *
 * @param {{fact: Object, key: string|null, signal: string|null}[]} entries
 * @param {Object|null} graphFact  the `interaction-graph` fact, if any
 */
function applyCoOccurrence(entries, graphFact) {
  const edges = graphFact?.attributes?.edges;
  if (!Array.isArray(edges) || !edges.length) return;

  // token (factId / key.id / pathTemplate) → featureKey, for structurally-keyed facts.
  const keyByToken = new Map();
  for (const e of entries) {
    if (!e.key) continue;
    for (const tok of factTokens(e.fact)) keyByToken.set(tok, e.key);
  }

  // node → set of neighbour nodes.
  const neighbours = new Map();
  const link = (a, b) => {
    if (a == null || b == null) return;
    if (!neighbours.has(a)) neighbours.set(a, new Set());
    neighbours.get(a).add(b);
  };
  for (const edge of edges) {
    const from = edge.from ?? edge.source ?? edge.a;
    const to = edge.to ?? edge.target ?? edge.b;
    link(from, to);
    link(to, from);
  }

  for (const e of entries) {
    if (e.key) continue;
    const seen = new Set();
    for (const tok of factTokens(e.fact)) {
      for (const nb of neighbours.get(tok) ?? []) {
        const k = keyByToken.get(nb);
        if (k) seen.add(k);
      }
    }
    if (seen.size === 1) {          // unambiguous → inherit
      e.key = [...seen][0];
      e.signal = 'co-occurrence';
    }
  }
}

/** Identity tokens a graph edge might use to name this fact. */
function factTokens(fact) {
  const toks = [fact.factId];
  if (fact.key?.id) toks.push(fact.key.id);
  if (fact.key?.pathTemplate) toks.push(fact.key.pathTemplate);
  return toks.filter(Boolean);
}

/**
 * Group facts into clusters by feature key, after co-occurrence placement and
 * min-size demotion. Returns clusters keyed by featureId; `_unassigned` always
 * exists (even if empty).
 *
 * @param {{fact: Object, key: string|null, signal: string|null}[]} entries
 * @param {{minFeatureSize: number, graphFact: Object|null}} cfg
 * @returns {Map<string, {fact: Object, signal: string, strong: boolean}[]>}
 */
export function clusterByKey(entries, cfg) {
  applyCoOccurrence(entries, cfg.graphFact);

  /** @type {Map<string, {fact: Object, signal: string, strong: boolean}[]>} */
  const clusters = new Map();
  const unassigned = [];

  const push = (key, entry) => {
    if (!clusters.has(key)) clusters.set(key, []);
    clusters.get(key).push(entry);
  };

  for (const e of entries) {
    const member = { fact: e.fact, signal: e.signal ?? 'unassigned', strong: STRONG_SIGNALS.has(e.signal) };
    if (e.key) push(e.key, member);
    else unassigned.push({ ...member, signal: 'unassigned', strong: false });
  }

  // Min-size demotion: a lone fact is not yet a functional area (spec §5.5).
  for (const [key, members] of [...clusters]) {
    if (members.length < cfg.minFeatureSize) {
      clusters.delete(key);
      for (const m of members) unassigned.push({ ...m, signal: 'size-merge', strong: false });
    }
  }

  clusters.set(UNASSIGNED, unassigned);   // always present, even if empty
  return clusters;
}
