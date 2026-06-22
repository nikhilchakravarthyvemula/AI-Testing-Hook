# Harness persistence (Postgres + pgvector)

Brainstorming pack for the harness's single store (Task #1). Run-centric: one
`run` = one scan → generate → execute pass against one `target_app`.

| File | What |
|---|---|
| `schema.example.sql` | The DDL — ~23 tables, each tagged `-- [v1]` or `-- [later]`. |
| `seed.example.sql` | Real rows from the current logtrim run (85 apis, 47 API tests, 76.6% pass). |
| `schema.mermaid` | Full ER diagram (renders on GitHub / mermaid.live). |

```bash
createdb harness_scratch
psql harness_scratch -f schema.example.sql -f seed.example.sql
psql harness_scratch -c "SELECT kind, total, passed, pass_rate FROM run_metric;"
```
Needs the `vector` extension (pgvector). Without it, comment out the `CREATE EXTENSION
vector`, the `kb_embedding.embedding` column, and its `ivfflat` index.

## v1 vs later

**v1** — everything needed to persist the pipeline that already runs end-to-end
(scan → api-test-gen → execute). Build these first.

**later** — tables for modules not built yet (UI/perf generation, embeddings,
self-healing, vault). Defined now so the shape is agreed, populated when the module lands.

| Group | v1 | later |
|---|---|---|
| A. Lifecycle | `target_app`, `run`, `run_stage` | — |
| B. Questionnaire | `questionnaire` | — |
| C. Indexed output | `indexed_output`, `api_endpoint`, `api_contract`, `ui_page`, `ui_route` | `indexed_item`, `ui_form_field`, `click_edge`, `data_model`, `observed_sample` |
| D. Generation | `test_suite`, `test_case`, `artifact` | — |
| E. Execution | `execution`, `test_result`, `run_metric` | — |
| F. Vectors | — | `kb_embedding` |
| G. Misc | — | `skill_memory`, `credential_ref` |

15 v1 · 8 later.

### Notes for brainstorming
- **`indexed_item` (generic) vs typed tables** is deliberate overlap: the typed tables
  (`api_endpoint`, `ui_page`, …) are the v1 fast path; the generic envelope is the
  catch-all for the other topics (redirects, dependencies, interactions, openapi…). Pick
  one side per topic, or keep both.
- **Run-scoped vs app-scoped**: indexed output is a per-run snapshot; `skill_memory` and
  `credential_ref` persist across runs (keyed to `target_app`). Decide if the KB also needs
  an app-level "latest merged" view.
- **Reads per test kind**: API → `api_endpoint` + `api_contract` + `observed_sample`;
  UI → `ui_page` + `ui_form_field` + `ui_route` + `click_edge`; perf → `api_endpoint` +
  `observed_sample` (latency baseline) + `questionnaire.sla`.
- **Secrets never live here** — `credential_ref` holds vault pointers only.
