// Topic: db-schema — relational tables + columns + relationships.
//
// Source: sources.dbSchema (the merged bundle written by the db-schema
// code-extractor's orchestrator, content-extractor/code-extractors/db-schema/).
// That bundle already
// merged deterministic + LLM findings, with `_sources` on each table
// recording who saw it.
//
// One IndexedItem per table. Observations track which sub-extractors
// (deterministic vs LLM) contributed.

import { indexedItem, observation, provenanceOf } from '../lib/models.mjs';

export const topicName = 'db-schema';


/** @param {import('../lib/sources.mjs').LoadedSources} sources */
export function build(sources) {
  const bundle = sources.dbSchema;
  if (!bundle) return [];

  return (bundle.tables ?? []).map(t => {
    const observations = (t._sources ?? [{ sourceId: 'db-schema', tier: 'ast' }]).map(s => observation({
      sourceId:      s.sourceId === 'deterministic' ? 'db-schema (deterministic)'
                   : s.sourceId === 'llm'           ? 'db-schema (llm)'
                   : 'db-schema',
      discoveryTier: s.tier ?? 'ast',
      ...provenanceOf(t),
      fields:        t,
    }));
    return indexedItem(topicName, (t.table || '').toLowerCase(), _primaryFromTable(t), observations);
  });
}


function _primaryFromTable(t) {
  return {
    id:                t.table,
    table:             t.table,
    className:         t.className,
    sourceFile:        t.sourceFile,
    framework:         t.framework ?? null,
    columnCount:       (t.columns ?? []).length,
    primaryKeyColumns: t.primaryKeyColumns ?? [],
    uniqueColumns:     t.uniqueColumns ?? [],
    indexedColumns:    t.indexedColumns ?? [],
    foreignKeys: (t.columns ?? [])
      .filter(c => (c.foreignKeys ?? []).length > 0)
      .map(c => ({ column: c.name, references: c.foreignKeys })),
    columns:       t.columns ?? [],
    relationships: t.relationships ?? [],
  };
}
