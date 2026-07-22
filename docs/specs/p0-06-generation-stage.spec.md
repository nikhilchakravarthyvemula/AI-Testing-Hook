# P0-06 — Generation Stage (A1) · SPEC

**Status:** v1.1 — **IMPLEMENTED 2026-07-20** (`generation-layer/test-generator/`:
`generate.mjs` + `lib/{slices,template-gen,validate,manifest}.mjs`; wired as the
spine `generate` stage). `npm run test:generate` — 6 unit tests (injected
`sessionFn`) + one opt-in live test (`ENGINE_LIVE_TEST=1`, §7). Acceptance 1, 3,
4 covered by the unit suite; acceptance 2 (generation half) by the live test —
see §6. **The S4 re-route (§5) is NOT built — see §8; it's a separate Python-island
change deferred out of this landing.**
**Depends on:** p0-02b (seam sessions), p0-04 (context-server), p0-05
(approved plan), p0-01 (spine invokes it post-checkpoint)
**Consumed by:** p0-07 (manifest + test files)

> **Reconciliation (this spec predates OQ-4).** §2 below describes a Python
> `agentic_harness` subprocess with exit codes 3/4/5. OQ-4 (p0-02, resolved
> 2026-07-19) collapsed C2b to an **in-process Node `runSession()`** returning
> `{ ok:false, error }` — no second runtime, no exit codes. The implementation
> follows that real contract; the flow (slice → session → fallback → validate →
> manifest) is otherwise exactly as specified. See §8 for the full delta.

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

## 5. S4 re-route (rides along) — bridge BUILT, consumer dormant

The mechanism this needed — a Python→Node bridge so graphify's enrichment call
draws from the one connector's cache/ledger/budget — is **built** (p0-02 §3.4,
OQ-5): `bin/complete.mjs` + the Python client `s4_bridge.py`
(`s4_complete(...)` = the `single_call("S4")` replacement), with a real
cross-language round-trip test.

