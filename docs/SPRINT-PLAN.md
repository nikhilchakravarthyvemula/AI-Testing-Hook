# Sprint Plan & Task Board — Testing Harness

_For the Scrum Master (sprint plan, sizing, dependencies) and the developer picking up the work (each ticket has files, steps, acceptance, and how to test). Backlog IDs (e.g. **A1**) match `PROJECT-STATUS-AND-BACKLOG.md`; milestones match `DELIVERY-PLAN.md`._

## How to read this

- **Size:** S = ½–1 day · M = 2–3 days · L = ~1 week. (Scrum Master: S≈2pts, M≈5pts, L≈8–13pts.)
- **Every ticket's Definition of Done (global):** code + a short README in its folder; runs via `testo`; no secrets committed; lint clean (`ruff`/`black` for Python, project style for JS); a sample output committed under `output/` is git-ignored but the run is reproducible; PR reviewed.
- Sprints are 2 weeks. Detailed tickets are given for Sprints 1–4 (the near-term critical path); later milestones are listed as epics with story bullets (designs already exist in `docs/spec-01/02/03`).

## Sprint plan (maps to the 6-month milestones)

| Sprint | Weeks | Milestone | Goal | Tickets |
|---|---|---|---|---|
| **S1** | 1–2 | → V1 | Unified knowledge base + LLM portability | A1, A8, N4 |
| **S2** | 3–4 | **V1 (Wk4)** | API tests from the **Fraud** spec, 3 gates, KB synthesis | N3-Fraud, B14, B12(first pass) |
| **S3** | 5–6 | **V1 Rollout** | Feedback loop + UI test plans + test-to-Git | A4, A6, A5, N1 |
| **S4** | 7–8 | **V2 (Wk8)** | Execution Layer: run UI+API, report | A2, A3, A7 |
| **S5–S6** | 9–12 | **V2 Rollout** | Validate across APIs (Fraud full, Inbound started) | N3-Inbound, D18, N2 |
| **S7–S13** | 13–26 | **V3** | Hardening, offline/restricted, prod + handover | D19, D17, D20, C16, C15, B9–B13, N5 |

**Critical dependency:** **A1 (knowledge base) blocks A4, B12, B14** — do it first. Start **D20 (egress)** and **D19 (offline bundling)** paperwork in ~S3 because HSBC NetSec lead time is the long pole.

---

## Sprint 1 — foundation

### A1 — Build the unified Knowledge Base  · size M · blocks: A4, B12, B14
**Why:** Everything downstream (feedback, gap analysis, reporting) reads one `knowledge.json`. It doesn't exist yet — only the schema does.
**Files:** create `knowledge-base/build.mjs`, `knowledge-base/store.mjs`. Reuse `knowledge-base/schema.mjs` (exports `provenance()`, `confidenceForTier()`, `combineConfidence()`, `DiscoveryTier`). Wire a new stage into `context-layer/scan.mjs` after `indexer`.
**Steps:**
1. `build.mjs`: read every file in `output/indexed_output/*.json` (the 13 topics) and merge into one object shaped per `knowledge-base/README.md`: `{ version, generatedAt, target, sources[], facts:{ endpoints, pages, interactions, frameworks, … } }`. Carry `provenance` + `confidence` on each fact (topics already include `observations`/`consensus` — fold those in).
2. `store.mjs`: helpers `loadKnowledge()`, `saveKnowledge(kb)`, `appendFact(kb, kind, obj)` writing to `output/knowledge.json`.
3. Add `{ id:'knowledge-base', entrypoint:'knowledge-base/build.mjs' }` to `scan.mjs` STAGES after the indexer.
**Acceptance:** `testo scan …` produces `output/knowledge.json` with non-empty `facts.endpoints` and `sources[]` carrying tiers/confidence.
**How to test:** run `testo scan --url <demo>` then `node -e "const k=require('./output/knowledge.json'); console.log(k.facts.endpoints.length)"` → > 0.

### A8 — Add LLM providers to model-api-connector · size M
**Why:** Only MiniMax is implemented; we need OpenAI/Anthropic/Ollama for BYO-LLM and offline/local runs (restricted VM).
**Files:** add `infrastructure/model-api-connector/providers/{openai,anthropic,ollama}.mjs` mirroring `providers/minimax.mjs`; register them in `index.mjs` (`getClient`/`listProviders`). Keep the `ChatRequest`/`ChatResponse` shape from `types.mjs`.
**Steps:** OpenAI + Ollama are OpenAI-compatible (same JSON), so one shared client with different `base_url`/auth; Anthropic uses its messages API. Read keys/base-url from env.
**Acceptance:** `node infrastructure/model-api-connector/bin/chat.mjs --provider ollama "hello"` returns text; same for `openai`.
**How to test:** point `ollama` at a local model; smoke each provider via `bin/chat.mjs`.

