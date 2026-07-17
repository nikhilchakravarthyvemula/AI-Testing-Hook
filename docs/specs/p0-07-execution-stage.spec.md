# P0-07 — Execution Stage · SPEC

**Status:** Draft v1.0 (for review)
**Depends on:** p0-06 (manifest + tests), p0-01 (mode config, workspace)
**Consumed by:** p0-08 (results.json + artifacts)
**Fills:** `execution-layer/test-executor/` (today: a README).

> The first real inhabitant of the execution layer. Reads the manifest,
> enforces safe/full mode and the safety floor **in code**, runs each test as
> a local child process with timeout and teardown, and collects
> `results/results.json` (p0-00 §8). The runner is an interface so the
> child-process backend can later swap for Docker/E2B without touching
> callers.

---

## 1. Purpose & Non-Goals

**Purpose.** Execute exactly what the manifest allows in the current mode,
against the live target, and record what happened — truthfully, per scenario.

**Non-Goals.**
- MUST NOT run any file absent from the manifest (unknown files in `tests/`
  are reported, not executed).
- MUST NOT let an LLM near enforcement: mode + safety floor are pure code.
- MUST NOT heal, retry-on-failure, or re-generate (S5 is P1; one run per
  test, plus at most one retry on *infrastructure* error — spawn failure,
  not test failure).
- MUST NOT leave orphan processes: every child is in its own process group,
  killed on timeout with teardown guaranteed (the E2B lesson, applied
  locally).

## 2. Enforcement (before anything runs)

Evaluated per manifest entry, in order:

1. **Safety floor** (p0-00 §9): regex over scenario title+intent+targets →
   `skipped-mutation` (reason `safety-floor`) unless scenarioId is in
   `SAFETY_ALLOWLIST`. Applies in both modes.
2. **Safe mode**: `mutation: true` → `skipped-mutation`.
3. `failed-generation` entries → carried into results as-is (they never run).

Skips are results, not omissions — the report's gap section builds on them.

## 3. Runner

- Backend interface: `run(entry, config) → {status, durationMs, artifacts}`;
  P0 backend: `child-process`.
- Playwright specs run via the repo's existing Playwright installation;
  API tests via their runner format (as emitted by api-test-generator).
- Per-test timeout `TEST_TIMEOUT_MS` (default 120000); stage-level wall clock
  `EXECUTE_MAX_MINUTES` (default 60) — hitting it marks remaining entries
  `error: "stage-timeout"`, never silently drops them.
- Env passed to tests: `BASE_URL` + the crawler's existing `LOGIN_*`
  conventions (storageState reuse) — tests stay retargetable, per the
  generator's existing design.
- Artifacts per test: stdout/stderr log, screenshots on failure (Playwright
  default), collected under `results/`.
- Concurrency: 1 in P0 (live-target politeness); a knob later.

## 4. Output

`results/results.json` per p0-00 §8, plus `summary` totals the spine prints.
Every manifest entry appears exactly once; statuses: `passed | failed |
skipped-mutation | error`.

## 5. Acceptance

1. Manifest of 6 (3 safe, 2 mutation, 1 failed-generation), safe mode: 3 run,
   2 `skipped-mutation`, 1 carried; results validate; no orphan processes
   after a forced timeout (verified via process table).
2. Full mode: mutation entries run; a safety-floor-matching scenario still
   skips without an allowlist entry.
3. A test that hangs is killed at timeout, marked `error`, and the stage
   continues.
4. logtrim live run (safe): real pass/fail results with screenshots for
   failures.
