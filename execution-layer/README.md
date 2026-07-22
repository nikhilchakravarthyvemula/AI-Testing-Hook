# Execution Layer

| Component | Role | Status |
|---|---|---|
| `test-executor/` | C7: reads `tests/manifest.json`, enforces safe/full mode + the safety floor (p0-00 §9) **in code**, runs each allowed test as a bounded local child process (own process group, timeout, no orphans), and writes `results/results.json` (p0-00 §8). Test files share one contract: they export `async function run(ctx)`. Runner is an interface (child-process today, Docker/E2B later). See `docs/specs/p0-07-execution-stage.spec.md`. | ✅ |
| `report-generator/` | C8: one self-contained deliverable per run — `report/index.html` (inline CSS/JS + data-URI screenshots, light/dark) + `report/report.pdf` — with four sections: §A test results, §B coverage & gap audit (the signature section), §C app-understanding map, §D run transparency (ledger reconciliation + every degradation). Deterministic, reads the workspace only; a thin/degraded run still produces a report. See `docs/specs/p0-08-final-report.spec.md`. | ✅ |