### N4 — Confirm the "3 gates" · size S (decision + doc)
**Why:** V1 acceptance says "3 gates operational." They exist: **authenticity** (`indexer/verify/api-spec-verify.mjs`), **session-safety** (`is_exempt` + `api-test-exemptions.json`), **self-repair** (`api-test-generator/lib/repair.py`).
**Task:** confirm with the team these are the 3; decide whether **A7 validator** (lint/smell/coverage/LLM-judge) becomes a 4th *quality* gate. Document the gate definitions in `generation-layer/api-test-generator/README.md`.
**Acceptance:** one short section listing the 3 (or 4) gates + where each lives.

---

## Sprint 2 — V1 (Fraud spec, knowledge synthesis)

### N3-Fraud — Onboard the Fraud API spec · size M · needs: spec + non-prod test account (SM to source)
**Why:** V1 acceptance is "tests generated from the **Fraud** spec." No Fraud config exists today (repo only has demo-app data).
**Steps:** point ingestion at the Fraud spec/endpoint (`testo scan --url <fraud-non-prod>` and/or drop the OpenAPI file where `openapi-extractor` reads it); add a Fraud `api-test-exemptions.json` (session-mutating endpoints to skip); run `testo generate api-tests`.
**Acceptance:** API tests generated from the Fraud spec, **70–80% usable**, 3 gates run. **How to test:** `testo generate api-tests` → `output/generation/api-tests/results.json` shows pass/fail for Fraud endpoints.
**Blocker for SM:** obtain the Fraud spec + a non-prod base URL + test creds.

### B14 — Wire text-kg triples into the KB · size S · blocked by: A1
The extractor is already built (`content-extractor/text-kg/extract.py`). Just fold its triples into `knowledge.json` in `build.mjs` (tier `docs_extracted`). **Acceptance:** text-derived facts appear in `knowledge.json` at the lower confidence tier without overwriting `live_observed` facts.

### B12 — knowledge-synthesizer (first pass) · size M · blocked by: A1
Cross-source dedup: same endpoint seen by crawl + spec + code → one canonical fact with all observations. Start deterministic (path/method normalization, trailing-slash, `/{id}` templating). **Acceptance:** duplicate endpoints across sources collapse to one entry in `knowledge.json` with `observations[]` listing each source.

---

## Sprint 3 — V1 Rollout (feedback, UI plans, Git)

### A4 — Feedback loop · size S · blocked by: A1
**Files:** `feedback/results-to-kb.mjs`. Read `output/execution/results.json` (or `output/generation/api-tests/results.json` until A2 lands) → append to `knowledge.json#facts.testRuns[]` via `store.mjs`. **Acceptance:** after a run, `testRuns[]` grows with `{runId, at, passed, failed, perEndpoint}`. **Test:** run twice → 2 entries.

### A6 — test-plan-creator · size M
**Files:** `generation-layer/test-plan-creator/` → emit `output/generation/test-plan.json` (strategy/scope/priority per feature/endpoint). Register `testo plan` (`interfaces/cli/commands/plan.mjs` + dispatch in `testo.mjs`). For UI, derive plans from `click-graph.json` flows. **Acceptance:** `testo plan` writes a `test-plan.json` listing prioritized scenarios.

### A5 — Wire UI/E2E generation into the CLI · size S
`generation-layer/test-script-generator/{generator.mjs,e2e.mjs}` already work but aren't exposed. Add `testo generate ui-tests` (extend `commands/generate.mjs`) and register as a skill in `skill-register/registry/skill_registry.py`. **Acceptance:** `testo generate ui-tests` emits Playwright specs under `tests/`. **Cleanup note:** de-dupe vs `scripts/crawler/generator` (backlog #24) — pick one source of truth.

### N1 — test-to-Git pipeline · size M
**Why:** in-scope ("generated tests saved to Git throughout") but not built.
**Files:** `feedback/publish-to-git.mjs` (or `infrastructure/git-publisher/`). After generate/run, commit `tests/` + `output/generation/*` to a configured repo/branch using `simple-git`. Config via env: `GIT_REMOTE`, `GIT_BRANCH`, creds. **Acceptance:** a run produces a commit on the target branch with the generated tests. **Test:** point at a throwaway local repo, verify the commit.

---

## Sprint 4 — V2 (Execution Layer)

