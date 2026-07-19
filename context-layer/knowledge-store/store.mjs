// The knowledge-store query library.
//
// Everything downstream reads the store through THESE accessors, never by
// re-parsing knowledge.json. They're written as pure functions of (store, args)
// so the MCP server (C4) can call the exact same code the plan creator (C5) and
// report (C8) do — `featureContext` in particular is THE composite all three
// serve, so it must have one implementation (p0-03 §3, acceptance 3).
//
// `openStore(workspace)` is the convenience wrapper: load once, get the
// accessors bound to that store.

import fs from 'node:fs';
import path from 'node:path';

/** Read <workspace>/store/knowledge.json. */
export function load(workspace) {
  const p = path.join(workspace, 'store', 'knowledge.json');
  if (!fs.existsSync(p)) {
    throw new Error(`knowledge-store: no store at ${p} — run the store stage first`);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/** Load once and bind the accessors to that store. */
export function openStore(workspace) {
  const store = load(workspace);
  return {
    store,
    listFeatures: () => listFeatures(store),
    getFeature: (idOrName) => getFeature(store, idOrName),
    queryEndpoints: (filter) => queryEndpoints(store, filter),
    listGaps: (filter) => listGaps(store, filter),
    featureContext: (featureId) => featureContext(store, featureId),
  };
}

// ── pure accessors ───────────────────────────────────────────────────────────

export function listFeatures(store) {
  return store.features.map((f) => ({
    featureId: f.featureId,
    name: f.name,
    endpointCount: (store.indexes.factsByFeature[f.featureId] ?? [])
      .filter((id) => factById(store).get(id)?.kind === 'endpoint').length,
    pageCount: (store.indexes.pagesByFeature[f.featureId] ?? []).length,
    gapCount: (store.indexes.gapsByFeature[f.featureId] ?? []).length,
  }));
}

/** Look up a feature by id, or (case-insensitively) by name. */
export function getFeature(store, idOrName) {
  const needle = String(idOrName).toLowerCase();
  return store.features.find(
    (f) => f.featureId.toLowerCase() === needle || f.name?.toLowerCase() === needle,
  ) ?? null;
}

/**
 * The composite every serving path returns: a feature plus its endpoints
 * (confidence-ranked, provenance-tagged), its pages, and its gaps.
 */
export function featureContext(store, featureId) {
  const feature = getFeature(store, featureId);
  if (!feature) return null;
  const id = feature.featureId;
  const facts = factById(store);

  const endpoints = (store.indexes.factsByFeature[id] ?? [])
    .map((fid) => facts.get(fid))
    .filter((f) => f && f.kind === 'endpoint')
    .map(tagEndpoint)
    .sort((a, b) => b.confidence - a.confidence);

  const gapById = new Map(store.gaps.map((g) => [g.gapId, g]));
  const gaps = (store.indexes.gapsByFeature[id] ?? [])
    .map((gid) => gapById.get(gid))
    .filter(Boolean)
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

  return {
    feature: { featureId: id, name: feature.name, summary: feature.summary ?? null },
    endpoints,
    pages: store.indexes.pagesByFeature[id] ?? [],
    gaps,
  };
}

export function queryEndpoints(store, filter = {}) {
  const { method, pathContains, featureId, minConfidence } = filter;
  const facts = factById(store);

  let ids;
  if (featureId) {
    ids = (store.indexes.factsByFeature[featureId] ?? []);
  } else {
    ids = store.facts.map((f) => f.factId);
  }

  return ids
    .map((id) => facts.get(id))
    .filter((f) => f && f.kind === 'endpoint')
    .filter((f) => !method || f.key?.method === method.toUpperCase())
    .filter((f) => !pathContains || (f.key?.pathTemplate ?? '').includes(pathContains))
    .filter((f) => minConfidence == null || (f.confidence ?? 0) >= minConfidence)
    .map(tagEndpoint)
    .sort((a, b) => b.confidence - a.confidence);
}

export function listGaps(store, filter = {}) {
  const { featureId, severity } = filter;
  let gaps;
  if (featureId) {
    const gapById = new Map(store.gaps.map((g) => [g.gapId, g]));
    gaps = (store.indexes.gapsByFeature[featureId] ?? []).map((gid) => gapById.get(gid)).filter(Boolean);
  } else {
    gaps = store.gaps;
  }
  return gaps
    .filter((g) => !severity || g.severity === severity)
    .slice()
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
}

// ── helpers ──────────────────────────────────────────────────────────────────

// Memoize the factId→fact map per store object (built once, reused by accessors).
const _factMaps = new WeakMap();
function factById(store) {
  let m = _factMaps.get(store);
  if (!m) {
    m = new Map(store.facts.map((f) => [f.factId, f]));
    _factMaps.set(store, m);
  }
  return m;
}

/** Endpoint fact reduced to what a consumer needs, with provenance surfaced. */
function tagEndpoint(f) {
  return {
    factId: f.factId,
    method: f.key?.method,
    path: f.key?.pathTemplate,
    confidence: f.confidence ?? 0,
    provenance: {
      families: (f.provenance?.families ?? []).map((x) => x.class),
      corroborationCount: f.provenance?.corroborationCount ?? 1,
      s2: f.provenance?.s2 ?? null,
    },
    attributes: f.attributes ?? {},
  };
}
