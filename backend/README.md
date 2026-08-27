# Backend + Loader

Small test backend for the schema-v2 end-to-end run: a loader that ingests a scan's
`output/` directory into Postgres, and a thin Express API on top (config / ingest /
query slices). No LLM anywhere — runs headless on the VM.

## Layout

```
migrations/001_init.sql        schema v2 (46 tables, PG15+; no extensions needed)
migrations/002_seed.sql        demo project spine (edit app_id/base_url first)
migrations/003_embeddings.sql  optional — only when pgvector is enabled
backend/src/db.mjs             pg pool (DATABASE_URL or PG* env vars)
backend/src/loader/            output/ → DB (idempotent), CLI + importable
backend/src/api/               Express server: config, ingest, query routes
```

## VM setup (once)

```bash
npm install                                   # installs express + pg at repo root

# cloud-sql-proxy in its own tmux window:
./cloud-sql-proxy PROJECT:REGION:INSTANCE --port 5432

export PGPASSWORD=$(gcloud secrets versions access latest --secret=<db-password-secret>)
psql -h 127.0.0.1 -U <user> -d <db> -f migrations/001_init.sql   # expect zero errors
psql -h 127.0.0.1 -U <user> -d <db> -f migrations/002_seed.sql
```

## Load a run

```bash
export DATABASE_URL="postgres://<user>:$PGPASSWORD@127.0.0.1:5432/<db>"
npm run load -- --run-dir output --app-id demo-app --instance staging-e2e
```

Prints per-table load counts. Re-running is a no-op (same counts) — that is the
idempotency check. What it loads: scan row from `run-summary.json`; typed rows from
`indexed_output/*.json` (apis, pages, routes, interactions, redirects, models,
db-schema, dependencies, test-data) with per-item observations; canonical facts;
features + members; gaps (+ project-level `gap_thread` upsert); and the graph
projection from the click-graph topic (`invokes` edges land as
`derivation='inferred'`, everything else `'observed'`).

## Run the API

```bash
DATABASE_URL=... API_KEY=<optional> npm run backend    # :8080
```

| Route | What |
|---|---|
| `GET /healthz` | DB connectivity |
| `GET /api/projects/:appId/config` | scanner config pull — secret *references* only |
| `POST /api/scans/load` `{runDir}` | ingest a finished run (wraps the loader) |
| `GET /api/scans` | recent runs |
| `GET /api/scans/:runId/summary` | scan + per-table counts |
| `GET /api/scans/:runId/features` | feature list |
| `GET /api/scans/:runId/features/:fid/context` | the feature slice (facts + gaps) |
| `GET /api/scans/:runId/gaps` | gaps with thread status |
| `GET /api/scans/:runId/graph/expand?key=<node_key>&depth=2` | recursive-CTE graph walk |

From the laptop, tunnel with `ssh -L 8080:localhost:8080 user@vm` and curl/browse
`http://localhost:8080`.

## Verified

Tested against a clean `pgvector/pgvector:pg16` container: all three migrations apply
with zero errors (48 tables); loader ingests a synthetic run, re-run leaves every row
count unchanged; all query routes return correct slices; graph expand walks 2 hops and
distinguishes observed vs inferred edges.
