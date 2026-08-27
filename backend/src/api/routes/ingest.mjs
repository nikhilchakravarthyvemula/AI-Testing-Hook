// Ingest API — the scanner (or an operator) pushes a completed run into the DB.
// The heavy lifting is the loader; this is its HTTP wrapper.
import { Router } from 'express';
import { query } from '../../db.mjs';
import { loadRun } from '../../loader/load.mjs';

const router = Router();

// POST /api/scans/load  { runDir, appId?, instanceLabel? }
// Loads a finished run's output/ directory (path as seen from this process).
router.post('/scans/load', async (req, res, next) => {
  try {
    const { runDir, appId = 'demo-app', instanceLabel = 'staging-e2e' } = req.body ?? {};
    if (!runDir) return res.status(400).json({ error: 'runDir is required' });
    const loaded = await loadRun({ runDir, appId, instanceLabel });
    res.json({ ok: true, loaded });
  } catch (err) { next(err); }
});

// GET /api/scans — recent runs
router.get('/scans', async (_req, res, next) => {
  try {
    const r = await query(
      `SELECT s.run_id, s.status, s.started_at, s.finished_at, p.app_id, i.label
       FROM scan s
       JOIN project p ON p.id = s.project_id
       JOIN project_instance i ON i.id = s.instance_id
       WHERE s.deleted_at IS NULL
       ORDER BY s.started_at DESC LIMIT 50`);
    res.json({ scans: r.rows });
  } catch (err) { next(err); }
});

export default router;