### A2 — test-executor · size L · enables: A3, A4(real results)
**Files:** `execution-layer/test-executor/run.mjs` (+ `lib/flake.mjs`). Register `testo run`.
**Steps:** add a JSON reporter to the generated Playwright config (`['json',{outputFile:'output/execution/ui-results.json'}]`); run `npx playwright test`; run the `api-test-generator` skill (or read its `results.json`); normalize both into one `output/execution/results.json` (`{status, durationMs, healed?, flaky?}`); retry failed once → classify `passed/failed/flaky`. **Acceptance:** `testo run` produces a unified `results.json` covering API + UI with a pass/fail summary.

### A3 — report-generator · size M · blocked by: A2
**Files:** `execution-layer/report-generator/build.mjs` → `output/execution/report.html`. Reuse `context-layer/graph-viewer/lib/render-html.mjs` patterns. Show pass/fail/flaky, per-test table, and (when available) gaps/coverage. Register `testo report`. **Acceptance:** `testo report` opens a self-contained HTML dashboard of the latest run.

### A7 — validator (quality gate) · size M
**Files:** `generation-layer/validator/` — ESLint/parse-check generated specs + simple smell/coverage checks (+ optional LLM-judge). Run before execution. **Acceptance:** invalid generated specs are flagged (and optionally regenerated) before they reach the runner.

---

## Sprint 5–6 — V2 Rollout (epics)

- **N3-Inbound — Inbound Payments onboarding (started)** · M — same pattern as Fraud; partial coverage acceptable.
- **D18 — Per-app output isolation** · M — parameterize the `output/` root (env `OUTPUT_ROOT` / per-job dir) so multiple target APIs run without colliding; today it's single-tenant. Foundation for running across many APIs.
- **N2 — Audit trail** · M — run-level log (who/what/when generated + run + changed); Git history (N1) is part of it. **Acceptance:** every run is reconstructable from the audit log + Git.

## Sprint 7–13 — V3 (epics; designs in `spec-01/02/03`)

- **D19 — Offline/restricted deps** · M — vendor **vis-network** (graph-viewer pulls it from jsDelivr today), Playwright browsers offline, pip/npm internal mirrors, local Ollama.
- **D17 — container-deploy** · L — Dockerfile + compose/CI worker image.
- **D20 — Egress automation** · M — proxy/FQDN allowlist + policy-gated intake + the small Playwright-proxy code change. *(Start the NetSec proposal in S3.)*
- **C16 — Self-healing execution (Module 3)** · L — `heal.mjs`/`heal-engine` + action-cache + sandboxed hooks; keeps fleets green. Spec: `spec-03`.
- **C15 — Skill-memory (Module 2)** · L — distill runs → reusable Markdown skills. Spec: `spec-02`.
- **B9–B13 — Graph analytics / interactive knowledge graph** · L — `analyze.py` (PageRank/communities) → `feature-extractor`/`gap-analyzer`/`mind-map-builder`. Spec: `spec-01`.
- **N5 — Docs + KT/handover** · M.

---

## Getting started (for the developer)

1. **Run the existing pipeline once** to see the data flow: `testo scan --url <demo-app-url>` → look in `output/indexed_output/` (the 13 topic JSONs) and `output/knowledge.json` (once A1 lands). Then `testo generate api-tests` → `output/generation/api-tests/`.
2. **Where things live:** Node side = `context-layer/`, `interfaces/cli/`, `scripts/crawler/`, `infrastructure/model-api-connector/`. Python side = `generation-layer/api-test-generator/`, `infrastructure/{agentic-harness,skill-register}/`, `content-extractor/*/extract.py`, `scripts/graphify/`.
3. **Conventions:** Node is ESM (`type:module`); Python uses **Pydantic v2** for args + **ruff/black** (line length 100). New skills register in `skill-register/registry/skill_registry.py`; new agent tools in `agentic-harness/registry/tool_registry.py`.
4. **Read first:** `docs/PROJECT-STATUS-AND-BACKLOG.md` (what exists), `docs/DELIVERY-PLAN.md` (milestones), and for your ticket's track the matching `docs/spec-01/02/03`.
5. **Don't break the working path:** the crawler + extractors + api-test-generator are live and validated — add alongside, run `testo scan`/`generate` before and after to confirm no regression.

## For the Scrum Master — at a glance

- **Now-ready (no external blockers):** A1, A8, A4, A5, A6, A2, A3, A7, N1, D18 — pure engineering against the existing code.
- **Externally blocked (need someone to provide something):** **N3-Fraud / N3-Inbound** (need the specs + non-prod URLs + test creds), **D20 egress** (NetSec), **D19 offline** (internal mirror access). Raise these in S1 so they're unblocked by the sprint that needs them.
- **Single biggest risk:** V3's restricted-env rollout (containers + offline + egress) has the longest external lead time — track it from S3, not S7.
- **First standup focus:** get **A1** moving (it gates the loop) and confirm the **Fraud spec** can be sourced for S2.
