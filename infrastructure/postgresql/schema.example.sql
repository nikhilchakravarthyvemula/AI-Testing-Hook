-- ============================================================================
-- AI Testing Harness — EXAMPLE DB schema (PostgreSQL + pgvector)
-- ----------------------------------------------------------------------------
-- A starting point for brainstorming, NOT final. Everything is run-centric:
-- one `run` = one scan→generate→execute pipeline pass against one target app.
--
-- Layout:
--   A. Target + run lifecycle        (who/when)
--   B. Questionnaire                 (intake config per run)
--   C. Indexed output (knowledge)    (what we discovered — drives generation)
--   D. Generation                    (suites, cases, downloadable artifacts)
--   E. Execution                     (results + per-run metrics)
--   F. Vectors                       (pgvector semantic recall / skill memory)
--   G. Misc (skill-memory, secret refs)
--
-- Convention: heavy/variable nested data stays in JSONB; the fields we filter,
-- join, or aggregate on are promoted to real columns + indexes.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS vector;     -- pgvector
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── enums ───────────────────────────────────────────────────────────────────
CREATE TYPE run_status     AS ENUM ('queued','scanning','generating','executing','done','failed','aborted');
CREATE TYPE stage_kind     AS ENUM ('scan','generate','execute','report');
CREATE TYPE stage_status   AS ENUM ('pending','running','ok','failed','skipped');
CREATE TYPE test_kind      AS ENUM ('api','ui','perf');
CREATE TYPE result_status  AS ENUM ('pass','fail','skip','error');
CREATE TYPE source_tier    AS ENUM ('live_observed','spec_declared','code_inferred','llm_inferred','tribal');

-- ============================================================================
-- A. TARGET + RUN LIFECYCLE
-- ============================================================================

-- The system-under-test (one per app/project we test repeatedly).
CREATE TABLE target_app (   -- [v1]
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        TEXT NOT NULL,
  base_url    TEXT,                       -- live link
  repo_url    TEXT,                       -- git source
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (name)
);

-- One pipeline pass. Almost every other table FKs to this.
CREATE TABLE run (   -- [v1]
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  target_app_id UUID NOT NULL REFERENCES target_app(id) ON DELETE CASCADE,
  status        run_status NOT NULL DEFAULT 'queued',
  trigger       TEXT,                     -- 'cli' | 'cron' | 'ci' | 'webhook'
  base_url      TEXT,                     -- resolved target for this run
  codebase_path TEXT,
  git_sha       TEXT,                     -- commit scanned, if any
  config        JSONB NOT NULL DEFAULT '{}',  -- backend, stages, caps, flags
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ,
  total_ms      INTEGER
);
CREATE INDEX run_by_app   ON run (target_app_id, started_at DESC);
CREATE INDEX run_by_status ON run (status);

-- Per-stage record (mirrors orchestration-layer/pipeline.mjs stages).
CREATE TABLE run_stage (   -- [v1]
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  run_id      UUID NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  stage       stage_kind NOT NULL,
  status      stage_status NOT NULL DEFAULT 'pending',
  started_at  TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  duration_ms INTEGER,
  exit_code   INTEGER,
  error       TEXT,
  UNIQUE (run_id, stage)
);

-- ============================================================================
-- B. QUESTIONNAIRE  (per-run intake / config — what to test + how)
-- ============================================================================
CREATE TABLE questionnaire (   -- [v1]
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  run_id        UUID NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  test_kinds    test_kind[] NOT NULL DEFAULT '{}',  -- which suites to generate
  scope         JSONB DEFAULT '{}',     -- include/exclude paths, sections, depth
  auth_mode     TEXT,                   -- 'none' | 'creds' | 'sso' | 'token'
  creds_ref     TEXT,                   -- Key Vault pointer, NEVER the secret
  exemptions    JSONB DEFAULT '[]',     -- endpoints/actions never to exercise
  sla           JSONB DEFAULT '{}',     -- perf targets: {p95_ms, rps, error_rate}
  answers       JSONB NOT NULL DEFAULT '{}',  -- full freeform Q&A blob
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id)
);

-- ============================================================================
-- C. INDEXED OUTPUT  (the knowledge base for THIS run — feeds generation)
-- ----------------------------------------------------------------------------
-- index.json header → indexed_output; every topic item → indexed_item (generic
-- envelope mirroring IndexedItem); high-value types also denormalized into
-- typed tables so generators can query/join fast.
-- ============================================================================

-- One header per run (= output/indexed_output/index.json).
CREATE TABLE indexed_output (   -- [v1]
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  run_id               UUID NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  generated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  topic_counts         JSONB NOT NULL DEFAULT '{}',  -- {apis: 26, pages: 34, ...}
  sources_contributing JSONB NOT NULL DEFAULT '[]',
  UNIQUE (run_id)
);

