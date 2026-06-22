# Delivery Plan — 6 Months (V1 → V3)

_Maps the milestone plan onto the actual backlog (`PROJECT-STATUS-AND-BACKLOG.md`) and current code state. Backlog item numbers are referenced as **[A1]**, **[B9]**, etc._

## Milestone overview

| Milestone | Timeline | Scope | Backlog items | Already done? |
|---|---|---|---|---|
| **V1** | Week 4 | Context + API layer: crawl/spec ingestion, knowledge synthesis, API test gen & validation | [A1], [B12], [B14]; gen+gates already built | ~80% |
| **V1 Rollout** | Weeks 5–6 | Rollout for test/feedback + UI test-plan generation | [A4], [A2 (API exec)], [A6], [A5]; **N1 test-to-Git** | Partial |
| **V2** | Week 8 | UI test plan + case generation; Execution Layer (runners, reporting) | [A2], [A3], [A5], [A6], [A7] | Not started |
| **V2 Rollout** | Weeks 9–12 | Rollout & validation across target APIs | **N3 Fraud/Inbound**, [A8], [D18], **N2 audit** | Not started |
| **V3** | Wk 13 → Month 6 | Hardening, full feature set, prod rollout & handover | [D17], [D19], [D20], [C15], [C16], [B9–B13], **N5 KT** | Not started |

## What's already built (pre-V1 baseline)

A lot of V1 scope is **done**: the full `content-extractor` (crawl + spec + db + 20+ code-extractors + **text-kg/jira/confluence**), the 13-topic `indexer` **with `api-spec-verify`**, `graph-viewer`, `api-test-generator` (verified spec + **self-repair** + **executes** its own curl tests), `openapi-test-gen`, and the agent infra. Crucially, the **3 validation gates already exist**:

1. **Authenticity gate** — `indexer/verify/api-spec-verify.mjs` (drops phantom/stripped-prefix endpoints, repairs bodies).
2. **Session-safety gate** — `is_exempt` + `api-test-exemptions.json` (never execute session-rotating endpoints).
3. **Self-repair gate** — `lib/repair.py` (≤3 attempts on 422/400, persists the working curl).

> Confirm these are the intended "3 gates." If you also want a *quality* gate (lint/smell/coverage/LLM-judge), that's backlog **[A7] validator** and would make it 4.

## Per-milestone detail

### V1 — Week 4 (Context + API layer)
- **Remaining work:** **[A1]** Knowledge Base `build.mjs`/`store.mjs` → unified `knowledge.json`; **[B14]** wire `text-kg` triples into it; **[B12]** `knowledge-synthesizer` (cross-source dedup) — at least a first pass so "knowledge synthesis" is real.
- **Already satisfied:** crawl/spec ingestion, API test generation, 3-gate validation.
- **Acceptance (yours):** API tests generated from the **Fraud** spec via `testo`, 70–80% usable, 3 gates operational.
- **Note:** needs the **Fraud spec onboarded** (**N3**) — there's no Fraud config in the repo today, only demo-app data. Onboarding = point ingestion at the Fraud spec/endpoint + an exemptions file.

### V1 Rollout — Weeks 5–6 (test/feedback + UI test plans)
- **Remaining work:** **[A4]** `feedback/results-to-kb.mjs` (close the loop); **[A6]** `test-plan-creator` for **UI test plans**; **[A5]** wire UI/E2E generation into `testo`; **N1** test-to-Git (start saving generated tests/results to the connected repo).
- **Execution:** API tests **already self-execute** (`api-test-generator`, `execute=True` → `results.json`), so "execute in non-prod" is feasible now for APIs without the full Execution Layer; UI execution arrives in V2.
- **Acceptance (yours):** tests execute in non-prod at **85–90% pass**; UI test plans generated.

### V2 — Week 8 (UI generation + Execution Layer)
- **Remaining work:** **[A2]** `execution-layer/test-executor` (unified Playwright + API runner, JSON reporter, flake classify, `testo run`); **[A3]** `report-generator` (`testo report`); **[A5]** UI **test case** generation wired; **[A6]** plans; **[A7]** validator gate.
- **Acceptance (yours):** Playwright UI test cases generated **and executed end-to-end**; reports produced.

### V2 Rollout — Weeks 9–12 (validate across target APIs)
- **Remaining work:** **N3** Fraud (full) + Inbound Payments (started) connector onboarding; **[A8]** add `openai`/`anthropic`/`ollama` providers (env/portability); **[D18]** per-app output isolation (run multiple APIs without collisions); **N2** audit trail (run-level log, not just per-fact provenance).
- **Acceptance (yours):** rollout validated across target APIs.

### V3 — Week 13 → Month 6 (hardening + prod + handover)
- **Remaining work:** **[D19]** vendored offline deps (**vis-network** off jsDelivr) + Playwright/pip/npm offline; **[D17]** `container-deploy` (image + CI); **[D20]** egress automation (proxy/FQDN allowlist + Playwright-proxy change); **[C16]** self-healing execution; **[C15]** skill-memory; **[B9–B13]** graph analytics → interactive knowledge-graph output; **N5** docs + KT/handover. **[D21]** pg/pgvector optional.
- **Acceptance (yours):** hardened platform, vendored offline deps, docs + KT delivered, rollout complete.

## In scope (per plan)
AI test generation from API specs + crawled state (skill-driven) with **3-gate validation** · Fraud API (full) + Inbound Payments (started) · UI test plan/case generation + execution (Playwright) · interactive knowledge graph · **audit trail** · **test-to-Git** pipeline.

## Out of scope (per plan)
Outbound Payments API · Kafka/BigQuery pipeline testing · full model-validation service · full governance engine + analytics dashboards (so **[D22] web-ui dashboards stay deferred**) · enterprise-wide multi-team rollout (so **[D18]** stays "per-app isolation," not full multi-tenant).

## New items this plan adds (not in the original backlog)

- **N1 — test-to-Git pipeline** *(not built)*: commit/push generated tests + results to the user-connected Git repo, every run. Needs a Git integration (e.g. `simple-git`) + repo/branch/credential config. Starts V1-rollout, runs throughout.
- **N2 — audit trail** *(partial)*: today only per-fact provenance exists; add a run-level audit log (what was generated/run/changed, when, by whom) — pairs with N1 (Git history *is* part of the audit trail).
- **N3 — Fraud (full) + Inbound Payments (started) onboarding** *(not built)*: per-target spec ingestion + exemptions; no config exists yet.
- **N4 — confirm/finalize the 3 gates** (authenticity + session-safety + self-repair are built; decide whether [A7] validator is a 4th quality gate).
- **N5 — docs + KT/handover** *(V3)*.

## Reality check & sequencing risks

- **V1 is low-risk** — most of it is already built; the real V1 work is just the unified KB ([A1]) + onboarding the Fraud spec (N3). Achievable by Wk 4.
- **The long pole is V3's restricted-env rollout** ([D17] containers, [D19] offline/vendor vis-network, [D20] egress). At HSBC these need NetSec lead time — **start [D20] egress + [D19] offline bundling in parallel from ~Wk 6**, don't wait for V3.
- **Dependency to watch:** [A4] feedback and [B12] synthesis both read the unified `knowledge.json` — so **[A1] is the gating first task**; build it before V1 rollout.
- **test-to-Git (N1) is a stated in-scope deliverable but absent from code** — slot it into V1-rollout so the "generated tests saved to Git throughout" criterion holds from the first rollout.
