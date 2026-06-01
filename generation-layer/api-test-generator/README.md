# api-test-generator

The first skill in the generation layer. Reads APIs that the context
layer indexed into `output/indexed_output/apis.json`, generates a curl
command per endpoint, and runs them against the live target.

## Flow

```
indexed_output/apis.json  +  db-schema.json
                ↓
   find login endpoint  →  curl login  →  capture token
                ↓
   for every other API:
     build curl (Authorization: <scheme> <token>, headers from observations,
                 body from crawler samples → DB schema → empty stub)
     execute curl
     record { status, timing, body preview }
                ↓
   output/generation/api-tests/
   ├── curls/<api_id>.sh          per-API runnable bash script
   ├── results.json               structured per-test outcome
   └── report.md                  human-readable summary
```

## Args

| Field | Default | Notes |
|---|---|---|
| `apis_json`       | `output/indexed_output/apis.json` | indexer output |
| `db_schema_json`  | `output/indexed_output/db-schema.json` | optional — better body synthesis when present |
| `base_url`        | auto-detected | from crawler bundle, prefers API-shaped origin |
| `login_email`     | `None` — login skipped if absent | |
| `login_password`  | `None` — login skipped if absent | |
| `output_dir`      | `output/generation/api-tests` | |
| `execute`         | `True` | set false to only write curls |
| `max_tests`       | `None` | cap on # APIs tested |
| `timeout_s`       | `30` | per-curl timeout |
| `auth_scheme`     | `Bearer` | overridden by login response if it returns `token_type` |

## Result

```python
class ApiTestGeneratorResult(BaseModel):
    ok: bool
    curls_generated: int
    curls_executed: int
    passed: int
    failed: int
    login_succeeded: bool
    login_url: str | None
    output_dir: str
    summary_path: str
    report_path: str
    error: str | None
```

## Run it

Via the skill register CLI (internal):

```bash
./scripts/graphify/.venv/bin/python infrastructure/skill-register/bin/call_skill.py \
   api-test-generator \
   --apis_json output/indexed_output/apis.json \
   --login_email admin@example.com \
   --login_password secret
```

Or via testo CLI (user-facing):

```bash
testo generate api-tests --url http://localhost:3000 --user admin@example.com --pass secret
```

## Body synthesis priority

For non-GET requests we walk this list in order:

1. **Crawler `exampleRequestBodies`** — real production-shape data from the live crawl.
2. **DB schema** — when path looks like `/<table>` and the indexer has that table, fabricate from columns (types + name hints).
3. **Pydantic `schema_ref`** — emit a `{_note: "stub for X", data: {}}` placeholder.
4. **Empty `{}`** — let the API 400 loudly.

No LLM calls today. Hooks are in `lib/request_synth.py` if we ever want to plug one in.

## Auth handling

* Login endpoint discovery: POST endpoints whose path matches
  `/(login|auth/login|sign-?in|token|oauth/token|sessions?)$/i`, most-observed wins.
* Body shape: mimics any prior crawler-observed body (preserves
  `username` vs `email` field names, keeps constants like `grant_type`).
* Token extraction: tries `access_token`, `accessToken`, `token`, `id_token`,
  `jwt`, `auth_token`, …, then `data.{token}` / `result.{token}` envelopes,
  finally a Set-Cookie sniff.
* All subsequent requests get `Authorization: <scheme> <token>`. The
  `auth_scheme` defaults to `Bearer` but is overridden if the login
  response had `token_type`.
