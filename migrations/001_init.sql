-- ============================================================================
-- AI Testing Hook — schema v2 (from DATABASE-SCHEMA.md)
-- Requires: PostgreSQL 15+ (UNIQUE NULLS NOT DISTINCT).
-- Embedding tables live in 003_embeddings.sql (needs pgvector extension).
-- Idempotent: safe to re-run on an empty or partially-created database.
-- ============================================================================

-- ── identity spine (1–8) ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS project (
  id          uuid PRIMARY KEY,
  app_id      text NOT NULL,
  org_id      uuid NOT NULL,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS project_app_id_live_uq ON project (app_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS credential_ref (
  id          uuid PRIMARY KEY,
  project_id  uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  purpose     text NOT NULL,                 -- 'login'|'db_dsn'|'gcs'|'jira'|'confluence'
  secret_ref  text NOT NULL,                 -- 'env://NAME' | 'gsm://projects/<p>/secrets/<s>'
  UNIQUE (project_id, purpose)
);

CREATE TABLE IF NOT EXISTS source (
  id                uuid PRIMARY KEY,
  project_id        uuid NOT NULL REFERENCES project(id) ON DELETE RESTRICT,
  kind              text NOT NULL,           -- 'live_link'|'git_repo'|'openapi'|'database'|'docs'|'jira'|'confluence'
  name              text NOT NULL,
  config            jsonb NOT NULL DEFAULT '{}',
  credential_ref_id uuid REFERENCES credential_ref(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS source_identity_live_uq ON source (project_id, kind, name)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS source_version (
  id            uuid PRIMARY KEY,
  source_id     uuid NOT NULL REFERENCES source(id) ON DELETE RESTRICT,
  version_kind  text NOT NULL,               -- 'git_commit'|'live_deploy'|'spec_version'|'db_snapshot'|'docs_cursor'
  git_branch    text, git_commit text, committed_at timestamptz,
  base_url      text, deploy_marker text, openapi_spec_version text,
  auth_state_fingerprint text,
  observed_at   timestamptz NOT NULL DEFAULT now(),
  content_hash  text,
  meta          jsonb NOT NULL DEFAULT '{}',
  UNIQUE (source_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS source_version_identity_uq ON source_version
  (source_id, version_kind, coalesce(git_commit,''), coalesce(deploy_marker,''), coalesce(content_hash,''));

CREATE TABLE IF NOT EXISTS project_instance (
  id          uuid PRIMARY KEY,
  project_id  uuid NOT NULL REFERENCES project(id) ON DELETE RESTRICT,
  label       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  UNIQUE (project_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS project_instance_label_live_uq ON project_instance (project_id, label)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS instance_source_version (
  instance_id       uuid NOT NULL REFERENCES project_instance(id) ON DELETE CASCADE,
  source_id         uuid NOT NULL REFERENCES source(id) ON DELETE RESTRICT,
  source_version_id uuid NOT NULL,
  PRIMARY KEY (instance_id, source_id),
  UNIQUE (instance_id, source_version_id),
  FOREIGN KEY (source_id, source_version_id)
    REFERENCES source_version (source_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS scan (
  id                 uuid PRIMARY KEY,
  run_id             text NOT NULL UNIQUE,
  project_id         uuid NOT NULL,
  instance_id        uuid NOT NULL,
  status             text NOT NULL,          -- 'running'|'ok'|'partial'|'failed'
  mode               text,                   -- 'skill'|'cli'
  destructive_mode   text,                   -- 'safe'|'full'
  auth_required      boolean,
  target             jsonb NOT NULL,
  config             jsonb NOT NULL DEFAULT '{}',
  pipeline_version   text, tool_manifest_hash text,
  stats              jsonb NOT NULL DEFAULT '{}',
  started_at         timestamptz NOT NULL DEFAULT now(),
  finished_at        timestamptz,
  deleted_at         timestamptz,
  UNIQUE (id, project_id),
  FOREIGN KEY (project_id, instance_id)
    REFERENCES project_instance (project_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS artifact (
  id             uuid PRIMARY KEY,
  scan_id        uuid NOT NULL REFERENCES scan(id) ON DELETE CASCADE,
  classification text NOT NULL,              -- 'relational-source'|'graph-source'|'artifact'
  repo_rel_path  text NOT NULL,
  gcs_uri        text,
  content_type   text, size_bytes bigint,
  sha256         text NOT NULL,
  dlp_status     text NOT NULL DEFAULT 'pending',
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scan_id, repo_rel_path)
);

-- ── scan products (9–32) ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS source_bundle (
  id                uuid PRIMARY KEY,
  scan_id           uuid NOT NULL REFERENCES scan(id) ON DELETE CASCADE,
  source_id         uuid NOT NULL REFERENCES source(id) ON DELETE RESTRICT,
  source_version_id uuid REFERENCES source_version(id) ON DELETE RESTRICT,
  source_kind       text NOT NULL,
  extracted_at      timestamptz, extracted_by text,
  stats             jsonb NOT NULL DEFAULT '{}',
  artifact_id       uuid REFERENCES artifact(id) ON DELETE SET NULL,
  UNIQUE (scan_id, source_id, source_kind)
);

CREATE TABLE IF NOT EXISTS scan_api (
  id uuid PRIMARY KEY,
  scan_id uuid NOT NULL REFERENCES scan(id) ON DELETE CASCADE,
  natural_key text NOT NULL,
  method text NOT NULL, path text NOT NULL, origin text,
  framework text, handler text, operation_id text, summary text, tags text[],
  auth_required boolean, observed_auth jsonb,
  status_counts jsonb, content_types jsonb,
  request_schema_ref text, response_schemas jsonb, parameters jsonb,
  query_param_names text[], sample_count int,
  avg_request_ms numeric, avg_response_bytes numeric, triggered_by_pages text[],
  consensus text,
  UNIQUE (scan_id, natural_key)
);

CREATE TABLE IF NOT EXISTS scan_page (
  id uuid PRIMARY KEY,
  scan_id uuid NOT NULL REFERENCES scan(id) ON DELETE CASCADE,
  url text NOT NULL,
  requested_urls text[],
  url_variants jsonb,
  title text, lang text, section text, nav_status int, phase text, visited boolean,
  form_count int, clickable_count int, iframe_count int, image_count int,
  headings jsonb, meta jsonb,
  screenshot_artifact_id uuid REFERENCES artifact(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS scan_page_url_uq ON scan_page (scan_id, md5(url));

CREATE TABLE IF NOT EXISTS scan_route (
  id uuid PRIMARY KEY, scan_id uuid NOT NULL REFERENCES scan(id) ON DELETE CASCADE,
  path text NOT NULL, frameworks text[], component text, auth_required boolean,
  UNIQUE (scan_id, path)
);

CREATE TABLE IF NOT EXISTS scan_interaction (
  id uuid PRIMARY KEY, scan_id uuid NOT NULL REFERENCES scan(id) ON DELETE CASCADE,
  natural_key text NOT NULL,
  from_page text, to_page text, kind text,
  element_text text, element_selector text, element_tag text,
  intent jsonb, api_call_hint text, navigates_to_path text, is_destructive boolean,
  UNIQUE (scan_id, natural_key)
);

CREATE TABLE IF NOT EXISTS scan_form_field (
  id uuid PRIMARY KEY, scan_id uuid NOT NULL REFERENCES scan(id) ON DELETE CASCADE,
  natural_key text NOT NULL,
  page text, form_id text, form_action text, form_method text, form_intent text,
  field_name text, field_type text, required boolean, placeholder text,
  default_value text,
  autocomplete text,
  UNIQUE (scan_id, natural_key),
  CHECK (field_type IS DISTINCT FROM 'password' OR default_value IS NULL)
);

CREATE TABLE IF NOT EXISTS scan_redirect (
  id uuid PRIMARY KEY, scan_id uuid NOT NULL REFERENCES scan(id) ON DELETE CASCADE,
  from_url text NOT NULL, to_url text NOT NULL, kind text NOT NULL, status int
);
CREATE UNIQUE INDEX IF NOT EXISTS scan_redirect_uq ON scan_redirect
  (scan_id, kind, md5(from_url), md5(to_url));

CREATE TABLE IF NOT EXISTS scan_model (
  id uuid PRIMARY KEY, scan_id uuid NOT NULL REFERENCES scan(id) ON DELETE CASCADE,
  name text NOT NULL, kind text, source_file text NOT NULL, fields jsonb, bases text[],
  UNIQUE (scan_id, name, source_file)
);

CREATE TABLE IF NOT EXISTS scan_db_table (
  id uuid PRIMARY KEY, scan_id uuid NOT NULL REFERENCES scan(id) ON DELETE CASCADE,
  table_name text NOT NULL, class_name text, source_file text, framework text,
  pk_columns text[], fk jsonb, relationships jsonb,
  UNIQUE (scan_id, table_name)
);
CREATE TABLE IF NOT EXISTS scan_db_column (
  id uuid PRIMARY KEY,
  table_id uuid NOT NULL REFERENCES scan_db_table(id) ON DELETE CASCADE,
  name text NOT NULL, column_type text,
  primary_key boolean, nullable boolean, is_unique boolean, indexed boolean,
  foreign_keys jsonb, autoincrement boolean,
  UNIQUE (table_id, name)
);

CREATE TABLE IF NOT EXISTS scan_dependency (
  id uuid PRIMARY KEY, scan_id uuid NOT NULL REFERENCES scan(id) ON DELETE CASCADE,
  name text NOT NULL, ecosystem text NOT NULL, version text, kind text,
  UNIQUE (scan_id, ecosystem, name)
);

CREATE TABLE IF NOT EXISTS scan_ticket (
  id uuid PRIMARY KEY, scan_id uuid NOT NULL REFERENCES scan(id) ON DELETE CASCADE,
  ticket_key text NOT NULL,
  issue_type text, ticket_status text, priority text, summary text,
  epic_key text, parent_key text, labels text[], components text[],
  assignee_display text, reporter_display text,
  created_at_source timestamptz, updated_at_source timestamptz,
  corpus_artifact_id uuid REFERENCES artifact(id) ON DELETE SET NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  UNIQUE (scan_id, ticket_key)
);

CREATE TABLE IF NOT EXISTS scan_doc_page (
  id uuid PRIMARY KEY, scan_id uuid NOT NULL REFERENCES scan(id) ON DELETE CASCADE,
  page_ref text NOT NULL,
  title text, space text, labels text[], ancestors jsonb, url text,
  doc_version int, updated_at_source timestamptz,
  corpus_artifact_id uuid REFERENCES artifact(id) ON DELETE SET NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  UNIQUE (scan_id, page_ref)
);

CREATE TABLE IF NOT EXISTS cross_link (
  id uuid PRIMARY KEY, scan_id uuid NOT NULL REFERENCES scan(id) ON DELETE CASCADE,
  from_type text NOT NULL, from_ref text NOT NULL,
  to_type text NOT NULL,   to_ref text NOT NULL,
  link_type text NOT NULL,
  method text NOT NULL,                      -- 'structural'|'literal-match'|'git-log'|'inferred'
  confidence numeric, detail jsonb
);
CREATE UNIQUE INDEX IF NOT EXISTS cross_link_uq ON cross_link
  (scan_id, from_type, md5(from_ref), to_type, md5(to_ref), link_type);
CREATE INDEX IF NOT EXISTS cross_link_reverse_ix ON cross_link (scan_id, to_type, md5(to_ref));

CREATE TABLE IF NOT EXISTS indexed_topic (
  id uuid PRIMARY KEY, scan_id uuid NOT NULL REFERENCES scan(id) ON DELETE CASCADE,
  topic text NOT NULL, item_count int, sources_contributing text[],
  payload jsonb NOT NULL,
  UNIQUE (scan_id, topic)
);

CREATE TABLE IF NOT EXISTS observation (
  id uuid PRIMARY KEY, scan_id uuid NOT NULL REFERENCES scan(id) ON DELETE CASCADE,
  entity_type text NOT NULL, entity_id uuid NOT NULL,
  source_id text NOT NULL, discovery_tier text, confidence numeric,
  source_file text, line_start int, line_end int, content_hash text
);
CREATE UNIQUE INDEX IF NOT EXISTS observation_uq ON observation
  (scan_id, entity_type, entity_id, source_id, coalesce(source_file,''), coalesce(line_start,-1));
CREATE INDEX IF NOT EXISTS observation_entity_ix ON observation (entity_type, entity_id);

CREATE TABLE IF NOT EXISTS scan_finding (
  id uuid PRIMARY KEY, scan_id uuid NOT NULL REFERENCES scan(id) ON DELETE CASCADE,
  category text NOT NULL,
  finding_key text NOT NULL,
  subject text, severity text,
  detail jsonb NOT NULL,
  UNIQUE (scan_id, category, finding_key)
);

CREATE TABLE IF NOT EXISTS synthesized_fact (
  id uuid PRIMARY KEY, scan_id uuid NOT NULL REFERENCES scan(id) ON DELETE CASCADE,
  fact_id text NOT NULL, kind text NOT NULL, key text NOT NULL,
  confidence numeric,
  content_hash text NOT NULL,
  payload jsonb NOT NULL,
  UNIQUE (scan_id, fact_id)
);
CREATE INDEX IF NOT EXISTS synthesized_fact_kind_key_ix ON synthesized_fact (kind, key);

CREATE TABLE IF NOT EXISTS feature (
  id uuid PRIMARY KEY, scan_id uuid NOT NULL REFERENCES scan(id) ON DELETE CASCADE,
  feature_id text NOT NULL, name text, signal text, summary text,
  natural_key text NOT NULL,
  confidence numeric, member_count int, entrypoints text[], coverage jsonb,
  UNIQUE (scan_id, feature_id),
  UNIQUE (scan_id, id)
);
CREATE INDEX IF NOT EXISTS feature_natural_key_ix ON feature (natural_key);

CREATE TABLE IF NOT EXISTS feature_member (
  feature_id  uuid NOT NULL,
  scan_id     uuid NOT NULL,
  member_type text NOT NULL,
  member_ref  text NOT NULL,
  PRIMARY KEY (feature_id, member_type, member_ref),
  FOREIGN KEY (scan_id, feature_id) REFERENCES feature (scan_id, id) ON DELETE CASCADE,
  FOREIGN KEY (scan_id, member_ref) REFERENCES synthesized_fact (scan_id, fact_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS gap_thread (
  id            uuid PRIMARY KEY,
  project_id    uuid NOT NULL REFERENCES project(id) ON DELETE RESTRICT,
  natural_key   text NOT NULL,
  kind          text NOT NULL,
  status        text NOT NULL DEFAULT 'open',
  first_seen_scan_id uuid REFERENCES scan(id) ON DELETE SET NULL,
  last_seen_scan_id  uuid REFERENCES scan(id) ON DELETE SET NULL,
  closed_by_scan_id  uuid REFERENCES scan(id) ON DELETE SET NULL,
  detail        jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, natural_key)
);
CREATE INDEX IF NOT EXISTS gap_thread_status_ix ON gap_thread (project_id, status);

CREATE TABLE IF NOT EXISTS gap (
  id uuid PRIMARY KEY, scan_id uuid NOT NULL REFERENCES scan(id) ON DELETE CASCADE,
  kind text NOT NULL, subject_fact_id text, subject jsonb, priority text, detail jsonb,
  feature_id uuid REFERENCES feature(id) ON DELETE SET NULL,
  thread_id uuid REFERENCES gap_thread(id) ON DELETE SET NULL,
  FOREIGN KEY (scan_id, subject_fact_id) REFERENCES synthesized_fact (scan_id, fact_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS gap_uq ON gap (scan_id, kind, coalesce(subject_fact_id, subject->>'key'));
CREATE INDEX IF NOT EXISTS gap_thread_ix ON gap (thread_id);

CREATE TABLE IF NOT EXISTS delegation (
  id uuid PRIMARY KEY, scan_id uuid NOT NULL REFERENCES scan(id) ON DELETE CASCADE,
  kind text NOT NULL, status text NOT NULL,
  reason text, item_count int,
  host_model text, prompt_schema_hash text, response_hash text,
  fulfilled_at timestamptz,
  UNIQUE (scan_id, kind)
);
CREATE TABLE IF NOT EXISTS delegation_artifact (
  delegation_id uuid NOT NULL REFERENCES delegation(id) ON DELETE CASCADE,
  artifact_id   uuid NOT NULL REFERENCES artifact(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('batch','schema')),
  ordinal int NOT NULL DEFAULT 0,
  PRIMARY KEY (delegation_id, artifact_id)
);

-- ── property graph (33–34) ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS graph_node (
  id uuid PRIMARY KEY, scan_id uuid NOT NULL REFERENCES scan(id) ON DELETE CASCADE,
  node_key text NOT NULL,
  node_type text NOT NULL,
  props jsonb NOT NULL,
  UNIQUE (scan_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS graph_node_key_uq ON graph_node (scan_id, md5(node_key));

CREATE TABLE IF NOT EXISTS graph_edge (
  id uuid PRIMARY KEY, scan_id uuid NOT NULL REFERENCES scan(id) ON DELETE CASCADE,
  from_node_id uuid NOT NULL,
  to_node_id   uuid NOT NULL,
  relation text NOT NULL,
  edge_key text NOT NULL DEFAULT '',
  derivation text NOT NULL DEFAULT 'observed',
  confidence numeric,
  props jsonb,
  UNIQUE (scan_id, from_node_id, to_node_id, relation, edge_key),
  FOREIGN KEY (scan_id, from_node_id) REFERENCES graph_node (scan_id, id) ON DELETE CASCADE,
  FOREIGN KEY (scan_id, to_node_id)   REFERENCES graph_node (scan_id, id) ON DELETE CASCADE,
  CHECK (derivation <> 'inferred' OR confidence IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS graph_edge_to_ix   ON graph_edge (scan_id, to_node_id);
CREATE INDEX IF NOT EXISTS graph_edge_from_ix ON graph_edge (scan_id, from_node_id);

-- ── tests, executions, results, defects, reports (37–48) ────────────────────

CREATE TABLE IF NOT EXISTS test_suite (
  id uuid PRIMARY KEY,
  scan_id uuid NOT NULL REFERENCES scan(id) ON DELETE CASCADE,
  kind text NOT NULL,
  name text NOT NULL DEFAULT '',
  plan_source text, config jsonb, generated_at timestamptz, stats jsonb,
  artifact_id uuid REFERENCES artifact(id) ON DELETE SET NULL,
  UNIQUE (scan_id, kind, name),
  UNIQUE (scan_id, id)
);

CREATE TABLE IF NOT EXISTS test_case (
  id uuid PRIMARY KEY,
  suite_id uuid NOT NULL REFERENCES test_suite(id) ON DELETE CASCADE,
  kind text NOT NULL,
  natural_key text NOT NULL,
  step_index int,
  method text, path text, step_action text, selector text, value text,
  body jsonb,
  feature_id uuid REFERENCES feature(id) ON DELETE SET NULL,
  artifact_id uuid REFERENCES artifact(id) ON DELETE SET NULL,
  UNIQUE (suite_id, natural_key)
);
CREATE INDEX IF NOT EXISTS test_case_feature_ix ON test_case (feature_id);

CREATE TABLE IF NOT EXISTS test_case_fact (
  test_case_id uuid NOT NULL REFERENCES test_case(id) ON DELETE CASCADE,
  scan_id      uuid NOT NULL,
  fact_id      text NOT NULL,
  role         text NOT NULL DEFAULT 'derived-from',
  PRIMARY KEY (test_case_id, fact_id),
  FOREIGN KEY (scan_id, fact_id) REFERENCES synthesized_fact (scan_id, fact_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS test_case_fact_fact_ix ON test_case_fact (scan_id, fact_id);

CREATE TABLE IF NOT EXISTS test_execution_run (
  id uuid PRIMARY KEY,
  suite_id uuid NOT NULL, scan_id uuid NOT NULL,
  mode text,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  stats jsonb,
  UNIQUE (suite_id, started_at),
  FOREIGN KEY (scan_id, suite_id) REFERENCES test_suite (scan_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS test_execution_run_suite_ix ON test_execution_run (suite_id);

CREATE TABLE IF NOT EXISTS test_result (
  id uuid PRIMARY KEY,
  execution_run_id uuid NOT NULL REFERENCES test_execution_run(id) ON DELETE CASCADE,
  test_case_id uuid REFERENCES test_case(id) ON DELETE CASCADE,
  parent_result_id uuid REFERENCES test_result(id) ON DELETE CASCADE,
  granularity text NOT NULL DEFAULT 'case',
  history_id text,
  status text NOT NULL,
  http_status int, timing_ms numeric, error text,
  measurements jsonb,
  request jsonb, response_preview text,
  artifact_id uuid REFERENCES artifact(id) ON DELETE SET NULL,
  UNIQUE NULLS NOT DISTINCT (execution_run_id, test_case_id, granularity, parent_result_id)
);
CREATE INDEX IF NOT EXISTS test_result_history_ix ON test_result (history_id);
CREATE INDEX IF NOT EXISTS test_result_case_ix ON test_result (test_case_id);

CREATE TABLE IF NOT EXISTS perf_observation (
  id uuid PRIMARY KEY,
  execution_run_id uuid NOT NULL REFERENCES test_execution_run(id) ON DELETE CASCADE,
  kind text NOT NULL,
  method text, url text, status int, duration_ms numeric, ttfb_ms numeric, detail jsonb
);
CREATE INDEX IF NOT EXISTS perf_observation_run_ix ON perf_observation (execution_run_id);

CREATE TABLE IF NOT EXISTS defect (
  id            uuid PRIMARY KEY,
  project_id    uuid NOT NULL REFERENCES project(id) ON DELETE RESTRICT,
  fingerprint   text NOT NULL,
  title text, severity text, category text,
  status text NOT NULL DEFAULT 'open',
  triage_verdict text,
  external_ref text,
  first_seen_scan_id uuid REFERENCES scan(id) ON DELETE SET NULL,
  last_seen_scan_id  uuid REFERENCES scan(id) ON DELETE SET NULL,
  last_test_result_id uuid REFERENCES test_result(id) ON DELETE SET NULL,
  mapping jsonb,
  video_artifact_id uuid REFERENCES artifact(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS defect_status_ix ON defect (project_id, status);

CREATE TABLE IF NOT EXISTS defect_occurrence (
  defect_id      uuid NOT NULL REFERENCES defect(id) ON DELETE CASCADE,
  test_result_id uuid NOT NULL REFERENCES test_result(id) ON DELETE CASCADE,
  scan_id        uuid NOT NULL REFERENCES scan(id) ON DELETE CASCADE,
  observed_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (defect_id, test_result_id)
);
CREATE INDEX IF NOT EXISTS defect_occurrence_scan_ix ON defect_occurrence (scan_id);

CREATE TABLE IF NOT EXISTS report (
  id uuid PRIMARY KEY,
  scan_id uuid NOT NULL REFERENCES scan(id) ON DELETE CASCADE,
  execution_run_id uuid REFERENCES test_execution_run(id) ON DELETE CASCADE,
  kind text NOT NULL,
  artifact_id uuid REFERENCES artifact(id) ON DELETE SET NULL,
  summary jsonb, generated_at timestamptz,
  UNIQUE NULLS NOT DISTINCT (scan_id, kind, execution_run_id)
);
CREATE TABLE IF NOT EXISTS report_execution_run (
  report_id uuid NOT NULL REFERENCES report(id) ON DELETE CASCADE,
  execution_run_id uuid NOT NULL REFERENCES test_execution_run(id) ON DELETE CASCADE,
  PRIMARY KEY (report_id, execution_run_id)
);

CREATE TABLE IF NOT EXISTS report_entry (
  id uuid PRIMARY KEY,
  report_id uuid NOT NULL REFERENCES report(id) ON DELETE CASCADE,
  test_result_id uuid REFERENCES test_result(id) ON DELETE SET NULL,
  history_id text NOT NULL,
  status text, status_detail text, attachments jsonb,
  UNIQUE (report_id, history_id)
);
CREATE INDEX IF NOT EXISTS report_entry_result_ix ON report_entry (test_result_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id bigserial PRIMARY KEY,
  entity_type text NOT NULL, entity_id uuid NOT NULL,
  action text NOT NULL,
  actor text, at timestamptz NOT NULL DEFAULT now(), detail jsonb
);
CREATE INDEX IF NOT EXISTS audit_log_entity_ix ON audit_log (entity_type, entity_id);