The literal *swap* the spec describes ("graphify's `QueryEngine` →
`single_call`") has **no live target**: graphify's OpenHarness `QueryEngine`
path is retired and its venv is gone, so the acquire stage's code understanding
comes from the deterministic `python-ast` extractor (no LLM) — which IS the "raw
AST graph" fallback this section names. So S4 is, in effect, already on its
fallback, and the bridge is ready for graphify's semantic stage to call the day
it's revived. No live pipeline change was fabricated into a dormant tool. See §8.

## 6. Acceptance

1. ✅ **Mock adapter end-to-end.** Approved 2-feature plan → files + complete
   manifest; a slice whose session returns `ok:false` → its scenarios arrive via
   template fallback; stage still returns ok with an `A1` degradation recorded.
   Also covered: a session that skips one scenario's file (partial fallback), and
   verified end-to-end through the real spine `plan→checkpoint→generate`.
2. ✅ **Live (claude adapter), one feature** — `generate-live.test.mjs`
   (`ENGINE_LIVE_TEST=1`, §7): a real session reads the store through the real
   context-server MCP and writes a file that `runGenerate` accepts as
   `agent`/`generated` **only after `node --check` passes**. First live run: 1
   agent file, header convention held, A1 ledgered, ~14 s. (Running it under
   p0-07 against a live app is p0-07's acceptance, not verified here.)
3. ✅ **Resume.** Simulated kill (drop a slice's entries + files) → `--resume`
   skips the still-current slice and regenerates only the incomplete one
   (`slicesResumed` counts it; a spy confirms only the incomplete slice's session
   ran). Resume keys on a per-slice content hash (slices.mjs), not just presence.
4. ⚠️ **Path confinement — enforced upstream, not re-tested here.** A session
   writing outside `tests/<featureId>/` is bounded by the seam's tool allowlist +
   the honesty diff (p0-02b), which only counts files under the feature dir — so
   stray writes never enter the manifest and the slice falls back. C6 adds a
   second backstop: manifest entries are derived from `filesWritten` filtered to
   `<scenarioId>.spec.mjs`, so an off-target or misnamed file is ignored and its
   scenario templates. Not given a dedicated C6 test — it's a C2b contract.

## 7. Opt-in live test

`ENGINE_LIVE_TEST=1 node --test generation-layer/test-generator/generate-live.test.mjs`
(model via `ENGINE_LIVE_MODEL`, default `claude-haiku-4-5`). Skipped by default so
`npm test` stays credential-free. `runGenerate` writes `mcp-config.json` pointing
the session at the real context-server over the test's store — no extra wiring.

## 8. What we built — deviations & notes

- **Python seam → in-process Node (OQ-4).** No `agentic_harness` subprocess, no
  exit codes 3/4/5. The stage calls `runSession()` (C2b, Node) directly and
  branches on `{ ok, error }`. The behavioural contract §3 (read context via MCP,
  write `tests/<featureId>/<scenarioId>.spec.mjs`, header comment, honesty rule)
  lives in the connector's `buildSystemPrompt`/`buildSessionPrompt`, already
  built in p0-02b — C6 does not re-author the prompt, it orchestrates slices.
- **Stage failMode is `abort`, not `degrade`.** Engine/template degradation is
  handled INSIDE the stage (every scenario still gets a manifest entry, stage
  returns ok), matching the store/plan stages. The only `ok:false` from generate
  is a hard gate failure (no plan, or a **planHash mismatch** — the post-approval
  integrity check, run first), which must stop the run, never silently degrade.
- **Template fallback is fetch-based, not Playwright.** §3 says UI/perf use
  Playwright; the deterministic FLOOR emits self-contained, dependency-free
  `.mjs` smoke tests (fetch the stored targets) so it needs nothing installed and
  always parse-checks. The live AGENT still writes richer Playwright specs; the
  template is the backstop, and p0-07 owns the runtime shape.
- **One retry per slice, transient failures only** (added 2026-07-21, after a real
  run lost 3 features to `claude timed out after 300000ms`). `engine-unavailable`
  earns one more attempt (`GENERATE_SESSION_RETRIES`, default 1); `budget-exhausted`
  and `honesty-failure` never do — the budget does not grow back, and a session
  that ran to completion and wrote nothing will not decide differently on a rerun.
  Mirrors the executor's "one retry, infrastructure only" rule (p0-07 §6).
- **A dead session's finished files are kept** (`session.mjs`, same change). The
  `ok:false` path previously returned before computing `filesWritten`, so a session
  that wrote 4 of 6 files and then timed out reported none — and C6 templated over
  all six, destroying real work. It now returns the partial list its own documented
  failure shape already promised (`filesWritten?`), and C6 accumulates files ACROSS
  attempts: each attempt's honesty diff only reports what appeared during it, so the
  union is everything the slice produced. Without this, the retry would have made
  things worse — attempt 2 re-writes files attempt 1 already made, they no longer
  count as "new", and they'd be templated over.
- **Batched generation** (added 2026-07-21, once p0-05 went depth-first). A slice
  used to be a whole feature; a depth-first plan gives a feature dozens of
  scenarios, and one session cannot write dozens of files inside its turn/time
  budget (`SESSION_MAX_TURNS` 24, `SESSION_TIMEOUT_MS` 5 min) — so most would fall
  to template. Now a feature is chunked (`GENERATE_BATCH_SIZE`, default 8) and each
  chunk is its own slice with its own session. Batches for one feature write into
  the same `tests/<featureId>/` dir and run sequentially, so the honesty diff and
  resume both stay correct — each keys on scenarioId + sliceHash, never on the
  batch boundary. `sliceHash` folds in the batch index so re-batching regenerates
  cleanly rather than false-resuming. Slice files are `<featureId>-<n>.json`. Stats
  gained `batches`; a batch's degradation names the batch (`"Big (batch 2/3)"`).
- **`GENERATE_BATCH_SIZE` and `GENERATE_SESSION_RETRIES` read at call time**, not
  module load, so setting them per-run works (a subtle bug: bound-at-import meant
  the env var only applied if set before the module first loaded).
- **Manifest carries `sliceHash`** (beyond p0-00 §7) so resume can distinguish a
  current file from a stale one. Extra field; no validator rejects it.
- **`featureId` dirs keep the raw id** (e.g. `tests/feat:checkout/`), consistent
  with C2b's honesty diff which uses `slice.featureId` verbatim. Verified colon
  dirs work on macOS/APFS. Slice FILES are sanitised (`plan/slices/feat-checkout.json`).
- **S4 re-route (§5): bridge built, consumer dormant.** The `bin/complete.mjs`
  Python→Node bridge + `s4_bridge.py` client (OQ-5) are built and cross-language
  tested (a real `python3 → bridge → complete()` round-trip sharing cache/ledger/
  budget). The literal graphify `QueryEngine` swap has no live target — that path
  is retired and uninstalled — so no wiring was fabricated into a dormant tool;
  the deterministic `python-ast` extractor is the active S4 source (== the spec's
  raw-AST fallback). The bridge is what a revived graphify semantic stage calls.
  This is the whole S4 change the spec anticipated, landed at the mechanism level.
