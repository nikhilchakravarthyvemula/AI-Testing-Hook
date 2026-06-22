# Project Status & Backlog

_Where the testing harness stands today (from a full code sweep) and the prioritized work to finish it._

## TL;DR

The **left half of the pipeline is built and working** — discovery (crawl + all extractors), indexing, graphs, and deterministic API-test generation. The **right half is largely unbuilt** — there is no execution layer, no feedback loop, no unified knowledge base, and the four context-analytics components are empty scaffolds. The agent/LLM infrastructure is solid; deployment/scale (containers, multi-app, restricted-env) is not started.

In one line: **you can scan an app and generate tests, but you can't yet run them through the harness, score coverage, or feed results back — and it's single-tenant.**

## Current state (from the sweep)

| Component | Status | Notes |
|---|---|---|
| `interfaces/cli` (`testo`) | ✅ Done (partial) | `scan`, `generate`, `ask` work; `plan`, `run`, `report` not registered |
| `interfaces/web-ui` | ❌ Missing | Deferred |
| `knowledge-sources/` | 📄 README-only | Superseded in practice by `content-extractor` (the real sources live there) |
| `knowledge-base/` | 🟡 Partial | Only `schema.mjs` (tiers/provenance). No `build.mjs`, `store.mjs`, or unified `knowledge.json` |
| `context-layer/content-extractor` | ✅ Done | 117 files — crawler, graphify, db-schema, framework-extractor, mock-data, openapi, 20+ code-extractors |
| `context-layer/indexer` | ✅ Done | **13**-topic registry → `indexed_output/*.json` (incl. `api-spec`) |
| `context-layer/indexer/verify` | ✅ Done | `api-spec-verify.mjs` — LLM authenticity check: removes phantom/stripped-prefix endpoints + repairs request bodies; rewrites `api-spec.json` |
| `context-layer/graph-viewer` | ✅ Done | vis-network HTML (click-graph, ui-routes) |
| `context-layer/feature-extractor` | ❌ Empty | Module 1 target |
| `context-layer/gap-analyzer` | ❌ Empty | commented out in `scan.mjs` |
| `context-layer/knowledge-synthesizer` | ❌ Empty | cross-source dedup |
| `context-layer/mind-map-builder` | ❌ Empty | commented out in `scan.mjs` |
| `generation-layer/api-test-generator` | ✅ Done | curl API tests from the **verified** `api-spec`; **self-repair loop** (`lib/repair.py`) fixes 422/400 bodies + persists the working curl; wired via `testo generate` |
| `generation-layer/openapi-test-gen` | ✅ Done | spec-driven write/mutation API tests + exec |
| `generation-layer/test-script-generator` | 🟡 Built, not wired | `generator.mjs` (UI smoke) + `e2e.mjs` exist but aren't exposed via `testo`/skill-register (duplicate of `scripts/crawler/generator`) |
| `generation-layer/test-plan-creator` | ❌ Empty | strategy/scope/priority |
| `generation-layer/mock-data-creator` | ❌ Empty | (note: `content-extractor/mock-data-extractor` exists) |
| `generation-layer/validator` | ❌ Empty | lint/smell/coverage/LLM-judge |
| `execution-layer/test-executor` | ❌ Empty | no runner |
| `execution-layer/report-generator` | ❌ Empty | no dashboard |
| `feedback/` | 📄 README-only | `results-to-kb.mjs` not built (no loop) |
| `infrastructure/model-api-connector` | 🟡 Partial | only MiniMax provider implemented (OpenAI/Anthropic/Ollama listed, not built) |
| `infrastructure/agentic-harness` | ✅ Done | OpenHarness wrapper, BackendResolver, tools |
| `infrastructure/skill-register` | ✅ Done | skill catalog + service |
| `infrastructure/container-deploy` | ❌ Empty | no Docker/CI |
| `infrastructure/postgresql` | ❌ Empty | KB datastore deferred (JSON today) |
| `scripts/crawler`, `scripts/graphify` | ✅ Done | the working engines behind the extractors |

Legend: ✅ done · 🟡 partial · ❌ empty/missing · 📄 README-only.

## Backlog (prioritized by track)

### Track A — Close the core loop (critical path: scan → generate → run → report → feedback)

