-- ============================================================================
-- Seed: one test project spine, repeatable (ON CONFLICT DO NOTHING).
-- Adjust app_id / base_url / labels for your target before running.
-- ============================================================================

INSERT INTO project (id, app_id, org_id, name)
VALUES ('00000000-0000-0000-0000-000000000001',
        'demo-app',
        '00000000-0000-0000-0000-0000000000aa',
        'Demo Target App')
ON CONFLICT DO NOTHING;

INSERT INTO credential_ref (id, project_id, purpose, secret_ref)
VALUES ('00000000-0000-0000-0000-000000000011',
        '00000000-0000-0000-0000-000000000001',
        'login',
        'env://LOGIN_PASSWORD')
ON CONFLICT DO NOTHING;

INSERT INTO source (id, project_id, kind, name, config, credential_ref_id) VALUES
  ('00000000-0000-0000-0000-000000000021',
   '00000000-0000-0000-0000-000000000001',
   'live_link', 'staging',
   '{"baseUrl": "https://staging.example.com"}',
   '00000000-0000-0000-0000-000000000011'),
  ('00000000-0000-0000-0000-000000000022',
   '00000000-0000-0000-0000-000000000001',
   'git_repo', 'main-repo',
   '{"remote": "git@github.example.com:org/app.git"}',
   NULL)
ON CONFLICT DO NOTHING;

INSERT INTO source_version (id, source_id, version_kind, base_url, deploy_marker) VALUES
  ('00000000-0000-0000-0000-000000000031',
   '00000000-0000-0000-0000-000000000021',
   'live_deploy', 'https://staging.example.com', 'seed-initial')
ON CONFLICT DO NOTHING;

INSERT INTO source_version (id, source_id, version_kind, git_branch, git_commit) VALUES
  ('00000000-0000-0000-0000-000000000032',
   '00000000-0000-0000-0000-000000000022',
   'git_commit', 'main', 'seed-unknown')
ON CONFLICT DO NOTHING;

INSERT INTO project_instance (id, project_id, label)
VALUES ('00000000-0000-0000-0000-000000000041',
        '00000000-0000-0000-0000-000000000001',
        'staging-e2e')
ON CONFLICT DO NOTHING;

INSERT INTO instance_source_version (instance_id, source_id, source_version_id) VALUES
  ('00000000-0000-0000-0000-000000000041',
   '00000000-0000-0000-0000-000000000021',
   '00000000-0000-0000-0000-000000000031'),
  ('00000000-0000-0000-0000-000000000041',
   '00000000-0000-0000-0000-000000000022',
   '00000000-0000-0000-0000-000000000032')
ON CONFLICT DO NOTHING;
