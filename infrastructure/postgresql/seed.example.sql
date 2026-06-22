-- ============================================================================
-- AI Testing Harness — EXAMPLE seed data
-- ----------------------------------------------------------------------------
-- Real rows pulled from the current output/ of the logtrim run
-- (85 apis, 13 routes, 15 pages; 47 API tests, 36 passed = 76.6%).
-- Fixed UUIDs so foreign keys line up. Run AFTER schema.example.sql.
-- ============================================================================

-- A. target + run ------------------------------------------------------------
INSERT INTO target_app (id, name, base_url, repo_url) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'logtrim', 'http://localhost:3000', NULL);

INSERT INTO run (id, target_app_id, status, trigger, base_url, codebase_path, config, started_at, finished_at, total_ms) VALUES
  ('20000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001',
   'done', 'cli', 'http://localhost:8000', '/Users/me/logtrim',
   '{"backend":"minimax","stages":["scan","generate","execute"]}',
   '2026-06-10T11:10:00Z', '2026-06-10T11:22:00Z', 720000);

INSERT INTO run_stage (run_id, stage, status, duration_ms, exit_code) VALUES
  ('20000000-0000-0000-0000-000000000001', 'scan',     'ok', 540000, 0),
  ('20000000-0000-0000-0000-000000000001', 'generate', 'ok',  95000, 0),
  ('20000000-0000-0000-0000-000000000001', 'execute',  'ok',  18000, 0);

-- B. questionnaire -----------------------------------------------------------
INSERT INTO questionnaire (run_id, test_kinds, auth_mode, creds_ref, exemptions, sla, answers) VALUES
  ('20000000-0000-0000-0000-000000000001', '{api}', 'creds',
   'vault://logtrim/admin', '["POST:/app/v1/logout","DELETE:/v2/account"]',
   '{"p95_ms":400,"error_rate":0.01}',
   '{"why":"pre-release smoke","scope":"all v2 read endpoints + webhooks"}');

-- C. indexed output ----------------------------------------------------------
INSERT INTO indexed_output (run_id, generated_at, topic_counts, sources_contributing) VALUES
  ('20000000-0000-0000-0000-000000000001', '2026-06-10T11:18:11Z',
   '{"apis":85,"routes":13,"pages":15,"models":24,"db-schema":18,"mock-data":40}',
   '["crawler","python-ast","python-fastapi","nextjs-app","react-router"]');

-- generic envelope (one example; in practice one row per topic item)
INSERT INTO indexed_item (run_id, topic, item_key, primary_data, source_tier, confidence) VALUES
  ('20000000-0000-0000-0000-000000000001', 'apis', 'GET:/api/metrics',
   '{"method":"GET","path":"/api/metrics","origin":"http://localhost:8000"}', 'live_observed', 0.95);

-- typed: API endpoints (drives API + perf gen)
INSERT INTO api_endpoint (id, run_id, method, origin, path, template_path, auth_scheme, is_write, status_codes, source_tier) VALUES
  ('e0000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001',
   'POST', 'http://localhost:8000', '/webhook/input_count', '/webhook/input_count', 'Bearer', TRUE, '{200}', 'live_observed'),
  ('e0000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001',
   'POST', 'http://localhost:8000', '/webhook', '/webhook', 'Bearer', TRUE, '{200}', 'live_observed'),
  ('e0000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000001',
   'GET',  'http://localhost:8000', '/api/metrics', '/api/metrics', 'Bearer', FALSE, '{200}', 'live_observed');

-- per-endpoint test contract (api-spec.json after verification)
INSERT INTO api_contract (run_id, endpoint_id, headers, request_body, expected, verified) VALUES
  ('20000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000003',
   '{"Authorization":"Bearer <token>"}', NULL, '{"status":200}', TRUE);

