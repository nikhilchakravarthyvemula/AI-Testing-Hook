# P0-07 — Execution Stage · SPEC

**Status:** v1.1 — **IMPLEMENTED 2026-07-20** (`execution-layer/test-executor/`:
`execute.mjs` + `lib/{safety-floor,enforce,results,runner-child,harness}.mjs`;
wired as the spine `execute` stage). `npm run test:execute` — 17 tests
(enforcement matrix + real child-process pass/fail/no-run/timeout+no-orphan +
C6-template↔executor round-trips against a live local server). Acceptance 1-3
covered; §4's mechanism proven deterministically (local server), the live
logtrim UI+screenshots run left opt-in — see §5, §6.
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

1. ✅ **Safe-mode enforcement.** Manifest of 6 (3 safe, 2 mutation, 1
   failed-generation), safe mode → 3 run, 2 `skipped-mutation` (reason
   `safe-mode`), 1 carried (`error`, reason `failed-generation`); every entry
   present once; summary derived from entries. No-orphan verified separately (§3
   below), by process liveness not the process table.
2. ✅ **Full mode + floor.** Full mode runs the mutation entries; a
   safety-floor-matching scenario still `skipped-mutation` (reason
   `safety-floor`) with no allowlist entry, and runs only when its scenarioId is
   in `SAFETY_ALLOWLIST` — proven in both modes.
3. ✅ **Hang → timeout, no orphan, stage continues.** A test that spawns a
   long-lived grandchild and hangs is killed at `TEST_TIMEOUT_MS`; the entry is
   `error` (reason `timeout`) and the grandchild is reaped (its pid is dead) —
   proving the whole process GROUP is killed, not just the node process.
4. ⚠️ **Live results — mechanism verified, logtrim UI run opt-in.** Real
   pass/fail with a real child process and collected log artifact is proven
   deterministically against a local `http.Server`, executing an actual C6
   template file (generate↔execute contract). The full logtrim run with
   Playwright UI + screenshots-on-failure needs a live app + login/storageState,
   so it's a manual/opt-in run, not a committed test. Screenshots are wired
   (`ctx.shotDir` → `results/shots/<scenarioId>/`, collected into `artifacts`).

## 6. What we built — deviations & notes

- **The safety floor joins the plan, not just the manifest.** The floor reads
  scenario title+intent+targets (p0-00 §9), which the manifest doesn't carry — so
  the executor loads `plan/test-plan.json` and joins by `scenarioId`. A missing
  plan is a hard stop (can't enforce the floor → don't run).
- **execute re-verifies `planHash` first (p0-01 §5).** Because it reads that same
  plan to enforce the floor and derive what runs, the `execute` stage calls
  `verifyPlanHash` before anything — a mismatch aborts. This is NOT redundant with
  generate's gate: on `testo run --resume`, an already-`done` generate is skipped,
  so execute owns the re-check on the path that touches the live target. (Fixed
  2026-07-20 — the initial C7 landing had the gate only in generate.)
- **One test-file execution contract, system-wide.** Every generated file —
  agent OR template — exports `export async function run(ctx)` (ctx = { baseUrl,
  shotDir, env }); resolves = pass, throws = fail. UI/perf use the `playwright`
  LIBRARY (chromium.launch), not `@playwright/test` (not installed), matching the
  house style. The C6 session prompt (`buildSessionPrompt`) was updated to state
  this contract; **re-verified live** — the real agent now emits `run()`-exporting
  files. The executor spawns a tiny `harness.mjs` that imports the file and calls
  `run()`; exit 0/1/2 → passed/failed/error(no-run-export).
- **No orphans via process groups.** Children are spawned `detached` (own group);
  a timeout does `process.kill(-pid, 'SIGKILL')` to take the whole subtree
  (Chromium included). This is the E2B lesson applied to the local backend; the
  runner is an interface so a Docker/E2B backend can replace it later.
- **`failed-generation` → results `error`** (reason `failed-generation`) — p0-00
  §8 has four statuses and no separate "carried" state; it's honestly an error
  that never ran. Results entries also carry an extra `reason` field (why a
  skip/error happened) beyond the §8 shape — additive, for the report.
- **One retry, infra only.** A `spawn`-class error (couldn't launch the child) is
  retried once; a test FAILURE never is (heal/retry is S5, P1).
- **Stage wall clock.** `EXECUTE_MAX_MINUTES` (default 60): once exceeded,
  remaining entries are marked `error`/`stage-timeout`, never silently dropped.
