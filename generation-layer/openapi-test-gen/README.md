# openapi-test-gen

Spec-driven **JS** API tester. Complements the Python `api-test-generator`
(which builds curls from `indexed_output/apis.json`); this one drives off the
**OpenAPI spec** the crawler produces and replays/validates live calls.

Self-contained sub-project (own `node_modules`): `npm install` here first.

## Scripts

| Command | File | What it does |
|---|---|---|
| `npm run api-test`  | `openapi-test-gen.mjs` | For each JSON API in the spec, replay a representative captured call with a fresh Bearer token, validate status, emit curls + `report.md` + `results.json`. |
| `npm run write-test`| `write-test-gen.mjs`   | Exercise the write/mutation + detail endpoints from an **official** spec (`POST/PUT/PATCH/DELETE`), bodies synthesized from schemas + real ids. Safe DELETEs (PUT→DELETE round-trips). |
| `npm run spec-diff` | `spec-diff.mjs`        | Diff an official OpenAPI spec vs what we discovered/tested → coverage report. |

## Inputs (read from repo `output/`, resolved via repo root)
- `output/crawler/reports/openapi.json` — the spec we built (from `scripts/crawler/spec.mjs`)
- `output/crawler/auth-state.json` — to capture a fresh Bearer token (re-run a crawl / `testo scan` to refresh it if expired)
- `output/crawler/raw/{requests,responses}.ndjson` + `bodies/` — representative captured calls
- `output/indexed_output/mock-data.json` — fallback request bodies

## Outputs
- `output/generation/openapi-tests/{report.md, results.json, manifest.json, curls/, responses/}`
- `output/generation/openapi-tests/{write-tests-report.md, coverage-vs-official.md}`

## Examples
```bash
npm install
BASE_URL=https://console-preview.superalign.ai npm run api-test
node spec-diff.mjs /path/to/official-spec.yaml
node write-test-gen.mjs /path/to/official-spec.yaml
```
