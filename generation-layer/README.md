# Generation Layer

| Component | Role | Status |
|---|---|---|
| `api-test-generator/` | Indexed APIs → runnable curl tests; logs in, runs with auth | ✅ |
| `ui-test-generator/` | `scenario.json` → Playwright UI test + Web Vitals; runs + reports. Standalone Node script (not yet a skill). | ✅ |
| `perf-test-generator/` | `scenario.json` → JMeter `.jmx` load plan + run script + `.jtl` parser. Standalone Node script. | ✅ |
| `allure-reporter/` | Consolidates API + UI + Perf results into one **Allure** report (pass/fail + reasons, per-step screenshots, route/API/object timing). Standalone Node script. | ✅ |
| `pdf-reporter/` | Consolidates API + UI + Perf into a single shareable **PDF** (cover, API table + reasons, UI steps with embedded screenshots, perf timing). Headless `page.pdf()`, no new dep. | ✅ |
| `test-plan-creator/` | C5/S1: reads the per-run knowledge store, makes one S1 call per feature to propose scenarios, then deterministically de-dupes, guards against hallucinated targets, flags mutations fail-safe, and prices the plan → `<run>/plan/test-plan.json` (the checkpoint's subject). Template fallback per feature on engine outage. See `docs/specs/p0-05-test-plan-creator.spec.md`. | ✅ |
| `test-generator/` | C6/A1: the agentic generation stage. Per approved feature slice, runs one `runSession()` (C2b) whose agent reads the store via the context-server MCP (C4) and writes `tests/<featureId>/<scenarioId>.spec.mjs`; deterministic backstops template any scenario the session can't produce and `node --check` every file, so every scenario ends with exactly one `tests/manifest.json` entry. Resume-safe (per-slice content hash). See `docs/specs/p0-06-generation-stage.spec.md`. | ✅ |
| `test-script-generator/` | Emits runnable Playwright .spec.mjs files. Today: in scripts/crawler/generator/. Superseded for the run pipeline by `test-generator/` above. | 🚧 |
| `mock-data-creator/` | Field-type defaults + per-app config overrides | planned |
| `validator/` | ESLint + parse-check + diff vs previous generation | planned |

**UI/perf generators are deterministic and dependency-light:** no LLM, no skill-register wiring,
no `@playwright/test` / `npm install` (they use the `playwright` library + Chromium already in the
repo). Run directly:

```bash
node generation-layer/ui-test-generator/gen.mjs   scenario.json
node generation-layer/perf-test-generator/gen.mjs scenario.json
```
