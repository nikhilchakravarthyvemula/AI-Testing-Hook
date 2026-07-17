# P0-05 — Test-Plan-Creator (S1) · SPEC

**Status:** Draft v1.0 (for review)
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

1. Against the logtrim store with live engine: plan validates against
   p0-00 §6; every scenario's targets resolve in the store; mutation flags
   correct on a hand-checked sample (all POST/PUT/DELETE flagged).
2. Mock engine, no fixtures: full template plan appears, same schema,
   `source: "template"`.
3. A scenario inventing an unknown endpoint is dropped and counted.
4. Checkpoint summary (p0-01 §4) renders correctly from a real plan: feature
   count, scenario counts, mutation count, estimate.
