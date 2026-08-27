// Graph projection: the click-graph topic's single item (nodes + edges with
// prefixed string keys) → graph_node / graph_edge rows. Edges reference nodes
// by uuid; keys are resolved through an in-memory map built as nodes upsert.
// The `invokes` edge comes from LLM intent annotation, so it lands as
// derivation='inferred' with a confidence; everything else was observed.
import { createHash, randomUUID } from 'node:crypto';

const md5_16 = (s) => createHash('md5').update(s).digest('hex').slice(0, 16);

const NODE_GROUPS = [
  ['pages', 'page'],
  ['routes', 'route'],
  ['intents', 'intent'],
  ['forms', 'form'],
  ['apis', 'api'],
];

export async function projectGraph(client, scanId, clickGraphPrimary) {
  const keyToId = new Map();
  let nodeCount = 0;
  let edgeCount = 0;

  for (const [group, nodeType] of NODE_GROUPS) {
    for (const node of clickGraphPrimary?.nodes?.[group] ?? []) {
      const { rows } = await client.query(
        `INSERT INTO graph_node (id, scan_id, node_key, node_type, props)
         VALUES ($1,$2,$3,$4,$5::jsonb)
         ON CONFLICT (scan_id, md5(node_key)) DO UPDATE SET props = EXCLUDED.props
         RETURNING id`,
        [randomUUID(), scanId, node.id, nodeType, JSON.stringify(node)]
      );
      keyToId.set(node.id, rows[0].id);
      nodeCount++;
    }
  }

  let skippedEdges = 0;
  for (const edge of clickGraphPrimary?.edges ?? []) {
    const fromId = keyToId.get(edge.from);
    const toId = keyToId.get(edge.to);
    if (!fromId || !toId) { skippedEdges++; continue; } // dangling key — count, don't fail
    const inferred = edge.relation === 'invokes';
    const props = {};
    for (const k of ['via', 'selector', 'text', 'href']) {
      if (edge[k] != null) props[k] = edge[k];
    }
    const edgeKey = Object.keys(props).length ? md5_16(JSON.stringify(props)) : '';
    await client.query(
      `INSERT INTO graph_edge (id, scan_id, from_node_id, to_node_id, relation,
         edge_key, derivation, confidence, props)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
       ON CONFLICT (scan_id, from_node_id, to_node_id, relation, edge_key)
       DO UPDATE SET props = EXCLUDED.props`,
      [randomUUID(), scanId, fromId, toId, edge.relation, edgeKey,
       inferred ? 'inferred' : 'observed', inferred ? 0.7 : null,
       Object.keys(props).length ? JSON.stringify(props) : null]
    );
    edgeCount++;
  }

  return { nodeCount, edgeCount, skippedEdges };
}
