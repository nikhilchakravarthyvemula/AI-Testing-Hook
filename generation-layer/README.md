# Generation Layer

| Component | Role | Status |
|---|---|---|
| `test-plan-creator/` | Reads knowledge-base + gap-analyzer output, emits explicit `test-plan.json` (list of {testKind, target, priority}) | planned |
| `test-script-generator/` | Emits runnable Playwright .spec.mjs files. Today: in scripts/crawler/generator/; will be re-homed here in later phase. | 🚧 |
| `mock-data-creator/` | Field-type defaults + per-app config overrides | planned |
| `validator/` | ESLint + parse-check + diff vs previous generation | planned |
