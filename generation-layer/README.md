# Generation Layer

| Component | Role | Status |
|---|---|---|
| `api-test-generator/` | **Python.** Reads `indexed_output/apis.json` (+ db-schema/mock-data) → builds curls, logs in for a token, executes, reports. | ✓ |
| `openapi-test-gen/` | **JS.** Spec-driven: reads the OpenAPI spec we build (`output/crawler/reports/openapi.json`) → replays captured calls with a fresh token & validates (`api-test`), exercises write/mutation endpoints from an official spec (`write-test`), and diffs coverage vs an official spec (`spec-diff`). Relocated here from `scripts/crawler/`. May converge with `api-test-generator/` later. | ✓ |
| `test-plan-creator/` | Reads knowledge-base + gap-analyzer output, emits explicit `test-plan.json` (list of {testKind, target, priority}) | planned |
| `test-script-generator/` | Emits runnable Playwright .spec.mjs files. Today: in scripts/crawler/generator/; will be re-homed here in later phase. | 🚧 |
| `mock-data-creator/` | Field-type defaults + per-app config overrides | planned |
| `validator/` | ESLint + parse-check + diff vs previous generation | planned |
