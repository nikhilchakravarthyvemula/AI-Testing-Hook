// Ingest API — the scanner (or an operator) pushes a completed run into the DB.
// The heavy lifting is the loader; this is its HTTP wrapper.
import { Router, raw } from 'express';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query } from '../../db.mjs';
import { loadRun } from '../../loader/load.mjs';

const execFileP = promisify(execFile);
const router = Router();

// POST /api/scans/upload?appId=...&instance=...
// Body: application/gzip — a tar.gz of the run's loader-relevant output
// (run-summary.json, indexed_output/, synthesized/, features/, gaps/).
// Extracts to a temp dir, runs the loader, cleans up. This is the remote
// counterpart of /scans/load for scanners that run outside this machine.
router.post('/scans/upload', raw({ type: ['application/gzip', 'application/octet-stream'], limit: '200mb' }),
  async (req, res, next) => {
    let workDir = null;
    try {
      if (!req.body?.length) return res.status(400).json({ error: 'empty body — send a tar.gz' });
      const appId = String(req.query.appId || 'demo-app');
      const instanceLabel = String(req.query.instance || 'staging-e2e');

      workDir = await mkdtemp(join(tmpdir(), 'testo-upload-'));
      const archive = join(workDir, 'run.tar.gz');
      await writeFile(archive, req.body);
      await execFileP('tar', ['-xzf', archive, '-C', workDir]);

      const loaded = await loadRun({ runDir: workDir, appId, instanceLabel });
      res.json({ ok: true, loaded });
    } catch (err) { next(err); }
    finally {
      if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  });

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
