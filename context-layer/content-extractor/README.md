# content-extractor

Auto-discovers a source per folder (`<id>/extract.mjs|extract.py`) and runs it
via `run.mjs` (gated by env in the `GATES` map). Each source writes
`output/<id>/bundle.json`; the indexer reads them.

Sources: `crawler` (live crawl), `graphify` (code KG), `framework-extractor` +
`code-extractors/*` (per-framework AST), `db-schema`, `openapi-extractor`,
`mock-data-extractor`, and the doc sources `text-kg` / `jira` / `confluence`.

## The three API/spec producers (distinct roles — not redundant)

| Producer | Role | Output |
|---|---|---|
| `scripts/crawler/spec.mjs` | **Crawler-inferred OpenAPI** — induced from live captures (header params + request/response examples). Inductive, not contractual. Runs every scan via `npm run all`. | `output/crawler/api-spec/openapi.{json,yaml}` |
| `openapi-extractor/` | **Live-published OpenAPI/Swagger** — fetched + `$ref`-resolved when the app actually serves a spec (authoritative when present). | `output/openapi/bundle.json` |
| `mock-data-extractor/` | **Raw per-endpoint samples** — real request/response bodies + sampled headers, no schema inference. | `output/mock-data/bundle.json` |

The indexer's **`api-spec` topic** (`indexer/topics/api-spec.mjs`) MERGES all
three into one per-endpoint **test contract** (`output/indexed_output/api-spec.json`):
headers + request body + expected response bodies + status — the single input
the API test generators read. `apis.json` stays the lightweight discovery roster.
