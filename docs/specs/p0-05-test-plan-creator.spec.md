# P0-05 — Test-Plan-Creator (S1) · SPEC

**Status:** v1.1 — **IMPLEMENTED 2026-07-20** (`generation-layer/test-plan-creator/`:
`create.mjs` + `lib/{mutation,schema,assemble,template}.mjs`; wired as the spine
`plan` stage). `npm run test:plan` — 10 unit tests (injected `completeFn`) + one
opt-in live-engine test (`ENGINE_LIVE_TEST=1`, §6). All four acceptance criteria
verified — see §5.
**Depends on:** p0-03 (store), p0-02a (connector), p0-01 (checkpoint consumes
its output)
**Consumed by:** the checkpoint (human), p0-06 (approved slices)
**Fills:** the `generation-layer/test-plan-creator/` slot (planned in the
generation-layer README since day one).

> Turns the store into the reviewable artifact of the whole system:
> `plan/test-plan.json` (p0-00 §6). One S1 call per feature proposes
> scenarios; deterministic code ranks, flags mutations, and estimates cost.
> This output is always human-reviewed before anything executes — S1 is the
> cheapest place in the pipeline for the LLM to be wrong.

---

## 1. Purpose & Non-Goals

**Purpose.** For each feature in the store: assemble `featureContext()`,
make one `complete({useCase: "S1", schema: SCENARIOS})` call proposing
scenarios (title, intent, kind, targets, gapRefs), then deterministically:
de-duplicate against sibling scenarios, set `mutation` (§2), set `priority`
from gap severity, and write the plan with estimates.

**Non-Goals.**
- MUST NOT write test code, call MCP tools, or run an agent session — S1 is
  single-shot per feature; context comes from `store.mjs` in-process.
- MUST NOT emit a scenario whose targets aren't in the store (hallucination
  guard: validate `targets.endpoints`/`pages` against `indexes`; drop and
  count violations in the plan's stats).
- MUST NOT decide mutation-ness by trusting the LLM (§2).

## 2. Mutation flagging (deterministic, fail-safe)

`mutation: true` iff any target endpoint's method ∉ {GET, HEAD, OPTIONS} OR
the scenario intent matches the mutation lexicon (`create|submit|update|
delete|write|upload|register|…`) OR target-resolution is uncertain. The LLM's
own opinion is recorded but never used for the flag. Unknown ⇒ `true`
(p0-00 §6 rule).

## 3. Degraded path (S1 fallback)

Per feature, on `ok: false`: template scenarios — one smoke scenario per page
(load + no console errors + expected APIs fire, the crawler generator's
existing shapes) + one scenario per `untested`/`shadow` gap, titled from the
gap. Plan gets `"source": "template"` for that feature; degradation recorded.
The plan file shape is identical either way — the checkpoint and C6 never
know the difference.

## 4. Estimates

`estimates.llmRequests` = features × (1 S1) already spent + scenarios × ~2
(A1 generation heuristic, tuned later) — shown at the checkpoint next to
remaining budget so the human approves cost, not just content.

## 5. Acceptance

1. ✅ **Live engine.** `ENGINE_LIVE_TEST=1` (§6, `create-live.test.mjs`) makes a
   real S1 call through the actual `SCENARIOS` schema + prompt against a live
   `claude` model: the plan validates against p0-00 §6, every surviving
   scenario's targets resolve in the store, and the mutation flag is asserted
   correct on the real output (any write-method target ⇒ `mutation: true`). First
   live run: 6 scenarios for one feature, `source: "llm"`, one S1 ledger entry,
   ~36 s (the `claude -p` scaffolding overhead, p0-02 OQ-2).
2. ✅ **Template fallback.** Mock engine, no fixtures → full template plan, same
   schema, `source: "template"` (`create.test.mjs`, and end-to-end through the
   real spine `plan`→`checkpoint` stages).
3. ✅ **Hallucination guard.** A scenario inventing an unknown endpoint is dropped
   and counted in `stats.dropped.hallucinated`.
4. ✅ **Checkpoint summary** renders from a real plan (feature/scenario/mutation
   counts + estimate), asserted against `renderSummary` (p0-01 §4).

## 6. What we built — deviations & notes

- **Module split.** `create.mjs` orchestrates; `lib/mutation.mjs` (the fail-safe
  flag), `lib/schema.mjs` (`SCENARIOS` + prompt), `lib/assemble.mjs` (the
  deterministic post-processing both paths share), `lib/template.mjs` (§3).
  `createPlan(ctx)` mirrors C3's `buildStore` signature — `{ ok, stats, degraded }`,
  injectable `completeFn` (the same test seam `s2.mjs` uses) — so the spine wires
  it exactly like the store stage.
- **Spec-vs-reality: `source` is plan-level, not per-feature.** §3 says a
  degraded feature's plan "gets `source: template` for that feature", but the
  binding contract the checkpoint validates (`plan-schema.mjs` / p0-00 §6) has
  only a **plan-level** `source`. Resolved: plan `source = "template"` iff a
  **full** engine outage (every feature fell back), else `"llm"`; each feature
  **also** carries its own `source` field (the validator permits extra keys) and
  every fallback appends one S1 `degraded` entry. So a partial outage stays an
  `"llm"` plan whose per-feature provenance and degradations are still recorded
  and disclosed. Acceptance 2 (full outage ⇒ `"template"`) is unaffected.
- **Verification parity closed late.** The opt-in live test (acceptance 1) was
  added and run *after* the initial landing — the unit suite alone would have
  left §1 asserted-but-unproven, out of step with p0-02/p0-03/p0-04. Recorded
  here rather than left silent.
- **Still open — OQ-1 (per-use-case model).** Flagged in p0-02 §6 as due at C5.
  Not wired: S1 uses the run's default provider/model. Revisit if S1 scenario
  quality warrants a stronger model than the run default.