-- typed: UI pages (would drive UI gen — not built yet, but already captured)
INSERT INTO ui_page (id, run_id, url, title, section, http_status) VALUES
  ('70000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'http://localhost:3000/me', 'My account', 'account', 200),
  ('70000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', 'http://localhost:3000/aggregated-logs', 'Aggregated logs', 'logs', 200);

INSERT INTO ui_route (run_id, route_path, component, framework) VALUES
  ('20000000-0000-0000-0000-000000000001', '/aggregated-logs', 'AggregatedLogsPage', 'nextjs-app');

-- shared: data model (for body synthesis) + observed sample (perf baseline)
INSERT INTO data_model (run_id, name, kind, columns, source_tier) VALUES
  ('20000000-0000-0000-0000-000000000001', 'LogEntry', 'table',
   '[{"name":"id","type":"uuid"},{"name":"level","type":"text"},{"name":"ts","type":"timestamptz"}]', 'code_inferred');

INSERT INTO observed_sample (run_id, endpoint_id, status_code, observed_latency_ms, response_sample) VALUES
  ('20000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000003', 200, 169, '{"requests":1234,"errors":2}');

-- D. generation --------------------------------------------------------------
INSERT INTO test_suite (id, run_id, kind, tool, test_count, output_dir) VALUES
  ('5a000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001',
   'api', 'curl', 47, 'output/generation/api-tests');

INSERT INTO artifact (id, run_id, kind, filename, storage_uri, size_bytes, sha256) VALUES
  ('a4000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'curl', 'get_api_metrics.sh', 'gs://harness-artifacts/run-200..01/curls/get_api_metrics.sh', 412, 'deadbeef'),
  ('a4000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', 'zip',  'suite.zip',          'gs://harness-artifacts/run-200..01/suite.zip',                 8421, 'cafef00d');

INSERT INTO test_case (id, suite_id, run_id, kind, name, endpoint_id, method, path, expected, artifact_id) VALUES
  ('7c000000-0000-0000-0000-000000000001', '5a000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001',
   'api', 'POST /webhook/input_count', 'e0000000-0000-0000-0000-000000000001', 'POST', '/webhook/input_count', '{"status":200}', NULL),
  ('7c000000-0000-0000-0000-000000000003', '5a000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001',
   'api', 'GET /api/metrics', 'e0000000-0000-0000-0000-000000000003', 'GET', '/api/metrics', '{"status":200}', 'a4000000-0000-0000-0000-000000000001');

-- E. execution + metrics -----------------------------------------------------
INSERT INTO execution (id, run_id, suite_id, kind, base_url, started_at, finished_at, exit_code) VALUES
  ('ec000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '5a000000-0000-0000-0000-000000000001',
   'api', 'http://localhost:8000', '2026-06-10T11:21:40Z', '2026-06-10T11:21:58Z', 1);

INSERT INTO test_result (execution_id, test_case_id, run_id, status, http_status, latency_ms, repair_attempts) VALUES
  ('ec000000-0000-0000-0000-000000000001', '7c000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'pass', 200,   0, 0),
  ('ec000000-0000-0000-0000-000000000001', '7c000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000001', 'pass', 200, 169, 0);

-- after-run metrics (api kind + overall). by_status kept in `extra`.
INSERT INTO run_metric (run_id, execution_id, kind, total, passed, failed, skipped, pass_rate, p50_ms, p95_ms, p99_ms, coverage_pct, extra) VALUES
  ('20000000-0000-0000-0000-000000000001', 'ec000000-0000-0000-0000-000000000001', 'api',
   47, 36, 11, 9, 76.6, 12, 169, 240, 55.3,
   '{"by_status":{"200":32,"201":1,"307":3,"401":1,"403":3,"404":3,"422":4}}'),
  ('20000000-0000-0000-0000-000000000001', 'ec000000-0000-0000-0000-000000000001', NULL,
   47, 36, 11, 9, 76.6, 12, 169, 240, 55.3, '{}');

-- F. vectors (shape only — a real embedding is vector(1536)) -----------------
-- INSERT INTO kb_embedding (run_id, entity_type, entity_id, content, embedding, model) VALUES
--   ('20000000-...01', 'api_endpoint', 'e0000000-...03', 'GET /api/metrics returns request + error counts',
--    '[0.012, -0.044, ...1536 floats...]', 'text-embedding-3-small');

-- G. misc (cross-run learning + secret pointers) -----------------------------
INSERT INTO skill_memory (target_app_id, kind, key, value, success_count) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'login-step', 'http://localhost:8000/app/v1/login',
   '{"method":"POST","body":{"email":"$LOGIN_EMAIL","password":"$LOGIN_PASSWORD"},"token_field":"access_token"}', 5);

INSERT INTO credential_ref (target_app_id, scheme, secret_ref) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'bearer', 'vault://logtrim/admin');
