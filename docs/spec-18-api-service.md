# Spec 18 — web-app API service (ingest + dashboard) & implementation plan

_Target: `web-app/api/` (FastAPI, runs on the GCP VM). The API is the **only** component that
talks to Cloud SQL Postgres (via the Cloud SQL Auth Proxy on the VM) and to the GCS bucket —
no DB/GCS credentials ever exist on a laptop. Serves two consumers: **(1) the local pipeline**
(`byo-llm-poc/ctx.mjs`) pushing scan/test/report data up, and **(2) the dashboard**
(`Dashboard Wireframes (Standalone).html`, 24 screens) reading it back. Data model:
`docs/DATABASE-SCHEMA.md` (finalized). Fills spec-16's reserved `web-app/api/` + P2 debts
(pyproject.toml, Dockerfile)._

> **TL;DR** — One FastAPI service, five API groups: **ingest** (manifest → staged upload →
> finalize; server owns all schema mapping + DLP), **projects/resources**, **scans/tests/
> reports/defects** (the dashboard's read+ops surface, incl. SSE live feeds), **insights**
> (metrics, coverage, feature map, divergence), **admin** (auth/team/keys/schedules/
> housekeeping). Auth = per-project API keys (bcrypt-hashed rows) for machines + session
> auth for the dashboard. Everything is `run_id`-idempotent; deletes follow DATABASE-SCHEMA
> §8 (SQL cascade + app-side GCS/graph cleanup + audit rows).

---

## 1. Architecture

```
┌─ LOCAL (developer laptop) ────────────┐        ┌─ GCP VM ──────────────────────────────┐
│ byo-llm-poc/ctx.mjs                   │        │  nginx (443, TLS) → uvicorn/FastAPI   │
│   scan → output/…                     │ HTTPS  │    web-app/api                        │
│   ctx push  ──────────────────────────┼───────▶│      ├─ ingest / dashboard routers    │
│   (TESTO_API_KEY in local .env;       │        │      ├─ DLP lint (write path)         │
│    NO DSN, NO GCS creds locally)      │        │      ├─ GCS client ──────────────┐    │
└───────────────────────────────────────┘        │      └─ psycopg pool             │    │
┌─ BROWSER (dashboard) ─────────────────┐        │  cloud-sql-proxy (systemd)       │    │
│ 24 wireframe screens ─────────────────┼───────▶│    └── 127.0.0.1:5432 ─────────┐ │    │
└───────────────────────────────────────┘        └────────────────────────────────┼─┼────┘
                                                     Cloud SQL Postgres 16 ◀──────┘ │
                                                     (relational + pgvector;        │
                                                      graph = adjacency+CTE,        │
                                                      NO Apache AGE on Cloud SQL)   │
                                                     GCS bucket  ◀──────────────────┘
                                                      gs://<bucket>/<app_id>/<run_id>/…
```

Locked decisions (from design review): **FastAPI** · **bundle upload, server maps** ·
**blobs through the API** (signed-URL upgrade documented as future) · **API-key auth** for
machines. Scan *execution* stays device-local for interactive/SSO targets (spec-16); the
dashboard's "New Scan"/"Scheduled Scans" drive the **server-side headless** scan path — both
land in the same `scan` rows (`trigger: device | dashboard | schedule`).

## 2. Conventions

| Concern | Rule |
|---|---|
| Base path | `/api/<domain>/<verb-or-id>` |
| Auth | Two token kinds, both `Authorization: Bearer …`, disambiguated by prefix. **Machines:** API key `tk_…` (sha256-hashed rows, DATABASE-SCHEMA §14.2). **Dashboard:** **JWT access token** — HS256 signed with `JWT_SECRET` from env (Secret Manager on the VM; never in code/image), TTL 30 min, claims `{sub, org_id, role, jti, iat, exp}` — plus a **rotating refresh token** (opaque, sha256-hashed in `auth_session`, TTL 14 d, rotated on every refresh; reuse of a rotated token revokes the whole session chain). PyJWT already in the venv |
| SSE auth | `EventSource` can't set headers → live-feed endpoints accept a **one-time ticket**: `POST /api/auth/sse-ticket` → 60 s single-use token passed as `?ticket=` |
| Rate limits | 429 + `Retry-After` on `/api/auth/login`, `/forgot-password`, `/register`; failed logins → `audit_log` |
| Content | JSON; uploads `Content-Encoding: gzip` accepted; blobs multipart (`python-multipart` present) |
| Idempotency | ingest keyed on `run_id` + per-table arbiters (`ON CONFLICT … DO UPDATE`); artifact skip on matching sha256 → client retries are always safe |
| Pagination | `?page=&per_page=` → `{items, page, per_page, total}` (wireframe: 20–25/page) |
| Errors | `{error: {code, message, detail?}}`; 401/403/404/409/422/413; validation via pydantic |
| Live feeds | **SSE** (`sse-starlette` already in venv) for scan monitor + execution console; poll fallback `GET …/status` |
| Soft delete | reads go through `visible_*` semantics; `?include_deleted=1` only for Housekeeping |
| DLP | server write-path lint per DATABASE-SCHEMA §9 (reject/redact `eyJ…`, `Set-Cookie`, Authorization values, password fields); client additionally never uploads `auth-state.json`, `.env` |

## 3. API surface

### 3.1 Ingest (machine → VM; API key) — the local push path

| Endpoint | Purpose |
|---|---|
| `POST /api/ingest/runs` | Open a run. Body: `{run_id, app_id, target:{base_url?, codebase?}, git:{branch?, commit?}?, mode, destructive_mode?, pipeline_version?, tool_manifest_hash?, started_at, finished_at?, stats, manifest:[{path, class: relational\|graph\|artifact, sha256, size}]}`. Server bootstraps the spine (project by `app_id` → source(s) → `source_version` → `project_instance` → `scan` row) and diffs the manifest → `{run_id, upload:[paths still needed], skip:[sha256 matches]}` |
| `PUT /api/ingest/runs/{run_id}/files?path=<repo-rel>` | Upload one manifest file (JSON gzip or multipart blob). Relational/graph JSONs are staged; artifacts stream to GCS + `artifact` row. Repeatable; sha256-verified |
| `POST /api/ingest/runs/{run_id}/finalize` | Server maps staged JSONs → tables (topic loaders, graph loader, generation/execution loaders when present) inside a transaction, runs the DLP lint, writes `audit_log`. Response: `{ok, run_id, tables:{scan_api:21,…}, artifacts:{uploaded,bytes,skipped_unchanged}, skipped:[], errors:[]}` |
| `GET /api/ingest/runs/{run_id}` | Push status: `staged \| finalized \| failed` + per-file state (resume support) |

Staged-then-finalize (not stream-as-you-go) so a half-pushed run is never visible to the
dashboard and finalize is one atomic transaction.

### 3.2 Auth, org & keys (Lane 01: screens 01–05)

**Auth — JWT (env-secret) + refresh session:**

| Endpoint | Behavior |
|---|---|
| `POST /api/auth/register` | Org signup: `{org_name, name, email, password}` → creates `org` + first `super_user` → `{access_token, refresh_token, user}`. Every later user joins by **invite** (screen 04), not open registration |
| `POST /api/auth/accept-invite` | `{invite_token, name, password}` — one-time token from `team_invite` email → creates `app_user` with the invited role → tokens |
| `POST /api/auth/login` | `{email, password}` → `{access_token, refresh_token, user}`; 401 generic ("invalid credentials" — no user-exists oracle); failed attempts rate-limited + audited |
| `POST /api/auth/refresh` | `{refresh_token}` → new `{access_token, refresh_token}` (rotation; old one dead). Reuse of a rotated token = theft signal → revoke session chain, 401 |
| `POST /api/auth/logout` | Revokes the presented refresh token's `auth_session` row (access token simply expires ≤30 min). `POST /api/auth/logout-all` revokes every session for the user |
| `POST /api/auth/forgot-password` | `{email}` → always 202 (no oracle); emails a one-time reset token (TTL 30 min) |
| `POST /api/auth/reset-password` | `{reset_token, new_password}` → sets bcrypt hash, revokes all sessions, 200 → re-login |
| `POST /api/auth/change-password` | authenticated `{current_password, new_password}`; revokes other sessions |
| `POST /api/auth/sso/start` · `GET /api/auth/sso/callback` | 01 SSO path (IdP TBD — open item); callback issues the same JWT+refresh pair |
| `GET /api/auth/me` | current user `{id, name, email, role, org}` (drives chrome + role gates) |
| `POST /api/auth/sse-ticket` | 60 s single-use ticket for `EventSource` live feeds (§2) |

**Team & keys:**

| Endpoint | Serves |
|---|---|
| `GET/POST /api/team/members` · `PATCH/DELETE /api/team/members/{id}` · `POST /api/team/invites` (+resend/revoke) | 04 Team & Roles (5 roles: super_user, admin, developer, tester, reviewer) |
| `GET/POST /api/keys` · `DELETE /api/keys/{id}` | 05 API keys — create returns full key **once**; list shows prefix/scope/last_used; revoke sets `revoked_at` |
| `GET/POST /api/credentials` · `POST /api/credentials/{id}/rotate\|verify` · `DELETE` | 05 Connection credentials (Git PAT/Jira/Confluence/DB) — values → Secret Manager, rows hold refs + linked-resource counts; delete warns downstream usage |

### 3.3 Projects & resources (Lane 02: 02, 06, 07, 07b)

| Endpoint | Serves |
|---|---|
| `GET/POST /api/projects` · `GET/PATCH/DELETE /api/projects/{id}` | 02 hub (cards need per-project rollups: resources, scans, tests, pass-rate, last-scan → one aggregate query), 06 overview header |
| `GET /api/projects/{id}/overview` | 06 — resources summary, last scan card, review-queue count, quick-link states |
| `GET/POST /api/projects/{id}/resources` · `PATCH/DELETE /api/resources/{id}` | 07 table (`source` rows + connection_status/last_verified/used-in counts) |
| `POST /api/resources/test-connection` | 07b — type-specific check (DB: connect + count tables → "schema detected, 14 tables"); Save-gated for DB |
| `GET /api/projects/{id}/activity` | 06/19 recent-activity feed (derived from scans/reports/reviews/audit) |

### 3.4 Scans (Lane 03: 08–11)

| Endpoint | Serves |
|---|---|
| `GET /api/projects/{id}/scans` (+status/trigger/date/search filters, status tab counts) | 08 history |
| `GET /api/scans/{scan_id}` | 09 detail — config snapshot, resources used (`source_bundle` join), tests generated (`test_case` rows w/ classification+review), `Copy as JSON` |
| `GET /api/scans/{scan_id}/logs` | 09/11 raw logs (from GCS `tool-runs/…` artifact; independent failure per wireframe) |
| `POST /api/projects/{id}/scans` | 10 New Scan (server-side headless path): `{resource_ids, scan_type: full\|incremental, branch?, compare_against?, login_mode, advanced?}` → creates queued scan job |
| `POST /api/scans/{scan_id}/rerun` · `POST /api/scans/{scan_id}/cancel` | 08/09 kebab + 11 cancel |
| `GET /api/scans/{scan_id}/events` (SSE) | 11 live monitor — event feed lines, counters `{pages, apis, forms, models}`, per-resource stage, progress %; disconnect ≠ scan failure |

### 3.5 Tests & execution (Lane 04: 12–15)

| Endpoint | Serves |
|---|---|
| `GET /api/projects/{id}/inventory` (facets: type/feature/source-scan/method/coverage; search) | 12 browser — merged endpoints+pages with coverage status (joins `scan_api`/`scan_page`/`feature_member`/`test_case`) |
| `POST /api/projects/{id}/tests/generate` | 12 Generate Tests modal `{item_ids, test_types, negative_cases, auth_variants}` → creates suites/cases with `review_status='pending'` → 13 queue |
| `GET /api/projects/{id}/review-queue` (tabs: needs_attention/auto_approved/all; risk/scan/confidence filters) | 13 |
| `POST /api/tests/{test_id}/review` | 13/14 `{decision: approve\|reject, classification_override?, comment?}` — records a `review_decision` row (AI suggested vs human = 22 divergence source); bulk variant `POST /api/tests/review-bulk` |
| `GET/PATCH /api/tests/{test_id}` | 14 plan review — steps, assertions, edit + `edited_from_ai` diff, prev/next ids |
| `GET /api/projects/{id}/review-decisions` | 13 "Reviewed history / see past overrides" — full read-only decision audit (reviewer, decision, timestamp); the divergence view (22) is this filtered to human ≠ AI |
| `POST /api/projects/{id}/executions` | 15a configure+launch `{suite: all_approved\|ids, environment, parallelism, retry, headless}` → `test_execution_run` |
| `GET /api/executions/{run_id}` · `/events` (SSE) · `POST …/cancel` | 15b in-run table, counters, live console, completion hand-off |

### 3.6 Reports & defects (Lane 05: 16–18)

| Endpoint | Serves |
|---|---|
| `GET /api/projects/{id}/reports` (+filters, compare `?ids=a,b`) | 16 history + Compare |
| `GET /api/reports/{id}` | 17 — KPI band **with vs-prev deltas** (window function over prior report), results table, resources/context, produced summary |
| `GET /api/reports/{id}/export?format=pdf\|allure` | 16/17 export (redirect to GCS artifact or generate-on-demand) |
| `POST /api/reports/{id}/rerun-failed` | 17 → new execution scoped to failed `history_id`s |
| `GET /api/defects/{id}` · `PATCH` (status/severity, note required for wont_fix) | 18 — evidence (screenshot/video artifact URLs), failing assertion, request/response diff, **mapping** {code_file, endpoint, page} from `defect.mapping`, related links |
| `GET /api/artifacts/{id}` | **cross-cutting blob fetch** — auth + `dlp_status` check → 302 to a short-lived (5 min) signed GCS URL. Serves 18 evidence media, 09/11 raw logs, 16/17 exports, 12 sample payloads — the dashboard never gets raw bucket access |

### 3.7 Insights (Lane 06: 03, 19–22)

| Endpoint | Serves |
|---|---|
| `GET /api/org/insights?window=30d` · `GET /api/org/leaderboard` | 03 org tiles/trend/leaderboard |
| `GET /api/projects/{id}/metrics?window=&metric=` | 19 tiles + one-metric trend series |
| `GET /api/projects/{id}/coverage` (rollup + feature-grouped tree; item drawer `GET /api/coverage/items/{id}`; `?export=csv`) | 20 — from `feature`/`feature_member`/`gap`/test joins |
| `GET /api/projects/{id}/feature-map` (`?scan_id=` default latest; nodes/edges/clusters; `GET /api/feature-map/nodes/{key}`) | 21 — `graph_node`/`graph_edge` + recursive-CTE connections (list view = same payload) |
| `GET /api/projects/{id}/review-divergence` (+stats strip, filters, `?export=csv`) | 22 — `review_decision` where human ≠ AI |

### 3.8 Settings & lifecycle (Lane 07: 23–24b)

| Endpoint | Serves |
|---|---|
| `GET/POST /api/projects/{id}/schedules` · `PATCH/DELETE /api/schedules/{id}` · `POST …/run-now` | 23 scheduled scans (cron/daily/weekly/monthly, tz, resources, notify flags; run-now → live monitor) |
| `GET /api/projects/{id}/housekeeping/items` (`?show_soft_deleted=`) | 24 lifecycle table (scans/reports + sizes from artifact sums) |
| `POST /api/housekeeping/soft-delete` · `/restore` · `/hard-delete` (bulk `{ids}`; hard-delete server enforces typed-confirm token) | 24/24b — hard delete = DATABASE-SCHEMA §8: SQL cascade **+ GCS prefix delete + graph cleanup + audit rows** |
| `GET /api/projects/{id}/audit-log` (+filters) | 24 append-only log |
| `GET /api/health` · `GET /api/health/db` | ops |

## 4. Schema addendum (new tables/columns the wireframe requires)

> **➡ APPLIED:** canonical DDL now lives in **`docs/DATABASE-SCHEMA.md` §14** (migration
> `002_addendum.sql`), with three review fixes over the sketch below: API keys are
> **sha256-hashed** (O(1) lookup; bcrypt stays for passwords only), schedule resources use a
> **`schedule_resource` junction** (no `uuid[]` FK), and the scan column is **`trigger_kind`**.
> Where this sketch and §14 differ, §14 wins.

Original sketch (design history — same conventions: soft-delete via partial uniques,
scan-scoped where applicable):

```sql
CREATE TABLE app_user (id uuid PK, org_id uuid NOT NULL, email text NOT NULL, name text,
  password_hash text, sso_subject text, role text NOT NULL
    CHECK (role IN ('super_user','admin','developer','tester','reviewer')),
  status text NOT NULL DEFAULT 'active', last_active_at timestamptz, deleted_at timestamptz);
CREATE UNIQUE INDEX app_user_email_live_uq ON app_user (org_id, email) WHERE deleted_at IS NULL;

CREATE TABLE team_invite (id uuid PK, org_id uuid NOT NULL, email text NOT NULL, role text NOT NULL,
  invited_by uuid REFERENCES app_user(id), created_at timestamptz DEFAULT now(),
  status text NOT NULL DEFAULT 'pending');

CREATE TABLE api_key (id uuid PK, org_id uuid NOT NULL, project_id uuid REFERENCES project(id),
  label text NOT NULL, key_prefix text NOT NULL, key_hash text NOT NULL,        -- bcrypt
  scope text NOT NULL DEFAULT 'full' CHECK (scope IN ('full','read_only')),
  created_by uuid REFERENCES app_user(id), created_at timestamptz DEFAULT now(),
  last_used_at timestamptz, revoked_at timestamptz);

-- connection credentials = secret REFS (values in Secret Manager), extends credential_ref:
ALTER TABLE credential_ref ADD COLUMN cred_type text, ADD COLUMN secret_ref text,
  ADD COLUMN last_verified_at timestamptz, ADD COLUMN verify_status text;

-- resource connection state (wireframe 07):
ALTER TABLE source ADD COLUMN connection_status text, ADD COLUMN last_verified_at timestamptz;

-- scan job fields for dashboard/scheduled triggers:
ALTER TABLE scan ADD COLUMN trigger text NOT NULL DEFAULT 'device'
  CHECK (trigger IN ('device','dashboard','schedule')),
  ADD COLUMN scan_type text, ADD COLUMN triggered_by uuid REFERENCES app_user(id);

CREATE TABLE scan_schedule (id uuid PK, project_id uuid NOT NULL REFERENCES project(id),
  name text NOT NULL, cadence jsonb NOT NULL,            -- {kind: daily|weekly|monthly|cron, …, tz}
  resource_ids uuid[] NOT NULL, scan_config jsonb, enabled boolean DEFAULT true,
  notify_on_completion boolean DEFAULT false, notify_on_failure boolean DEFAULT true,
  next_run_at timestamptz, last_run_scan_id uuid REFERENCES scan(id), deleted_at timestamptz);

-- human review (screens 13/14/22) — AI suggestion vs human decision:
CREATE TABLE review_decision (id uuid PK, test_case_id uuid NOT NULL REFERENCES test_case(id) ON DELETE CASCADE,
  scan_id uuid NOT NULL REFERENCES scan(id) ON DELETE CASCADE,
  ai_classification text, ai_confidence numeric, ai_reasoning text,
  human_decision text NOT NULL CHECK (human_decision IN ('approved','rejected')),
  classification_override text, comment text,
  reviewer uuid REFERENCES app_user(id), decided_at timestamptz DEFAULT now());
ALTER TABLE test_case ADD COLUMN classification text, ADD COLUMN ai_confidence numeric,
  ADD COLUMN review_status text NOT NULL DEFAULT 'pending'
    CHECK (review_status IN ('pending','approved','rejected','auto_approved')),
  ADD COLUMN edited_from_ai boolean DEFAULT false;
```

(Coverage, activity, leaderboard, divergence = queries over existing tables — no new storage.)

## 5. Repo layout

```
web-app/
├── api/
│   ├── main.py                 # FastAPI app, routers, middleware (auth, gzip, request-id)
│   ├── settings.py             # pydantic-settings: DSN, GCS_BUCKET, SECRET_* (env names only)
│   ├── auth.py                 # API-key verify (bcrypt), session auth, role guard
│   ├── dlp.py                  # write-path secret lint (eyJ/Set-Cookie/Authorization/password)
│   ├── gcs.py                  # streaming upload/download, prefix delete
│   ├── db/pool.py              # psycopg3 pool → 127.0.0.1:5432 (proxy)
│   ├── db/loaders/             # server-side mapping: spine.py, topics.py, graph.py,
│   │                           #   generation.py, artifacts.py (ON CONFLICT upserts)
│   ├── routers/                # ingest.py, auth.py, team.py, keys.py, projects.py,
│   │                           #   resources.py, scans.py, tests.py, executions.py,
│   │                           #   reports.py, defects.py, insights.py, settings.py, health.py
│   └── models/                 # pydantic request/response schemas (mirror §3 shapes)
├── migrations/                 # 001_schema.sql (DATABASE-SCHEMA §3–6) + 002_addendum.sql (§4 above)
│   └── migrate.py              # plain ordered psql runner (alembic later if needed)
├── pyproject.toml              # fastapi, uvicorn, psycopg[binary,pool], google-cloud-storage,
│                               #   sse-starlette, pydantic-settings, bcrypt, PyJWT, croniter
├── Dockerfile                  # spec-16 P2 debt
└── .env.example
deploy/
├── runbook.md                  # numbered gcloud checklist (§7)
├── systemd/{testo-api.service, cloud-sql-proxy.service}
└── nginx/testo-api.conf
byo-llm-poc/push.mjs            # local client: manifest builder + uploader (§6)
```

## 6. Local push client (`byo-llm-poc/push.mjs` + ctx.mjs wiring)

- Builds the manifest: walk `output/`, classify each file as `relational | graph | artifact`
  (the `artifact.classification` values — DATABASE-SCHEMA §3 #8), sha256 + size each.
- **Exclusion list (hard):** `output/crawler/auth-state.json` (live session — fingerprint only),
  any `.env`, `output/delegation/**` credentials. `bodies/`+`raw/` upload as artifacts only.
- Flow: `POST /api/ingest/runs` → upload only what the server asks (sha-diff) with gzip/multipart
  → `finalize` → print per-table counts.
- Wiring: new `ctx.mjs push [--run-id]` subcommand + optional `--push` on `scan` (hook after
  `run-summary.json` write, `ctx.mjs:314`) and on `execute` (before emit, `ctx.mjs:1097`).
  Imports `testo/_lib/load-env.mjs` (`loadRepoEnv`) for `TESTO_API_URL`/`TESTO_API_KEY`.
  Preserves the stdout contract (one JSON; logs → stderr/log file). Unknown-flag guard at
  `parseArgs` (`ctx.mjs:1142`) gets the new flags.

## 7. VM runbook (deploy/runbook.md — numbered checklist, summarized)

1. Cloud SQL: Postgres 16 instance, private IP preferred; enable `pgvector`; create db `testo`
   + app user (password in **Secret Manager**; IAM DB auth optional later). *No Apache AGE on
   Cloud SQL* — graph queries use the adjacency tables + recursive CTEs (schema supports).
2. GCS bucket `<org>-testo-artifacts`, lifecycle rules (expire raw traces N days, keep reports).
3. Service account: `roles/cloudsql.client`, `secretmanager.secretAccessor`,
   `storage.objectAdmin` **on that bucket only**.
4. VM (e2-medium, Shielded, OS Login), firewall 443 only + IAP for SSH.
5. `cloud-sql-proxy` systemd unit (SA auth) → `127.0.0.1:5432`.
6. App: python3.12 venv from `pyproject.toml`, `migrate.py`, `testo-api.service` (uvicorn on
   127.0.0.1:8000), nginx TLS (managed cert or certbot) → proxy_pass; SSE buffering off.
7. Secrets pulled at boot from Secret Manager (DSN, bootstrap admin API key) — never in image/.env.
8. Cloud Logging with redaction filter (token prefixes, `eyJ`).

## 8. Implementation phases & verification

| Phase | Scope | Verify |
|---|---|---|
| **P0** (skeleton) | pyproject, app factory, settings, auth middleware, health, migrations runner; local docker Postgres16+pgvector | `docker compose up` → `migrate.py` clean; `curl /api/health/db` ok; bad key → 401 |
| **P1** (ingest relational) | §3.1 endpoints + spine/topic loaders + DLP lint; `push.mjs` | Push real run `run-2026-07-29…` → table counts == `index.json`; re-push → identical counts (idempotent); `SELECT` grep for `eyJ`/`Set-Cookie` → **zero** (DATABASE-SCHEMA §13) |
| **P2** (blobs + finalize) | GCS streaming, artifact rows, staged→finalize atomicity | screenshots/raw in bucket under `app_id/run_id/…`; `skipped_unchanged` on re-push; auth-state.json **absent** from bucket |
| **P3** (dashboard reads) | §3.3–3.7 GET endpoints + aggregates (overview, metrics, coverage, feature-map CTEs, divergence) | Each of the 24 screens' data needs answerable by one listed endpoint; sample queries return the real run's data |
| **P4** (ops writes) | reviews, generate/execute triggers, schedules (croniter loop), housekeeping (incl. GCS+graph cleanup on hard delete), team/keys/credentials | approve→execute→report round-trip; hard-delete: rows gone + prefix gone + 2 audit rows; typed-confirm enforced server-side |
| **P5** (deploy) | Dockerfile, runbook executed, nginx/SSE, Secret Manager wiring | end-to-end from laptop: `ctx push` → dashboard shows the run over HTTPS; SSE monitor streams |

## 9. Risks / open items

- **Python 3.12 on the VM** (not 3.14): psycopg/grpc wheels are guaranteed; the local 3.14 venv
  stays for the pipeline — the API declares its own env via pyproject.
- **Payload growth**: multipart-through-API is fine at ~5 MB/run; >50 MB runs → switch blobs to
  signed URLs (endpoint slot reserved: `POST /api/ingest/runs/{id}/signed-urls`).
- **Server-side scans** (dashboard/schedule trigger) need the headless crawl container
  (spec-16 P4) — until then those triggers return 501 with "device-push only"; ingest path is
  unaffected.
- **SSO provider** for screen 01 unchosen (org IdP?) — email+password ships first, SSO stub.
- **Email delivery** — invites, password reset, and schedule notifications (✉) all need an
  outbound mail path (SMTP relay / SendGrid); until chosen, invite + reset tokens are
  returned to the admin UI for manual sharing (dev mode only, flagged loudly).
- **JWT secret rotation** — `JWT_SECRET` lives in Secret Manager; rotation invalidates all
  access tokens (≤30 min pain) but not refresh sessions; support dual-secret verify window.
- **Roles/permissions matrix** (screen 04 note: "permissions model unconfirmed") — enforce
  role-gates on write endpoints; read granularity later.
- Wireframe items needing product decisions flagged inline: compare-reports shape (16),
  defect video capture source (18), notify channels for schedules (23 ✉/⚠).
