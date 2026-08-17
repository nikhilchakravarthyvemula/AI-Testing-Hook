# Generation Layer

| Component | Role | Status |
|---|---|---|
| `api-test-generator/` | Indexed APIs → runnable curl tests; logs in, runs with auth | ✅ |
| `perf-test-generator/` | `scenario.json` → JMeter `.jmx` load plan + run script + `.jtl` parser. Standalone Node script. | ✅ |
| `allure-reporter/` | Consolidates API + UI + Perf results into one **Allure** report (pass/fail + reasons, per-step screenshots, route/API/object timing). Standalone Node script. | ✅ |
| `feature-slice/` | Feature manifest resolver, per-feature test tagging, failure classification, and the consolidated **PDF report** (`report-pdf.mjs`, also standalone: `npm run pdf`). | ✅ |
| `test-plan-creator/` | Reads output/indexed_output + gap-analyzer output, emits explicit `test-plan.json`. | planned |
| `mock-data-creator/` | Field-type defaults + per-app config overrides | planned |
| `validator/` | Syntax gate lives in the UI generator today (`node --check` + `tests/e2e/_invalid/` quarantine); ESLint + diff vs previous generation | 🚧 |

**UI test generation** lives in `testo/src/crawler/generator/e2e.mjs` (crawl output →
Playwright `.spec.mjs` suites in `tests/e2e/`), invoked via `ctx generate`. The former
`ui-test-generator/` (scenario.json-driven) and `pdf-reporter/` were retired as
duplicates of that path and `feature-slice/report-pdf.mjs` respectively (SDD §3.4).

```bash
node byo-llm-poc/ctx.mjs generate --json          # API curls + UI specs
node generation-layer/perf-test-generator/gen.mjs scenario.json
node generation-layer/feature-slice/report-pdf.mjs   # PDF from existing results
```
