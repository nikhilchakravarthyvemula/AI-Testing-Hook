// Topic: models — data models / DTOs / Pydantic / classes.
//
// Sources:
//   * python-ast       — extracted models[] + classes[]
//   * python-fastapi   — frameworkFacts where kind looks Pydantic-y
//   * graphify         — graph nodes with file_type=code + label looks like a class
//
// Dedup key: `${className}@${sourceFile}` — class name alone collides
// in big repos (two `User` classes in different packages).

import { indexedItem, observation } from '../lib/models.mjs';


/** @param {import('../lib/sources.mjs').LoadedSources} sources */
export function build(sources) {
  /** @type {Map<string, {primary: Object, observations: import('../lib/models.mjs').Observation[]}>} */
  const byKey = new Map();

  // ── python-ast: models (Pydantic / dataclass-like) + classes (everything) ──
  const ast = sources.codeExtractors['python-ast'];
  if (ast) {
    for (const m of ast.models ?? []) {
      const key = `${m.name}@${m.sourceFile ?? ''}`;
      _add(byKey, key, {
        name: m.name,
        kind: 'pydantic_model',
        sourceFile: m.sourceFile,
        fields: m.fields ?? [],
        bases: m.bases ?? [],
      }, {
        sourceId: 'python-ast', discoveryTier: 'ast', sourceFile: m.sourceFile,
      });
    }
    for (const c of ast.classes ?? []) {
      const key = `${c.name}@${c.sourceFile ?? ''}`;
      _add(byKey, key, {
        name: c.name,
        kind: 'class',
        sourceFile: c.sourceFile,
        bases: c.bases ?? [],
        methods: (c.methods ?? []).map(m => m.name ?? m),
      }, {
        sourceId: 'python-ast', discoveryTier: 'ast', sourceFile: c.sourceFile,
      });
    }
  }

  // ── per-framework extractors that record schema refs on endpoints ──
  // (We don't have explicit model entities — just collect schema_ref hints.)
  // Skipped for v1: would need to resolve refs across files, which the
  // python-ast extractor already does well.

  // ── graphify: any node with type that looks class-shaped ──
  const graph = sources.graphifyGraph;
  if (graph?.nodes?.length) {
    for (const n of graph.nodes) {
      if (!_looksLikeClass(n)) continue;
      const sourceFile = n.source_file ?? null;
      const key = `${n.label}@${sourceFile ?? ''}`;
      _add(byKey, key, {
        name: n.label,
        kind: 'graphify-node',
        sourceFile,
        community: n.community,
        nodeId: n.id,
      }, {
        sourceId: 'graphify', discoveryTier: 'graph_extracted', sourceFile,
      });
    }
  }

  return [...byKey.entries()].map(([key, { primary, observations }]) =>
    indexedItem('models', key, primary, observations)
  );
}


// ── helpers ────────────────────────────────────────────────────────────────

function _add(map, key, fields, { sourceId, discoveryTier, sourceFile }) {
  let bucket = map.get(key);
  if (!bucket) {
    bucket = {
      primary: { name: fields.name, kind: fields.kind, sourceFile: fields.sourceFile },
      observations: [],
    };
    map.set(key, bucket);
  }
  bucket.observations.push(observation({ sourceId, discoveryTier, sourceFile, fields }));
  // Prefer pydantic_model > class > graphify-node in primary.kind
  if (_kindRank(fields.kind) > _kindRank(bucket.primary.kind)) {
    bucket.primary.kind = fields.kind;
  }
  bucket.primary.fields ??= fields.fields;
  bucket.primary.bases ??= fields.bases;
}

const _KIND_ORDER = { 'pydantic_model': 3, 'class': 2, 'graphify-node': 1 };
function _kindRank(k) { return _KIND_ORDER[k] ?? 0; }

function _looksLikeClass(node) {
  if (!node.label) return false;
  // Graphify doesn't tag node "type" reliably — heuristic: starts with capital,
  // not a file label (no slashes or dots beyond a single namespace separator).
  if (node.file_type !== 'code') return false;
  const label = node.label;
  if (/^[A-Z][A-Za-z0-9_]*$/.test(label)) return true;
  if (/^[A-Z][A-Za-z0-9_]*\.[A-Z][A-Za-z0-9_]*$/.test(label)) return true;  // ns.Class
  return false;
}
