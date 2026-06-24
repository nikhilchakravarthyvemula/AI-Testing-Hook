# Generation Layer

| Component | Role | Status |
|---|---|---|
| `api-test-generator/` | Indexed APIs → runnable curl tests; logs in, runs with auth | ✅ |
| `ui-test-generator/` | `scenario.json` → Playwright UI test + Web Vitals; runs + reports. Standalone Node script (not yet a skill). | ✅ |
| `perf-test-generator/` | `scenario.json` → JMeter `.jmx` load plan + run script + `.jtl` parser. Standalone Node script. | ✅ |
| `allure-reporter/` | Consolidates API + UI + Perf results into one **Allure** report (pass/fail + reasons, per-step screenshots, route/API/object timing). Standalone Node script. | ✅ |
| `pdf-reporter/` | Consolidates API + UI + Perf into a single shareable **PDF** (cover, API table + reasons, UI steps with embedded screenshots, perf timing). Headless `page.pdf()`, no new dep. | ✅ |
| `test-plan-creator/` | Reads knowledge-base + gap-analyzer output, emits explicit `test-plan.json`. Until it exists, `scenario.json` (repo root) is the hand-authored stand-in consumed by the UI/perf generators. | planned |
| `test-script-generator/` | Emits runnable Playwright .spec.mjs files. Today: in scripts/crawler/generator/. | 🚧 |
| `mock-data-creator/` | Field-type defaults + per-app config overrides | planned |
| `validator/` | ESLint + parse-check + diff vs previous generation | planned |

**UI/perf generators are deterministic and dependency-light:** no LLM, no skill-register wiring,
no `@playwright/test` / `npm install` (they use the `playwright` library + Chromium already in the
repo). Run directly:

```bash
node generation-layer/ui-test-generator/gen.mjs   scenario.json
node generation-layer/perf-test-generator/gen.mjs scenario.json
```
