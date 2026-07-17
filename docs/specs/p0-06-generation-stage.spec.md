# P0-06 — Generation Stage (A1) · SPEC

**Status:** Draft v1.0 (for review)
**Depends on:** p0-02b (seam sessions), p0-04 (context-server), p0-05
(approved plan), p0-01 (spine invokes it post-checkpoint)
**Consumed by:** p0-07 (manifest + test files)

> The one agentic stage. For each feature slice of the approved plan, the
> spine spawns one seam session (`agentic_harness.run_session`) whose agent
> reads context through the context-server MCP and writes runnable tests into
> the workspace. Fallback per slice: the existing template generator. This is
> use case A1 — the only tool loop in the system.

---

## 1. Purpose & Non-Goals

**Purpose.** Turn approved scenarios into runnable test files + manifest
entries (p0-00 §7), feature by feature, honestly accounting for every
scenario (generated / failed-generation — nothing silently dropped).

**Non-Goals.**
- MUST NOT run before checkpoint approval or after a `planHash` mismatch.
- MUST NOT execute tests or reach the live target app — the session has file
  tools + context-server only; no Bash, no network tools. Execution is p0-07,
  after safe/full enforcement.
- MUST NOT regenerate slices that already completed (resume-safety: a slice
  whose manifest entries exist and whose slice hash matches is skipped).
- MUST NOT let one slice's failure kill the stage (per-slice isolation).

## 2. Flow

1. Spine splits the approved plan: `plan/slices/<featureId>.json` (slice =
   feature + its scenarios + slice hash).
2. Spine writes `mcp-config.json` (p0-04 §2) once.
3. Per slice, sequentially (P0; parallelism is a later knob):
   `run_session --slice … --engine <provider>`.
4. Exit 0 → next slice. Exit 3/4/5 (p0-02b §3.1) → template fallback for the
   slice's scenarios that lack manifest entries, `markDegraded()`, next slice.
5. Stage ends when every scenario in the plan has exactly one manifest entry.

## 3. The session's job (system-prompt contract)

Written into the seam's session prompt; stated here because it's the A1
behavioral contract:

- For each scenario in the slice: pull `get_feature_context` (and
  `query_endpoints`/`list_gaps` as needed) from the context-server; write one
  test file at `tests/<featureId>/<scenarioId>.spec.mjs` (UI/perf: Playwright,
  matching the conventions of the existing generators; API: the
  api-test-generator's runner format).
- Tests must target only endpoints/pages present in the provided context —
  the store is the source of truth, not the model's guesses.
- Every generated file carries a header comment: runId, scenarioId, generator.
- Mutation scenarios are still generated (skipping them is the *executor's*
  job in safe mode — generation is mode-blind).
- Append the manifest entry per file; scenarios it cannot complete get
  `status: "failed-generation"` manifest entries — do not omit them.

## 4. Validation (deterministic, post-session)

After each slice, the stage parse-checks every new test file (`node --check`
/ ESLint parse) — the validator slot from the generation-layer README, minimal
form. Files that fail: manifest entry flipped to `failed-generation`, file
moved to `tests/_rejected/`, degradation note. Template-generated files pass
through the same check.

## 5. S4 re-route (rides along)

graphify's enrichment call (acquire stage, only when codebase given) swaps
`QueryEngine` → `agentic_harness.single_call("S4", …)` (p0-02b §3.4). Its
fallback (raw AST graph) is graphify's existing no-LLM path. This is the
entire S4 change — no new component.

## 6. Acceptance

1. Mock adapter end-to-end: approved 2-feature plan → files + complete
   manifest; one slice scripted to fail → its scenarios arrive via template
   fallback; stage still exits 0 with degradation recorded.
2. Live (claude adapter), logtrim, one feature: generated Playwright spec
   parse-checks, targets only stored endpoints/pages, and runs under p0-07
   against the live app.
3. Kill mid-stage; `--resume` regenerates only incomplete slices.
4. A session writing outside `tests/<featureId>/` is blocked (seam contract
   test 7) and the slice falls back.