1. **Knowledge Base build/store** — write `knowledge-base/build.mjs` + `store.mjs` to merge `indexed_output/*` into a unified `knowledge.json` with provenance/confidence (`schema.mjs` already defines the model). *Foundational — feedback, gap-analyzer, and reporting all read it.*
2. **Execution Layer — test-executor** — `execution-layer/test-executor/run.mjs`: run Playwright specs + the api-test-generator, add a JSON reporter, normalize both into one `results.json` (+ retry/flake classify). Register **`testo run`**.
3. **Execution Layer — report-generator** — unified HTML dashboard (reuse `graph-viewer/render-html`): pass/fail/flaky + gaps + coverage. Register **`testo report`**.
4. **Feedback loop** — `feedback/results-to-kb.mjs`: parse run results → append `testRuns[]` to `knowledge.json`. *This is the "results inform KB" arrow — currently missing.*
5. **Wire UI/E2E generation into the CLI** — expose `test-script-generator` (`generator.mjs`/`e2e.mjs`) via `testo generate ui-tests` and register it as a skill (today it's orphaned).
6. **test-plan-creator** — `generation-layer/test-plan-creator` → `test-plan.json` (strategy/scope/priority). Register **`testo plan`**.
7. **validator** — `generation-layer/validator`: ESLint/parse-check + smell/coverage (+ optional LLM-judge) gate before execution.
8. **model-api-connector providers** — add `openai`/`anthropic`/`ollama` providers (only MiniMax exists). *Unblocks BYO-LLM and offline/local runs.*

### Track B — Context analytics (= Module 1; spec in `docs/spec-01-kg-graph-analytics.md`)

9. **graph-analytics/analyze.py** — NetworkX over `click-graph.json`: PageRank/betweenness/Louvain → `graph-analytics.json`.
10. **feature-extractor** — communities → `features.json`.
11. **gap-analyzer** — coverage diffs + orphans → `gaps.json`; **add its stage to `scan.mjs`** (it's only named in a header comment today — nothing to uncomment).
12. **knowledge-synthesizer** — cross-source entity canonicalization/dedup.
13. **mind-map-builder** — GraphML + Mermaid scenario tree; add its stage to `scan.mjs` (same — not commented, must be added).
14. **text-kg → KB synthesis** — the extractor is **already built** (`content-extractor/text-kg/extract.py`, kg-gen MIT, + jira/confluence); remaining work is wiring its triples into the unified `knowledge.json` (depends on #1).

### Track C — Learning & robustness (= Modules 2 & 3; specs `spec-02`, `spec-03`)

15. **Skill-memory loop (Module 2)** — `skill-distiller` → `memory/skills/*.md` store → `get_skill`/`select.py`/`consolidate`.
16. **Self-healing execution (Module 3)** — `heal.mjs` + `heal-engine` + action-cache + flake manager + sandboxed hooks (builds on A2). *Essential for running 100s of suites without per-app babysitting.*

### Track D — Deployment & scale (the HSBC rollout)

17. **container-deploy** — Dockerfile + compose/K8s + CI; the worker image.
18. **Multi-app automation** — self-service intake (URL + creds), **per-app output isolation** (parameterize the `output/` root — today it's single-tenant), job queue + worker pool.
19. **Restricted/offline deployment** — internal pip/npm mirrors, local Ollama, Playwright browsers offline, **vendor vis-network** (graph-viewer currently pulls it from jsDelivr).
20. **Egress automation** — proxy/FQDN allowlist + policy-gated intake (+ the small Playwright-proxy code change). NetSec proposal.
21. **PostgreSQL/pgvector KB** *(optional)* — replace the JSON KB once scale demands it.
22. **web-ui** *(deferred)* — dashboard / test config / results / KB explorer.

### Track E — Hygiene / cleanup

23. **Reconcile `knowledge-sources/`** — it's a README-only layer superseded by `content-extractor`; either implement the thin wrappers or fold it into docs to avoid confusion.
24. **De-duplicate generators** — `scripts/crawler/generator` vs `generation-layer/test-script-generator` are near-duplicates; pick one as the source of truth.
25. **`mock-data-creator`** — decide: implement, or delete the empty dir and point consumers at `content-extractor/mock-data-extractor`.
26. **Harness self-tests** — there are tests *generated for targets* but few for the harness itself; add unit/smoke tests for extractors, indexer, and the new executor.
27. **TODO.md item** — LLM button classification / safe-click long-tail (regex pass already done).

## Suggested sequence

- **Milestone 1 — end-to-end loop (Track A: 1→2→3→4, plus 5 and 8).** After this, `testo scan → generate → run → report` works and results feed back. This is the highest-leverage chunk.
- **Milestone 2 — smarter targeting (Track B: 9→11).** Risk-ranked generation + gap/coverage reporting.
- **Milestone 3 — fleet-ready (Track C 16 + Track D 17→20).** Self-healing + containerized multi-app + restricted-env deploy — required before running 100s of apps at HSBC.
- **Milestone 4 — durability (Track C 15, Track B 12–14, Track D 21–22).** Memory, synthesis, persistent KB, UI.

Detailed designs for Tracks B and C already exist in `docs/spec-01/02/03`; deployment specifics are in this session's notes (offer stands to write `docs/DEPLOY-restricted.md` / `EGRESS-AUTOMATION.md`).

## Recent updates (generation-side hardening)

Completed since the sweep — refinements within the ✅ rows above, not new modules:
- **Unified intelligent login** — one LLM classifier (SSO vs normal) with concrete selectors/steps in `scripts/crawler/lib/auth-classify.mjs`; removed `login-once.mjs` + `--sso`; added `--no-LLM`; auto-escalates to a headed browser only for genuine MFA/CAPTCHA.
- **Intent-extraction perf** — global+page dedup + table-row cap + concurrency: ~81 min → ~30s on a 34-page crawl.
- **api-spec verifier** — `indexer/verify/api-spec-verify.mjs`: generic phantom/stripped-prefix removal + request-body repair; rewrites `api-spec.json` + sidecar report.
- **API-test self-repair** — `api-test-generator/lib/repair.py`: on 422/400, fixes the body from the server's validation error and re-runs (≤3 attempts), persisting the working curl.
- **route-tree** wired into the crawler's `npm run all`.