-- Generic per-item envelope — every topic (apis, routes, pages, models,
-- redirects, dependencies, interactions, db-schema, mock-data, openapi, ...).
-- IndexedItem shape: {id, topic, primary, observations[], consensus}.
CREATE TABLE indexed_item (   -- [later]
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  run_id       UUID NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  topic        TEXT NOT NULL,            -- 'apis' | 'pages' | 'models' | ...
  item_key     TEXT NOT NULL,            -- stable id within the topic
  primary_data JSONB NOT NULL,           -- the reconciled "best" record
  observations JSONB DEFAULT '[]',       -- per-source raw observations
  consensus    JSONB DEFAULT '{}',       -- agreement/confidence metadata
  source_tier  source_tier,
  confidence   REAL,
  UNIQUE (run_id, topic, item_key)
);
CREATE INDEX idx_item_topic ON indexed_item (run_id, topic);
CREATE INDEX idx_item_primary_gin ON indexed_item USING GIN (primary_data);

-- ── typed: API testing ──────────────────────────────────────────────────────
CREATE TABLE api_endpoint (   -- [v1]
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  run_id        UUID NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  method        TEXT NOT NULL,
  origin        TEXT,                    -- http://host:port
  path          TEXT NOT NULL,           -- /v2/prompts/{id}
  template_path TEXT,                    -- normalized for grouping
  auth_scheme   TEXT,                    -- Bearer | Cookie | none
  is_write      BOOLEAN DEFAULT FALSE,   -- POST/PUT/PATCH/DELETE
  query_params  JSONB DEFAULT '[]',
  path_params   JSONB DEFAULT '[]',
  request_schema  JSONB,                 -- body shape for synthesis
  response_schema JSONB,
  status_codes  INT[] DEFAULT '{}',      -- observed
  source_tier   source_tier,
  confidence    REAL,
  UNIQUE (run_id, method, origin, path)
);
CREATE INDEX idx_api_run ON api_endpoint (run_id);

-- Per-endpoint TEST CONTRACT (api-spec.json after verification).
CREATE TABLE api_contract (   -- [v1]
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  run_id        UUID NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  endpoint_id   UUID REFERENCES api_endpoint(id) ON DELETE CASCADE,
  headers       JSONB DEFAULT '{}',
  request_body  JSONB,
  expected      JSONB,                   -- {status, schema} the test asserts
  verified      BOOLEAN DEFAULT FALSE,   -- passed the phantom/authenticity gate
  UNIQUE (run_id, endpoint_id)
);

-- ── typed: UI testing ───────────────────────────────────────────────────────
CREATE TABLE ui_page (   -- [v1]
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  run_id      UUID NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  url         TEXT NOT NULL,
  final_url   TEXT,
  title       TEXT,
  section     TEXT,
  headings    JSONB DEFAULT '[]',
  forms       JSONB DEFAULT '[]',        -- summary; fields also broken out below
  http_status INTEGER,
  UNIQUE (run_id, url)
);

CREATE TABLE ui_form_field (   -- [later]
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  run_id     UUID NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  page_id    UUID NOT NULL REFERENCES ui_page(id) ON DELETE CASCADE,
  name       TEXT,
  field_type TEXT,                       -- text|email|select|checkbox|...
  selector   TEXT,
  required   BOOLEAN DEFAULT FALSE,
  options    JSONB DEFAULT '[]'          -- for test-data synthesis
);

CREATE TABLE ui_route (   -- [v1]
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  run_id      UUID NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  route_path  TEXT NOT NULL,
  component   TEXT,
  framework   TEXT,
  declared_in TEXT
);

-- click-graph: page → (intent on element) → page, optionally hitting an API.
CREATE TABLE click_edge (   -- [later]
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  run_id           UUID NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  from_page_id     UUID REFERENCES ui_page(id) ON DELETE SET NULL,
  to_page_id       UUID REFERENCES ui_page(id) ON DELETE SET NULL,
  element_text     TEXT,
  element_selector TEXT,
  intent           TEXT,                 -- LLM-annotated ("delete user", ...)
  triggers_api_id  UUID REFERENCES api_endpoint(id) ON DELETE SET NULL
);

-- ── typed: shared (body synthesis + perf baseline) ──────────────────────────
CREATE TABLE data_model (   -- [later]
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  run_id        UUID NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  kind          TEXT,                    -- table | dto | class
  columns       JSONB DEFAULT '[]',
  constraints   JSONB DEFAULT '[]',
  foreign_keys  JSONB DEFAULT '[]',
  relationships JSONB DEFAULT '[]',
  source_tier   source_tier
);

-- Real observed request/response samples (mock-data.json) — also the PERF
-- baseline (observed latency per endpoint).
CREATE TABLE observed_sample (   -- [later]
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  run_id             UUID NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  endpoint_id        UUID REFERENCES api_endpoint(id) ON DELETE CASCADE,
  request_sample     JSONB,
  response_sample    JSONB,
  status_code        INTEGER,
  observed_latency_ms INTEGER
);

-- ============================================================================
-- D. GENERATION  (suites + cases + downloadable artifacts, per run + kind)
-- ============================================================================
CREATE TABLE test_suite (   -- [v1]
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  run_id       UUID NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  kind         test_kind NOT NULL,       -- api | ui | perf
  tool         TEXT,                     -- curl | playwright | jmeter
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  test_count   INTEGER DEFAULT 0,
  output_dir   TEXT,                     -- where the suite was written
  UNIQUE (run_id, kind)
);

