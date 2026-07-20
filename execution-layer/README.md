# Execution Layer

| Component | Role | Status |
|---|---|---|
| `test-executor/` | C7: reads `tests/manifest.json`, enforces safe/full mode + the safety floor (p0-00 §9) **in code**, runs each allowed test as a bounded local child process (own process group, timeout, no orphans), and writes `results/results.json` (p0-00 §8). Test files share one contract: they export `async function run(ctx)`. Runner is an interface (child-process today, Docker/E2B later). See `docs/specs/p0-07-execution-stage.spec.md`. | ✅ |
| `report-generator/` | Unified HTML dashboard (KB stats + latest test run + gaps + coverage matrix) | planned |
