// Config API — the scanner pulls its run configuration from here.
// Secrets are never returned: only scheme-prefixed references (env:// | gsm://)
// that the scanner resolves on its own side.
import { Router } from 'express';
import { query } from '../../db.mjs';

const router = Router();

// GET /api/projects/:appId/config
// → project + instances + sources (with credential *references*)
router.get('/projects/:appId/config', async (req, res, next) => {
  try {
    const proj = await query(
      `SELECT id, app_id, name FROM project
       WHERE app_id = $1 AND deleted_at IS NULL`,
      [req.params.appId]
    );
    if (!proj.rows.length) return res.status(404).json({ error: 'unknown app_id' });
    const project = proj.rows[0];

    const [sources, instances] = await Promise.all([
      query(
        `SELECT s.id, s.kind, s.name, s.config, c.purpose AS credential_purpose,
                c.secret_ref
         FROM source s
         LEFT JOIN credential_ref c ON c.id = s.credential_ref_id
         WHERE s.project_id = $1 AND s.deleted_at IS NULL
         ORDER BY s.kind, s.name`,
        [project.id]
      ),
      query(
        `SELECT i.id, i.label,
                jsonb_object_agg(s.kind || ':' || s.name, isv.source_version_id)
                  FILTER (WHERE isv.source_id IS NOT NULL) AS pins
         FROM project_instance i
         LEFT JOIN instance_source_version isv ON isv.instance_id = i.id
         LEFT JOIN source s ON s.id = isv.source_id
         WHERE i.project_id = $1 AND i.deleted_at IS NULL
         GROUP BY i.id, i.label
         ORDER BY i.label`,
        [project.id]
      ),
    ]);

    res.json({ project, sources: sources.rows, instances: instances.rows });
  } catch (err) { next(err); }
});

export default router;