CREATE TABLE test_case (   -- [v1]
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  suite_id      UUID NOT NULL REFERENCES test_suite(id) ON DELETE CASCADE,
  run_id        UUID NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  kind          test_kind NOT NULL,
  name          TEXT NOT NULL,
  -- polymorphic target: one of these is set depending on kind
  endpoint_id   UUID REFERENCES api_endpoint(id) ON DELETE SET NULL,  -- api/perf
  page_id       UUID REFERENCES ui_page(id) ON DELETE SET NULL,       -- ui
  method        TEXT,
  path          TEXT,
  request_body  JSONB,
  expected      JSONB,                   -- expected status/schema
  spec          JSONB DEFAULT '{}',      -- kind-specific extras (perf: rps/duration)
  priority      INTEGER DEFAULT 0,
  artifact_id   UUID                     -- → artifact (the runnable script)
);
CREATE INDEX idx_case_suite ON test_case (suite_id);

-- Object-store index for downloadable scripts/reports (curl .sh, .spec.mjs,
-- .jmx, suite.zip, report.html). The blob lives in GCS/S3; this row points at it.
CREATE TABLE artifact (   -- [v1]
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  run_id      UUID NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,             -- curl | playwright | jmeter | report | zip
  filename    TEXT NOT NULL,
  storage_uri TEXT NOT NULL,             -- gs://... or s3://...
  size_bytes  BIGINT,
  sha256      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_artifact_run ON artifact (run_id, kind);

-- ============================================================================
-- E. EXECUTION  (results + metrics, per run)
-- ============================================================================
CREATE TABLE execution (   -- [v1]
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  run_id      UUID NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  suite_id    UUID REFERENCES test_suite(id) ON DELETE CASCADE,
  kind        test_kind NOT NULL,
  env         TEXT,                       -- which environment was hit
  base_url    TEXT,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  exit_code   INTEGER
);

CREATE TABLE test_result (   -- [v1]
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  execution_id    UUID NOT NULL REFERENCES execution(id) ON DELETE CASCADE,
  test_case_id    UUID REFERENCES test_case(id) ON DELETE SET NULL,
  run_id          UUID NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  status          result_status NOT NULL,
  http_status     INTEGER,
  latency_ms      INTEGER,
  repair_attempts INTEGER DEFAULT 0,     -- self-repair loop count
  response_preview TEXT,
  error           TEXT,
  runs_artifact_id UUID REFERENCES artifact(id) ON DELETE SET NULL,  -- full req/resp
  ran_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_result_exec ON test_result (execution_id);
CREATE INDEX idx_result_status ON test_result (run_id, status);

-- Aggregate metrics computed AFTER a run (one row per run per kind, +
-- optionally an overall row with kind = NULL).
CREATE TABLE run_metric (   -- [v1]
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  run_id       UUID NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  execution_id UUID REFERENCES execution(id) ON DELETE CASCADE,
  kind         test_kind,                -- NULL = overall
  total        INTEGER DEFAULT 0,
  passed       INTEGER DEFAULT 0,
  failed       INTEGER DEFAULT 0,
  skipped      INTEGER DEFAULT 0,
  pass_rate    REAL,
  p50_ms       INTEGER,
  p95_ms       INTEGER,
  p99_ms       INTEGER,
  coverage_pct REAL,                     -- endpoints/pages exercised / discovered
  extra        JSONB DEFAULT '{}',       -- rps, error_rate, throughput, ...
  computed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_metric_run ON run_metric (run_id);

-- ============================================================================
-- F. VECTORS  (pgvector — semantic recall, RAG over KB, skill memory)
-- ============================================================================
CREATE TABLE kb_embedding (   -- [later]
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  run_id      UUID REFERENCES run(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,             -- 'api_endpoint' | 'ui_page' | 'data_model' | ...
  entity_id   UUID,
  content     TEXT NOT NULL,             -- the text that was embedded
  embedding   vector(1536),              -- dim depends on the embed model
  model       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_kb_vec ON kb_embedding USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- ============================================================================
-- G. MISC  (learning + secret refs — "things to add later")
-- ============================================================================

-- Module 2/3: learned selectors / heals / flake history, keyed to the app
-- (persists ACROSS runs, unlike everything above).
CREATE TABLE skill_memory (   -- [later]
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  target_app_id UUID NOT NULL REFERENCES target_app(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,           -- 'selector-heal' | 'login-step' | 'flake'
  key           TEXT NOT NULL,
  value         JSONB NOT NULL,
  success_count INTEGER DEFAULT 0,
  fail_count    INTEGER DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (target_app_id, kind, key)
);

-- Pointers to secrets in the vault — NO secret material in the DB.
CREATE TABLE credential_ref (   -- [later]
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  target_app_id UUID NOT NULL REFERENCES target_app(id) ON DELETE CASCADE,
  scheme        TEXT,                    -- bearer | cookie | basic
  secret_ref    TEXT NOT NULL,           -- Key Vault / GCP Secret Manager URI
  UNIQUE (target_app_id, scheme)
);
