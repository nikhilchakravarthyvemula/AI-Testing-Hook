// Query API — scoped context slices for the harness / copilot.
// Never returns full dumps: a slice is a feature (or gap list) plus exactly the
// facts, endpoints, and open questions attached to it.
import { Router } from 'express';
import { query } from '../../db.mjs';

const router = Router();

async function scanByRunId(runId) {
  const r = await query(
    `SELECT id, project_id, run_id, status, started_at, finished_at, stats
     FROM scan WHERE run_id = $1 AND deleted_at IS NULL`,
    [runId]
  );
  return r.rows[0] || null;
}

// GET /api/scans/:runId/summary
router.get('/scans/:runId/summary', async (req, res, next) => {
  try {
    const scan = await scanByRunId(req.params.runId);
    if (!scan) return res.status(404).json({ error: 'unknown run_id' });
    const counts = await query(
      `SELECT
         (SELECT count(*) FROM scan_api   WHERE scan_id = $1) AS apis,
         (SELECT count(*) FROM scan_page  WHERE scan_id = $1) AS pages,
         (SELECT count(*) FROM scan_route WHERE scan_id = $1) AS routes,
         (SELECT count(*) FROM scan_interaction WHERE scan_id = $1) AS interactions,
         (SELECT count(*) FROM synthesized_fact WHERE scan_id = $1) AS facts,
         (SELECT count(*) FROM feature    WHERE scan_id = $1) AS features,
         (SELECT count(*) FROM gap        WHERE scan_id = $1) AS gaps,
         (SELECT count(*) FROM graph_node WHERE scan_id = $1) AS graph_nodes,
         (SELECT count(*) FROM graph_edge WHERE scan_id = $1) AS graph_edges`,
      [scan.id]
    );
    res.json({ scan, counts: counts.rows[0] });
  } catch (err) { next(err); }
});

// GET /api/scans/:runId/features
router.get('/scans/:runId/features', async (req, res, next) => {
  try {
    const scan = await scanByRunId(req.params.runId);
    if (!scan) return res.status(404).json({ error: 'unknown run_id' });
    const r = await query(
      `SELECT feature_id, name, natural_key, member_count, entrypoints, coverage
       FROM feature WHERE scan_id = $1 ORDER BY member_count DESC NULLS LAST`,
      [scan.id]
    );
    res.json({ features: r.rows });
  } catch (err) { next(err); }
});

// GET /api/scans/:runId/features/:featureId/context — the feature slice
router.get('/scans/:runId/features/:featureId/context', async (req, res, next) => {
  try {
    const scan = await scanByRunId(req.params.runId);
    if (!scan) return res.status(404).json({ error: 'unknown run_id' });
    const feat = await query(
      `SELECT id, feature_id, name, natural_key, entrypoints, coverage
       FROM feature WHERE scan_id = $1 AND feature_id = $2`,
      [scan.id, req.params.featureId]
    );
    if (!feat.rows.length) return res.status(404).json({ error: 'unknown feature' });
    const feature = feat.rows[0];

    const [facts, gaps] = await Promise.all([
      query(
        `SELECT f.fact_id, f.kind, f.key, f.confidence, f.payload
         FROM feature_member m
         JOIN synthesized_fact f ON f.scan_id = m.scan_id AND f.fact_id = m.member_ref
         WHERE m.feature_id = $1
         ORDER BY f.kind, f.key`,
        [feature.id]
      ),
      query(
        `SELECT kind, subject_fact_id, subject, priority, detail
         FROM gap WHERE scan_id = $1 AND feature_id = $2
         ORDER BY priority`,
        [scan.id, feature.id]
      ),
    ]);

    res.json({ feature, facts: facts.rows, gaps: gaps.rows });
  } catch (err) { next(err); }
});

// GET /api/scans/:runId/gaps
router.get('/scans/:runId/gaps', async (req, res, next) => {
  try {
    const scan = await scanByRunId(req.params.runId);
    if (!scan) return res.status(404).json({ error: 'unknown run_id' });
    const r = await query(
      `SELECT g.kind, g.subject_fact_id, g.subject, g.priority, g.detail,
              f.feature_id AS feature, t.status AS thread_status
       FROM gap g
       LEFT JOIN feature f ON f.id = g.feature_id
       LEFT JOIN gap_thread t ON t.id = g.thread_id
       WHERE g.scan_id = $1
       ORDER BY g.priority, g.kind`,
      [scan.id]
    );
    res.json({ gaps: r.rows });
  } catch (err) { next(err); }
});

// GET /api/scans/:runId/graph/expand?key=api:GET:/api/x&depth=2
router.get('/scans/:runId/graph/expand', async (req, res, next) => {
  try {
    const scan = await scanByRunId(req.params.runId);
    if (!scan) return res.status(404).json({ error: 'unknown run_id' });
    const depth = Math.min(Number(req.query.depth || 2), 4);
    const start = await query(
      `SELECT id FROM graph_node WHERE scan_id = $1 AND md5(node_key) = md5($2)`,
      [scan.id, String(req.query.key || '')]
    );
    if (!start.rows.length) return res.status(404).json({ error: 'unknown node key' });

    const r = await query(
      `WITH RECURSIVE walk AS (
         SELECT e.from_node_id, e.to_node_id, e.relation, e.derivation, e.confidence, 1 AS depth
         FROM graph_edge e WHERE e.scan_id = $1 AND e.from_node_id = $2
         UNION ALL
         SELECT e.from_node_id, e.to_node_id, e.relation, e.derivation, e.confidence, w.depth + 1
         FROM graph_edge e JOIN walk w ON e.from_node_id = w.to_node_id
         WHERE e.scan_id = $1 AND w.depth < $3
       )
       SELECT DISTINCT n.node_key, n.node_type, w.relation, w.derivation, w.confidence, w.depth
       FROM walk w JOIN graph_node n ON n.id = w.to_node_id
       ORDER BY w.depth, n.node_key`,
      [scan.id, start.rows[0].id, depth]
    );
    res.json({ start: req.query.key, depth, neighbors: r.rows });
  } catch (err) { next(err); }
});

export default router;
