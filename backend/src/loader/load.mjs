// Loader: one scan run's output/ directory → Postgres (schema v2).
//
//   node backend/src/loader/load.mjs --run-dir output --app-id demo-app --instance staging-e2e
//
// Idempotent end to end: re-running on the same run-dir changes no row counts.
// Also exported as loadRun() so the backend's ingest API can invoke it.
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { withTransaction, pool } from '../db.mjs';
import {
  loadApis, loadPages, loadRoutes, loadInteractions, loadRedirects, loadModels,
  loadDbSchema, loadDependencies, loadFormFields, loadIndexedTopic,
} from './topics.mjs';
import { projectGraph } from './graph.mjs';

const md5 = (s) => createHash('md5').update(s).digest('hex');

async function readJson(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(await readFile(path, 'utf8'));
}

const TOPIC_LOADERS = {
  apis: loadApis,
  pages: loadPages,
  routes: loadRoutes,
  interactions: loadInteractions,
  redirects: loadRedirects,
  models: loadModels,
  'db-schema': loadDbSchema,
  dependencies: loadDependencies,
  'test-data': loadFormFields,
};

export async function loadRun({ runDir, appId, instanceLabel }) {
  const summary = await readJson(join(runDir, 'run-summary.json'));
  if (!summary?.run_id) {
    throw new Error(`no run-summary.json with run_id under ${runDir}`);
  }

  return withTransaction(async (client) => {
    // ── resolve spine ───────────────────────────────────────────────────────
    const proj = await client.query(
      `SELECT id FROM project WHERE app_id = $1 AND deleted_at IS NULL`, [appId]);
    if (!proj.rows.length) throw new Error(`unknown app_id '${appId}' — run 002_seed.sql or create the project`);
    const projectId = proj.rows[0].id;

    const inst = await client.query(
      `SELECT id FROM project_instance
       WHERE project_id = $1 AND label = $2 AND deleted_at IS NULL`,
      [projectId, instanceLabel]);
    if (!inst.rows.length) throw new Error(`unknown instance '${instanceLabel}' for '${appId}'`);
    const instanceId = inst.rows[0].id;

    // ── scan row ────────────────────────────────────────────────────────────
    const scanRes = await client.query(
      `INSERT INTO scan (id, run_id, project_id, instance_id, status, mode,
         auth_required, target, config, stats, started_at, finished_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12)
       ON CONFLICT (run_id) DO UPDATE SET
         status = EXCLUDED.status, stats = EXCLUDED.stats,
         finished_at = EXCLUDED.finished_at
       RETURNING id`,
      [randomUUID(), summary.run_id, projectId, instanceId,
       summary.scanComplete === false ? 'partial' : 'ok',
       summary.mode ?? null,
       summary.authRequired ? true : null,
       JSON.stringify(summary.target ?? {}),
       JSON.stringify({ configWarnings: summary.configWarnings ?? [] }),
       JSON.stringify({
         stages: summary.stages ?? [], counts: summary.counts ?? {},
         coverage: summary.coverage ?? null, scanComplete: summary.scanComplete ?? null,
         consumable: summary.consumable ?? null,
       }),
       summary.startedAt ?? new Date().toISOString(),
       summary.finishedAt ?? null]
    );
    const scanId = scanRes.rows[0].id;
    const loaded = { run_id: summary.run_id };

    // ── indexed topics → typed tables ───────────────────────────────────────
    const indexedDir = join(runDir, 'indexed_output');
    const index = await readJson(join(indexedDir, 'index.json'));
    let clickGraphPrimary = null;
    for (const [topic, meta] of Object.entries(index?.topics ?? {})) {
      if (!meta?.file) continue; // topic errored during indexing
      const envelope = await readJson(join(indexedDir, meta.file));
      if (!envelope) continue;
      await loadIndexedTopic(client, scanId, topic, envelope);
      if (topic === 'click-graph') {
        clickGraphPrimary = envelope.items?.[0]?.primary ?? null;
        continue;
      }
      const loader = TOPIC_LOADERS[topic];
      if (loader) loaded[topic] = await loader(client, scanId, envelope.items ?? []);
    }

    // ── canonical facts ─────────────────────────────────────────────────────
    const factsFile = await readJson(join(runDir, 'synthesized', 'facts.json'));
    const factIds = new Set();
    for (const f of factsFile?.facts ?? []) {
      const keyText = typeof f.key === 'string' ? f.key : JSON.stringify(f.key ?? {});
      await client.query(
        `INSERT INTO synthesized_fact (id, scan_id, fact_id, kind, key, confidence,
           content_hash, payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
         ON CONFLICT (scan_id, fact_id) DO UPDATE SET
           confidence = EXCLUDED.confidence, content_hash = EXCLUDED.content_hash,
           payload = EXCLUDED.payload`,
        [randomUUID(), scanId, f.factId, f.kind, keyText, f.confidence ?? null,
         f.provenance?.contentHash ?? md5(JSON.stringify(f.attributes ?? {})),
         JSON.stringify({
           attributes: f.attributes ?? {}, provenance: f.provenance ?? {},
           equivalenceGroup: f.equivalenceGroup ?? [], conflicts: f.conflicts ?? [],
         })]
      );
      factIds.add(f.factId);
    }
    loaded.facts = factIds.size;

    // ── features + members ──────────────────────────────────────────────────
    const featuresFile = await readJson(join(runDir, 'features', 'features.json'));
    const MEMBER_TYPE = { endpoints: 'endpoint', pages: 'page', interactions: 'interaction',
                          redirects: 'redirect', other: 'other' };
    let featureCount = 0;
    for (const feat of featuresFile?.features ?? []) {
      const naturalKey = md5(
        `${feat.signal ?? ''}|${[...(feat.entrypoints ?? [])].sort().join(',')}`);
      const { rows } = await client.query(
        `INSERT INTO feature (id, scan_id, feature_id, name, signal, summary,
           natural_key, confidence, member_count, entrypoints, coverage)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
         ON CONFLICT (scan_id, feature_id) DO UPDATE SET
           name = EXCLUDED.name, member_count = EXCLUDED.member_count,
           coverage = EXCLUDED.coverage
         RETURNING id`,
        [randomUUID(), scanId, feat.featureId, feat.name ?? null, feat.signal ?? null,
         feat.summary ?? null, naturalKey, feat.confidence ?? null,
         feat.memberCount ?? null, feat.entrypoints ?? null,
         JSON.stringify(feat.coverage ?? {})]
      );
      const featureUuid = rows[0].id;
      for (const [bucket, memberType] of Object.entries(MEMBER_TYPE)) {
        for (const factId of feat.members?.[bucket] ?? []) {
          if (!factIds.has(factId)) continue; // no dangling FK — fact missing from facts.json
          await client.query(
            `INSERT INTO feature_member (feature_id, scan_id, member_type, member_ref)
             VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
            [featureUuid, scanId, memberType, factId]);
        }
      }
      featureCount++;
    }
    loaded.features = featureCount;

    // ── gaps + lifecycle threads ────────────────────────────────────────────
    const gapsFile = await readJson(join(runDir, 'gaps', 'gaps.json'));
    let gapCount = 0;
    for (const g of gapsFile?.gaps ?? []) {
      const subjectFactId =
        g.subject?.factId && factIds.has(g.subject.factId) ? g.subject.factId : null;
      const threadKey =
        `${g.type}#${g.subject?.factId ?? md5(JSON.stringify(g.subject ?? {}))}`;
      const thread = await client.query(
        `INSERT INTO gap_thread (id, project_id, natural_key, kind, status,
           first_seen_scan_id, last_seen_scan_id, detail)
         VALUES ($1,$2,$3,$4,'open',$5,$5,$6::jsonb)
         ON CONFLICT (project_id, natural_key) DO UPDATE SET
           last_seen_scan_id = EXCLUDED.last_seen_scan_id, updated_at = now()
         RETURNING id`,
        [randomUUID(), projectId, threadKey, g.type,
         scanId, JSON.stringify({ title: g.title ?? null, severity: g.severity ?? null })]
      );
      await client.query(
        `INSERT INTO gap (id, scan_id, kind, subject_fact_id, subject, priority,
           detail, thread_id)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8)
         ON CONFLICT (scan_id, kind, coalesce(subject_fact_id, subject->>'key'))
         DO UPDATE SET priority = EXCLUDED.priority, detail = EXCLUDED.detail`,
        [randomUUID(), scanId, g.type, subjectFactId,
         JSON.stringify({ ...(g.subject ?? {}), key: g.gapId }),
         g.severity ?? null,
         JSON.stringify({ gapId: g.gapId, title: g.title, detail: g.detail,
                          evidence: g.evidence, recommendation: g.recommendation,
                          priorityScore: g.priority }),
         thread.rows[0].id]
      );
      gapCount++;
    }
    loaded.gaps = gapCount;

    // ── graph projection ────────────────────────────────────────────────────
    if (clickGraphPrimary) {
      loaded.graph = await projectGraph(client, scanId, clickGraphPrimary);
    }

    await client.query(
      `INSERT INTO audit_log (entity_type, entity_id, action, actor, detail)
       VALUES ('scan', $1, 'rescan', 'loader', $2::jsonb)`,
      [scanId, JSON.stringify(loaded)]);

    return loaded;
  });
}

// ── CLI ───────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const arg = (name, dflt) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > -1 ? process.argv[i + 1] : dflt;
  };
  loadRun({
    runDir: arg('run-dir', 'output'),
    appId: arg('app-id', 'demo-app'),
    instanceLabel: arg('instance', 'staging-e2e'),
  })
    .then((loaded) => { console.log(JSON.stringify(loaded, null, 2)); return pool.end(); })
    .catch((err) => { console.error('[loader]', err.message); process.exitCode = 1; return pool.end(); });
}
