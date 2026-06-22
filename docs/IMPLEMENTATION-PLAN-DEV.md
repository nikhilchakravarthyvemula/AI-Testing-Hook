# Implementation Plan — Developer Perspective

_A build-oriented map of the whole testing harness: what exists, what to build, where each piece lives, the files/functions to add, and how they wire into the existing data flow. Grounded in a full code sweep of this repo (paths and functions below are real unless marked **(new)**)._

Companion docs: `PROJECT-STATUS-AND-BACKLOG.md` (status + backlog), `schedule-plan.md` (dated plan), `spec-01/02/03` (designs for analytics, skill-memory, self-healing).

---

## 1. How the system fits together (the spine)

Everything hangs off one CLI dispatcher and one data folder. A scan turns inputs into per-topic JSON; generation reads that JSON to emit tests; execution (to build) runs them; feedback (to build) writes results back into a unified knowledge base.

```
testo <cmd>                         interfaces/cli/testo.mjs  → commands/<cmd>.mjs
  │
  ├─ scan ─────────► context-layer/scan.mjs   (STAGES orchestrator)
  │                    1) content-extractor/run.mjs  ─ auto-discovers source folders, runs them in parallel stages
  │                         ↳ crawler, graphify, framework-extractor, db-schema, mock-data, openapi, text-kg, jira, confluence
  │                         → output/{crawler,graphify,code-extractors,db-schema,mock-data,openapi,…}/*
  │                    2) indexer/index.mjs           ─ TOPIC_REGISTRY merges sources → per-topic indices
  │                         → output/indexed_output/<topic>.json (+ index.json)
  │                         ↳ verify/api-spec-verify.mjs rewrites api-spec.json (authenticity gate)
  │                    3) graph-viewer/index.mjs       → output/indexed_output/graphs/*.html
  │
  ├─ generate api-tests ─► commands/generate.mjs → skill-register/bin/call_skill.py → generation-layer/api-test-generator/skill.py
  │                         reads output/indexed_output/api-spec.json → writes output/generation/api-tests/* (+ runs them)
  │
  ├─ ask ──────────────► commands/ask.mjs → agentic-harness (LLM tool-calling over the indexed output)
  │
  ├─ plan   (NEW)  ────► test-plan-creator
  ├─ run    (NEW)  ────► execution-layer/test-executor
  └─ report (NEW)  ────► execution-layer/report-generator
```

The **left half** (scan → index → generate) is built. The **right half** (run → report → feedback → unified KB) and the **context-analytics** sub-modules are empty scaffolds. That asymmetry is the whole job.

### Three extension patterns you'll reuse constantly

1. **Add a discovery source** — drop a folder under `context-layer/content-extractor/<id>/` containing `extract.mjs` or `extract.py`. `run.mjs` auto-discovers it; add an env gate in its `GATES` map if it needs an input. No registration code.
2. **Add an index topic** — drop `context-layer/indexer/topics/<name>.mjs` exporting `build(sources)` → `IndexedItem[]`, and add one line to `TOPIC_REGISTRY` in `indexer/index.mjs`.
3. **Add a context stage** — append `{ id, entrypoint, description }` to the `STAGES` array in `context-layer/scan.mjs` (this is exactly where gap-analyzer / mind-map-builder slot in — they're already stubbed as comments there).

Plus: **add a CLI command** = new `interfaces/cli/commands/<cmd>.mjs` + a case in `testo.mjs`; **add a generation kind** = new entry in the `KINDS` map in `commands/generate.mjs` + a skill; **add a skill** = folder under a layer with a `skill.py`, callable via `skill-register/bin/call_skill.py`.

---

## 2. Status at a glance (module → state → where)

| # | Module | State | Lives in |
|---|---|---|---|
| — | CLI (`scan`/`generate`/`ask`) | ✅ done | `interfaces/cli/` |
| — | Content-extractor (crawler, graphify, 20+ code-extractors, db-schema, mock-data, openapi, text-kg, jira, confluence) | ✅ done | `context-layer/content-extractor/` (incl. crawler), `scripts/graphify/` |
| — | Indexer (13 topics) + api-spec verifier | ✅ done | `context-layer/indexer/` |
| — | Graph-viewer | ✅ done | `context-layer/graph-viewer/` |
| — | API-test generator (+ self-repair) + OpenAPI test-gen | ✅ done | `generation-layer/api-test-generator/`, `openapi-test-gen/` |
| — | Agentic harness, skill-register | ✅ done | `infrastructure/agentic-harness/`, `skill-register/` |
| A1 | Knowledge Base build/store | ❌ empty (only `schema.mjs`) | `knowledge-base/` |
| A2 | Execution Layer — test-executor | ❌ empty | `execution-layer/test-executor/` |
| A3 | Execution Layer — report-generator | ❌ empty | `execution-layer/report-generator/` |
| A4 | Feedback loop | ❌ README-only | `feedback/` |
| A5 | Wire UI/E2E gen into CLI | 🟡 built, unwired | `generation-layer/test-script-generator/` |
| A6 | test-plan-creator | ❌ empty | `generation-layer/test-plan-creator/` |
| A7 | validator | ❌ empty | `generation-layer/validator/` |
| A8 | model-api-connector providers | 🟡 MiniMax only | `infrastructure/model-api-connector/providers/` |
| B9–13 | Context analytics (graph-analytics, feature-extractor, gap-analyzer, knowledge-synthesizer, mind-map-builder) | ❌ empty | `context-layer/{feature-extractor,gap-analyzer,knowledge-synthesizer,mind-map-builder}/` |
| B14 | text-kg → KB synthesis | 🟡 extractor done, wiring left | `context-layer/content-extractor/text-kg/` |
| C15 | Skill-memory loop (Module 2) | ❌ empty | `infrastructure/skill-register/` (+ memory store) |
| C16 | Self-healing execution (Module 3) | ❌ empty | `execution-layer/` |
| D17–20 | container-deploy, multi-app, offline, egress | ❌ empty | `infrastructure/container-deploy/`, cross-cutting |
| D21 | PostgreSQL/pgvector KB (optional) | ❌ empty | `infrastructure/postgresql/` |
| D22 | web-ui (deferred) | ❌ missing | `interfaces/web-ui/` |
| E23–27 | Hygiene (reconcile knowledge-sources, de-dup generators, mock-data-creator, tests, button-classify) | ❌ mixed | various |

Legend: ✅ done · 🟡 partial · ❌ empty/missing.

---

## 3. Work bundled by module

Each entry: **what** to build, **where** it lives, **files & functions** to add (new unless noted), **interlinks** (reads ←, writes →, upstream/downstream), and **reuse** (existing code to lift from). Bundles are ordered by dependency — earlier bundles unblock later ones.

### Bundle 1 — Knowledge Base (foundational; unblocks feedback, gap-analyzer, reporting)

**A1 · Knowledge Base build/store**
- **What:** merge every `output/indexed_output/*.json` into one provenance-tagged `knowledge.json`; expose read/write helpers.
- **Where:** `knowledge-base/build.mjs` **(new)**, `knowledge-base/store.mjs` **(new)**. `schema.mjs` already exists.
- **Files & functions:** `build.mjs` → `buildKnowledge(repoRoot)` reads the indexer's topic files via the same `loadAllSources`-style read, attaches `provenance({sourceId,tier,extractedBy})` from `schema.mjs`, dedups by stable key, writes `output/knowledge-base/knowledge.json`. `store.mjs` → `loadKnowledge()`, `saveKnowledge(kb)`, `appendTestRuns(runs)`, `upsertEntities(kind, items)`.
- **Interlinks:** ← `output/indexed_output/*.json` (apis, pages, routes, click-graph, api-spec, db-schema, models…). → `output/knowledge-base/knowledge.json`. Downstream readers: feedback (A4), gap-analyzer (B11), report-generator (A3), `ask`.
- **Wire-in:** add a `{ id:'knowledge-base', entrypoint:'knowledge-base/build.mjs' }` stage to `context-layer/scan.mjs` STAGES, right **after** `indexer`.
- **Reuse:** `schema.mjs` (provenance/confidence), `indexer/lib/sources.mjs` read pattern.

### Bundle 2 — Execution Layer (close the loop: run → report)

**A2 · test-executor** — _critical path._
- **What:** one runner that executes the Playwright UI specs **and** the api-test-generator suite, normalizes both into a single `results.json` with retry/flake classification.
- **Where:** `execution-layer/test-executor/run.mjs` **(new)** (+ `lib/normalize.mjs`, `lib/flake.mjs` new).
- **Files & functions:** `run.mjs` → `runAll({suites, retries})`; `runPlaywright(dir)` shells the generated specs; `runApiTests()` invokes the api-test-generator in execute mode; `normalize(raw)` → unified `{id,type,status,durationMs,attempts,error}`; `classifyFlake(attempts)`.
- **Interlinks:** ← `output/generation/api-tests/*`, ← `output/crawler/tests/*` (Playwright specs from test-script-generator once wired, A5). → `output/execution/results.json`. Downstream: report-generator (A3), feedback (A4).
- **CLI:** add `interfaces/cli/commands/run.mjs` **(new)** + register `run` in `testo.mjs`.
- **Reuse:** `generation-layer/api-test-generator/lib/test_runner.py` (curl exec loop) and `lib/reporter.py` (result shaping) — lift the result schema from there so api + UI results share one shape.

**A3 · report-generator**
- **What:** single HTML dashboard — pass/fail/flaky + coverage + gaps.
- **Where:** `execution-layer/report-generator/render.mjs` **(new)**.
- **Files & functions:** `render.mjs` → `renderReport({results, gaps, coverage})` → standalone HTML.
- **Interlinks:** ← `output/execution/results.json`, ← `output/knowledge-base/knowledge.json` (coverage), ← `gaps.json` (B11). → `output/execution/report.html`.
- **CLI:** add `commands/report.mjs` **(new)** + register `report`.
- **Reuse:** `context-layer/graph-viewer/lib/render-html.mjs` (self-contained HTML scaffold + inlining) — clone its render approach so the report is a single portable file.

**A5 · Wire UI/E2E generation into the CLI**
- **What:** expose the already-built UI smoke + e2e generator that's currently orphaned.
- **Where:** `generation-layer/test-script-generator/{generator.mjs,e2e.mjs}` (exist, 496 + 811 lines). 
- **Files & functions:** add a `KINDS['ui-tests'] = { skill:'test-script-generator', … }` entry in `commands/generate.mjs`; add a thin `skill.py`/adapter so skill-register can invoke `generator.mjs`. 
- **Interlinks:** ← `output/indexed_output/{pages,routes,interactions}.json`. → `output/crawler/tests/*` (consumed by A2).
- **Reuse:** the existing generator is done — this is wiring + de-dup against `scripts/crawler/generator` (see E24), not a rewrite.

### Bundle 3 — Feedback loop (results inform the KB)

**A4 · feedback/results-to-kb**
- **What:** the missing "results → knowledge" arrow.
- **Where:** `feedback/results-to-kb.mjs` **(new)** (replaces the README-only folder).
- **Files & functions:** `resultsToKb()` reads results, calls `appendTestRuns()` from `knowledge-base/store.mjs` (A1), updates per-endpoint pass/fail history + coverage flags.
- **Interlinks:** ← `output/execution/results.json`. → appends `testRuns[]` into `output/knowledge-base/knowledge.json`. Closes the loop feeding gap-analyzer (B11) and reporting (A3).
- **Wire-in:** call from `commands/run.mjs` after execution, or as a final context stage.

### Bundle 4 — Context analytics (= Module 1; design in `spec-01`)

All five slot into `context-layer/scan.mjs` STAGES between `indexer` and `graph-viewer`. They read the indexer's `click-graph.json`/`apis.json`/`pages.json` and emit new topic files.

**B9 · graph-analytics**
- **What:** NetworkX over the click-graph — PageRank / betweenness / Louvain communities → importance + clusters.
- **Where:** `context-layer/graph-analytics/analyze.py` **(new)** (+ `extract.mjs` shim so `run.mjs` auto-discovers it, or a STAGES entry).
- **Functions:** `load_graph(click_graph_json)`, `compute_centrality()`, `detect_communities()`, `score_importance()` → `output/indexed_output/graph-analytics.json`.
- **Interlinks:** ← `output/indexed_output/click-graph.json`. → `graph-analytics.json`. Downstream: feature-extractor (B10), gap-analyzer (B11), test-plan-creator (A6).
- **Reuse:** `endpoint-graph.mjs` (parked, git `9f904d7`) and `content-extractor/crawler/analyze.mjs` — port the graph-building, add metrics.

**B10 · feature-extractor**
- **What:** turn communities into named features (cluster of pages+endpoints).
- **Where:** `context-layer/feature-extractor/extract.py|mjs` **(new)**.
- **Functions:** `groupFeatures(graphAnalytics, pages, apis)` → `features.json`.
- **Interlinks:** ← `graph-analytics.json`, `pages.json`, `apis.json`. → `output/indexed_output/features.json`. Downstream: test-plan-creator, mind-map-builder.

**B11 · gap-analyzer**
- **What:** coverage diffs + orphans (endpoints/pages with no test or no inbound link).
- **Where:** `context-layer/gap-analyzer/analyze.mjs` **(new)** — already stubbed as a comment in `context-layer/scan.mjs` STAGES.
- **Functions:** `findGaps({apis, pages, knowledge})` comparing discovered vs covered → `gaps.json`.
- **Interlinks:** ← `apis.json`, `pages.json`, `output/knowledge-base/knowledge.json` (testRuns coverage, A1/A4). → `output/indexed_output/gaps.json`. Downstream: report-generator, test-plan-creator.

**B12 · knowledge-synthesizer**
- **What:** cross-source entity canonicalization/dedup (same endpoint seen by crawler + code + spec → one record).
- **Where:** `context-layer/knowledge-synthesizer/synthesize.mjs` **(new)**.
- **Functions:** `canonicalize(items)`, `mergeDuplicates(byKey)`. Runs **before** KB build (A1) or as its first pass.
- **Interlinks:** ← `output/indexed_output/*`. → normalized records consumed by `knowledge-base/build.mjs`.

**B13 · mind-map-builder**
- **What:** GraphML + Mermaid scenario tree of the app.
- **Where:** `context-layer/mind-map-builder/build.mjs` **(new)** — also stubbed in `context-layer/scan.mjs`.
- **Functions:** `buildMindMap({routes, features, redirects})` → GraphML + `.mermaid`.
- **Interlinks:** ← `routes.json`, `features.json`, `redirects.json`. → `output/indexed_output/mind-map.{graphml,mermaid}`.
- **Reuse:** `mindmap.mjs` (parked, git `9f904d7`) and `content-extractor/crawler/route-tree.mjs` — port into the context-layer module.

**B14 · text-kg → KB synthesis** — extractor is **done** (`content-extractor/text-kg/extract.py`, kg-gen); remaining work is folding its triples into `knowledge.json` during A1. Pure wiring.

### Bundle 5 — Generation completeness

**A6 · test-plan-creator** — `generation-layer/test-plan-creator/` **(new)** → `test-plan.json` (strategy/scope/priority) from analytics + gaps. Register `testo plan` (`commands/plan.mjs`). ← `graph-analytics.json`, `features.json`, `gaps.json`. → `output/generation/test-plan.json`. Downstream: executor prioritization.

**A7 · validator** — `generation-layer/validator/` **(new)**: ESLint/parse-check + smell/coverage (+ optional LLM-judge) gate **before** execution. ← generated specs in `output/generation/*`. → `validation-report.json` (block on hard errors). Hook into `commands/run.mjs` pre-flight.

**A8 · model-api-connector providers** — add `infrastructure/model-api-connector/providers/{openai,anthropic,ollama}.mjs` **(new)** mirroring `providers/minimax.mjs`; register them in `index.mjs` (the provider switch) and `types.mjs`. Unblocks BYO-LLM + offline (Ollama) runs. ← env keys. Used by graphify, crawler LLM-advisor, agentic-harness.

**E25 · mock-data-creator** — decide: implement under `generation-layer/mock-data-creator/`, or delete and point at the existing `content-extractor/mock-data-extractor`. Recommended: delete + redirect (the data already exists in `output/mock-data/`).

### Bundle 6 — Learning & resilience (Modules 2 & 3)

**C15 · Skill-memory loop (Module 2; design in `spec-02`)**
- **What:** distill successful runs into reusable skills; recall them on the next run.
- **Where:** `infrastructure/skill-register/` extension + a markdown memory store at `memory/skills/*.md` **(new)**.
- **Functions:** `skill-distiller` (run trace → skill doc), `get_skill(query)`, `select.py` (rank), `consolidate` (merge/prune). Build on the existing `skill_registry.py` + `skill_service.py`.
- **Interlinks:** ← `output/execution/results.json` + traces. → `memory/skills/*.md`. Downstream: agentic-harness injects recalled skills into prompts.

**C16 · Self-healing execution (Module 3; design in `spec-03`)**
- **What:** when a locator breaks, re-find it; cache working actions; manage flakes; sandbox hooks. Essential for running 100s of suites unattended.
- **Where:** `execution-layer/heal.mjs` + `execution-layer/heal-engine/` **(new)**; builds on A2.
- **Functions:** `healLocator(failure, dom)`, `actionCache` (persist working selectors), `flakeManager`, sandboxed pre/post hooks.
- **Interlinks:** ← executor failures (A2). → patched selectors + `heal-events.json`; feeds the action-cache and (optionally) skill-memory.

### Bundle 7 — Deployment & scale (HSBC rollout)

**D17 · container-deploy** — `infrastructure/container-deploy/` **(new)**: Dockerfile (Node+Python+Playwright), compose/K8s, CI; the worker image. Pins the two venvs (`content-extractor/_lib/.venv`, `scripts/graphify/.venv`).

**D18 · Multi-app automation** — self-service intake (URL + creds), **per-app output isolation**: today everything writes to a single `output/` root (see `run.mjs`/indexer). Parameterize it (`OUTPUT_ROOT` env → `output/<appId>/…`) across `content-extractor/run.mjs`, `indexer/index.mjs`, `context-layer/scan.mjs`, generation paths. Add a job queue + worker pool.

**D19 · Restricted/offline deployment** — internal pip/npm mirrors, local Ollama (needs A8), Playwright browsers pre-installed, and **vendor vis-network**: `context-layer/graph-viewer/lib/render-html.mjs` currently pulls vis-network from a CDN — bundle it locally for air-gapped VMs.

**D20 · Egress automation** — proxy/FQDN allowlist + policy-gated intake; the small Playwright-proxy change lives in `scripts/crawler/crawl.mjs` (launch options). NetSec proposal doc.

**D21 · PostgreSQL/pgvector KB (optional)** — `infrastructure/postgresql/` **(new)**: swap the JSON KB (`store.mjs`) for a DB-backed store behind the same `loadKnowledge/saveKnowledge` interface once scale demands it. _Deferred past Sep 30._

**D22 · web-ui (deferred)** — `interfaces/web-ui/` dashboard / test config / results / KB explorer. _Deferred past Sep 30._

### Bundle 8 — Hygiene / cleanup

**E23** reconcile `knowledge-sources/` (README-only, superseded by `content-extractor`) — fold into docs. **E24** de-duplicate `scripts/crawler/generator` vs `generation-layer/test-script-generator` — pick one source of truth (do this with A5). **E26** add tests for the extractors + the new runner. **E27** LLM button-classification + safe-click pass (`scripts/crawler/classify.mjs` + `safe-click.mjs`, fully specced in `TODO.md`).

**E28 · Crawler relocated + post-crawl scripts parked.** The **live** crawler engine moved out of `scripts/crawler/` into `context-layer/content-extractor/crawler/` (its only caller — `extract.mjs` — now lives beside it and invokes the stages directly; the npm-`all` seam is gone). `scripts/crawler/` was removed. The dead `llm-advisor/clickable-suggest.mjs` handler was deleted.

The following were **post-crawl / enhancement** scripts, *not* part of the live pipeline. They are deliberately **not** in the crawler — they belong to an end-of-pipeline post-stage and should be re-homed into the proper context-layer modules when that work is scheduled. Source preserved in git history (initial commit `9f904d7`):

| Parked script | Was | Re-home into (end-stage) |
|---|---|---|
| `mindmap.mjs` | app mindmap + redirect flowchart | `context-layer/mind-map-builder/` |
| `graph-viewer.mjs` | standalone interactive graph HTML | `context-layer/graph-viewer/` (already the live renderer) |
| `endpoint-graph.mjs` | endpoint dependency graph | Module 1 context-analytics (Bundle 4) |
| `synthesize-urls.mjs` + `deep-crawl.mjs` | deeper second-pass crawl (mine detail-URL ids from captured list APIs, re-crawl) | optional crawler enhancement — fold a `--deep` pass into `crawl.mjs` |

---

## 4. Already built (the foundation you build on)

These are done and verified in the sweep — the plan extends them, it doesn't redo them.

| Capability | Lives in |
|---|---|
| `testo` CLI — scan / generate / ask | `interfaces/cli/testo.mjs`, `commands/{scan,generate,ask}.mjs` |
| Crawler engine (BFS + network capture + safe-click) | `context-layer/content-extractor/crawler/crawl.mjs`, `walker/{worker,scanner,pool,state}.mjs` |
| Graphify code-graph extractor + run engine | `scripts/graphify/{tool,agent,with_minimax}.py` |
| DB-schema extractor (AST + LLM) | `context-layer/content-extractor/db-schema/{deterministic,llm}/` |
| Framework detection + 20+ code-extractors | `content-extractor/framework-extractor/`, `content-extractor/code-extractors/*`, `_lib/testing_agent/.../extractors/{frontend,backend,facts,specs}/` |
| Mock-data + OpenAPI extractors | `content-extractor/{mock-data-extractor,openapi-extractor}/` |
| Text-kg + Jira + Confluence extractors | `content-extractor/{text-kg,jira,confluence}/` |
| Indexer — 13 topics | `context-layer/indexer/index.mjs`, `topics/*.mjs`, `lib/sources.mjs` |
| API-spec verifier (authenticity gate) | `context-layer/indexer/verify/api-spec-verify.mjs` |
| Intelligent login classifier | `scripts/crawler/lib/auth-classify.mjs`, `llm-advisor/auth-detector.mjs` |
| Intent-extraction perf tuning | `scripts/crawler/llm-advisor/intent-extract.mjs` |
| Route-tree | `scripts/crawler/route-tree.mjs` |
| Graph viewer (interactive HTML) | `context-layer/graph-viewer/index.mjs`, `lib/render-html.mjs`, `lib/shapers/*` |
| API-test generator + self-repair loop | `generation-layer/api-test-generator/skill.py`, `lib/{repair,test_runner,reporter,request_synth,curl_builder,login_flow,exemptions}.py` |
| OpenAPI write/mutation test-gen | `generation-layer/openapi-test-gen/*.mjs` |
| Agentic harness (LLM tool-calling) | `infrastructure/agentic-harness/agentic_harness/{services,registry,backends,tools}/` |
| Skill register | `infrastructure/skill-register/skill_register/`, `bin/call_skill.py` |
| Model connector (MiniMax) | `infrastructure/model-api-connector/{index.mjs,providers/minimax.mjs,types.mjs}` |
| Provenance / confidence schema | `knowledge-base/schema.mjs` |

---

## 5. Total-project plan (phased critical path)

Built work above + the bundles below = the whole project. Phases are dependency-ordered; within a phase, items run in parallel. This maps onto the dated plan in `schedule-plan.md` (Mon–Fri weeks, kickoff May 15, deadline Sep 30 — currently finishing Sep 25).

| Phase | Goal | Bundles / modules | Unblocks |
|---|---|---|---|
| **0 — done** | Scan → index → generate works | (foundation, §4) | everything |
| **1 — foundation** | Unified KB + pluggable LLMs | **A1** KB build/store · **A8** providers | feedback, analytics, offline |
| **2 — close the loop** | run → report → results-in-KB | **A2** executor · **A5** wire UI-gen · **A3** report · **A4** feedback | a real end-to-end test cycle |
| **3 — analytics (Module 1)** | importance, features, gaps, mind-map | **B9–B14** | smart planning + coverage |
| **4 — generation quality** | plan + pre-exec gate | **A6** test-plan · **A7** validator | prioritized, validated suites |
| **5 — resilience (Modules 2 & 3)** | learn + self-heal | **C15** skill-memory · **C16** self-healing | unattended 100s-of-apps runs |
| **6 — deploy & scale** | containerized, multi-app, offline | **D17–D20** | HSBC rollout |
| **cleanup (continuous)** | hygiene + tests | **E23, E24, E26, E27** | maintainability |
| **deferred (post Sep 30)** | optional | **D21** Postgres KB · **D22** web-ui | scale / UX |

**Hard critical path:** `A1 (KB) → A2 (executor) → A4 (feedback) → B11 (gaps) → A3 (report)`. Everything else parallelizes around it. A1 and A8 should start first because the most modules depend on them.

---

## 6. Build cheatsheet (where to plug in)

- **New discovery source:** `content-extractor/<id>/extract.{mjs,py}` → auto-discovered by `run.mjs`; add a gate to its `GATES` map if it needs an input.
- **New index topic:** `indexer/topics/<name>.mjs` exporting `build(sources)`; add one line to `TOPIC_REGISTRY` in `indexer/index.mjs`.
- **New context stage:** append to `STAGES` in `context-layer/scan.mjs` (gap-analyzer / mind-map-builder placeholders already there).
- **New CLI command:** `interfaces/cli/commands/<cmd>.mjs` + a case in `testo.mjs`.
- **New generation kind:** add to `KINDS` in `commands/generate.mjs` + a `skill.py`.
- **New skill:** folder with `skill.py`, invoked via `skill-register/bin/call_skill.py <skill> --mode direct`.
- **New LLM provider:** `model-api-connector/providers/<name>.mjs` mirroring `minimax.mjs`, registered in `index.mjs`.
- **Per-app isolation (D18):** thread an `OUTPUT_ROOT` env through `run.mjs`, `indexer/index.mjs`, `context-layer/scan.mjs`, and generation paths instead of the hardcoded `output/`.

_All paths verified against the codebase on this branch; items marked **(new)** do not yet exist and are the work to be done._

---

## 7. Skills-first refactor (revised approach)

**Decision:** the core pipeline capabilities become **registered skills** invoked through one seam (`SkillService`), instead of bespoke subprocess spawns scattered across `scan.mjs` / `run.mjs` / `generate.mjs`. This makes them uniform, testable, and — once the harness bridge (§8) lands — **callable by the LLM agent**.

**The pattern already exists** (`infrastructure/skill-register/`): a skill is `name` + `async execute(args) → result` (`ISkill` in `skill_register/interfaces.py`); inputs/outputs are pydantic `*Args`/`*Result` models with an `ok` field; you register it by adding a row to `REGISTERED_SKILLS` in `skill_register/registry/skill_registry.py`; you call it via `SkillService.invoke_direct()` or `bin/call_skill.py <name> --mode direct`. Today only **`api-test-generator`** is registered — it already reads `indexed_output/{apis,api-spec,db-schema}.json` + `output/mock-data/bundle.json` and self-repairs invalid bodies (`lib/repair.py`). We extend that pattern to four capabilities.

> Note on runtimes: `skill-register` loads **Python** skill files. JS engines (the indexer) get a thin Python skill that shells `node`; Python engines (mock-data synth, validator) are native and can reuse `api-test-generator/lib/*`.

### Skill 1 — `output-indexer` (replaces the bespoke indexer spawn)
- **What:** wrap the indexer (`context-layer/indexer/index.mjs`, the `TOPIC_REGISTRY` engine + `verify/api-spec-verify.mjs`) as a skill so "build the indexed output" is a uniform call.
- **Where:** `context-layer/indexer/skill.py` **(new)** — Python wrapper that runs `node index.mjs` and reads back `output/indexed_output/index.json`.
- **Files & functions:** `IndexerSkill` (`name="output-indexer"`), `IndexerArgs(out_dir, only_topics?, verify=True)`, `IndexerResult(ok, topics, item_count, out_dir)`. `execute()` → `asyncio.to_thread` → `subprocess(node …/index.mjs)` → parse summary.
- **Interlinks:** ← `output/{crawler,graphify,code-extractors,db-schema,mock-data,openapi}/…`. → `output/indexed_output/*.json` (+ `index.json`). 
- **Replaces:** the direct `node index.mjs` stage call in `context-layer/scan.mjs` → becomes `call_skill output-indexer`.

### Skill 2 — `mock-data` (replaces inline body synthesis; also closes E25)
- **What:** one skill that produces per-endpoint request/response mock bodies from observed samples + schema, shared by api-test-gen and the validator.
- **Where:** `generation-layer/mock-data-creator/skill.py` **(new)** — native Python (fills the empty `mock-data-creator` dir, resolving **E25**).
- **Files & functions:** `MockDataSkill` (`name="mock-data"`), `MockDataArgs(api_spec_json, db_schema_json, mock_bundle, openapi_json)`, `MockDataResult(ok, endpoints, out_path)`. **Reuse** `api-test-generator/lib/request_synth.py` (`synthesize_body`, `load_mock_data_index`, `load_openapi_index`, `load_api_spec_index`) — lift that synth into this skill so it's the single source of mock bodies.
- **Interlinks:** ← `output/mock-data/bundle.json` (crawler-observed), `output/indexed_output/{api-spec,db-schema,openapi}.json`. → `output/mock-data/synth.json`.
- **Replaces:** the per-call body synthesis currently inside `api-test-generator` → both api-test-gen and validator now consume this skill's output.

### Skill 3 — `api-test-generator` (already a skill — keep, re-point)
- **Status:** ✅ exists (`generation-layer/api-test-generator/skill.py`, `ApiTestGeneratorSkill`/`Args`/`Result`). Reads indexed output + mock-data, builds/executes curls, repairs 422/400 bodies (`lib/repair.py`, ≤3 attempts).
- **Change:** consume **Skill 2**'s `synth.json` for bodies instead of inline `request_synth`; keep being invoked via `SkillService` (already is, through `generate.mjs → call_skill.py`). No rewrite.

### Skill 4 — `test-validator` (new; realizes SOT module **A7** as a skill)
- **What:** validate generated test scripts against `output` + mock-data **before/after** execution, and **recreate on issues** (invalid body, schema mismatch, missing field, parse error) — generalizing the runtime 422/400 repair to a pre-flight gate.
- **Where:** `generation-layer/validator/skill.py` **(new)**.
- **Files & functions:** `TestValidatorSkill` (`name="test-validator"`), `ValidatorArgs(tests_dir, api_spec_json, mock_data_json)`, `ValidatorResult(ok, validated, repaired, failed, report_path)`. Functions: `validate_script(script, spec, mock)` (syntax + body-vs-schema), `recreate_on_invalid(script, error)` (re-synthesize via `mock-data` skill + `lib/repair.repair_request_body`), loop ≤ N.
- **Interlinks:** ← `output/generation/{api-tests,openapi-tests}/*`, `output/indexed_output/api-spec.json`, `output/mock-data/synth.json`. → repaired scripts + `output/generation/validation-report.json`.
- **Reuse:** `api-test-generator/lib/{repair.py, request_synth.py, exemptions.py}`.
- **Replaces:** scattered validation; provides the A7 gate as a skill that shares repair logic with api-test-gen.

### Registry change (one place)
Add three rows to `REGISTERED_SKILLS` (`skill_registry.py`) — `output-indexer`, `mock-data`, `test-validator` — alongside the existing `api-test-generator`. After that, all four are callable via `call_skill.py <name>` and (via §8) by the agent.

---

## 8. Agentic-harness enhancements

The harness (`infrastructure/agentic-harness/`) is built on **OpenHarness**. `ToolService` already runs three modes — **DIRECT** (no LLM), **AGENT** (LLM picks from a small tool set), **FREE_AGENT** (full toolbelt, ≤80 turns). The standard toolbelt (`tools/standard_toolbelt.py`) already ships `bash, file_read, file_write, file_edit, glob, grep, todo_write, agent`. Custom tools are added by a row in `REGISTERED_TOOLS` (`registry/tool_registry.py`) — today just **`graphify`** (`GraphifyTool`, `scripts/graphify/tool.py`).

So three of the four requested modules **already exist**. The genuinely new piece is the **skill bridge** that lets the agent invoke the §7 skills.

| Harness module | Status | Action |
|---|---|---|
| **1. Skill-calling** | ❌ **new** | Build `tools/skill_call_tool.py` — `SkillCallTool(IBaseTool)`, `name="call_skill"`; `execute()` does `SkillRegistry().load(skill)` → build args → `SkillService().invoke_direct(skill, args)` → return `ok`/output. Register in `standard_tools()` (free-agent gets it) **and** wire **AGENT mode** that's stubbed today (`bin/call_skill.py` "agent mode not yet wired"; `SkillService.invoke_via_agent`). This makes all four §7 skills agent-callable. |
| **2. Read-files** | ✅ exists | `FileReadTool` + `GlobTool`/`GrepTool` in the standard toolbelt. _Optional:_ add a `read_indexed` convenience tool that fetches `output/indexed_output/<topic>.json` by name. |
| **3. Tool-calling** | ✅ exists | `ToolRegistry` + `ToolService` (DIRECT/AGENT/FREE_AGENT) + `bin/call_tool.py`. Keep; add tools via `REGISTERED_TOOLS`. |
| **4. Graphify tool-calling** | ✅ exists | `graphify` registered (`GraphifyTool`/`GraphifyArgs`). Callable now via `call_tool.py graphify`. Keep. |
| **5. Any module we require** | ➕ slot | Register more as direct tools (`crawler` → `scripts/crawler`, a `scan`/`index` tool) in `REGISTERED_TOOLS`, or expose them as skills surfaced through module 1. |

**Net new work in the harness is module 1 only** — the skill bridge + AGENT-mode wiring. Modules 2–4 are already in place; module 5 is "register more as needed."

**Result of 1+§7:** the free-agent can do `read indexed apis → call mock-data skill → call api-test-generator skill → call test-validator skill (recreate on invalid body)` as an autonomous loop, with graphify available for code-graph questions — all through one uniform skill/tool seam.

---

## 9. Impact on the SOT modules & schedule

This skills-first framing reshapes (does not add much net work to) the existing plan:

| Affected | How it changes |
|---|---|
| Indexer (built) | Gains a thin **`output-indexer` skill** wrapper (small new file). |
| **E25** mock-data-creator | Realized as the **`mock-data` skill** (fills the empty dir) — clarifies the schedule's "Resolve the mock-data placeholder" (item 51). |
| **A2 / api-test-generator** | Already a skill; just re-points body synth at the mock-data skill. |
| **A7 validator** | Built **as the `test-validator` skill** — covers schedule items 13, 14, 45, 46 (syntax checks, validate-before-exec, quality/coverage, AI-judge). |
| **C18 agentic-harness / C19 skill-register** (built) | Get the **skill-calling bridge** + AGENT-mode wiring. |

**New scope to add to the schedule (currently unscheduled):** the **harness skill-calling bridge** (module 1 of §8) isn't one of the 95 backlog items — it's net-new from this decision. Recommend adding ~1 task ("Build the agent skill-calling bridge + wire agent mode", Core Loop, ~2–3 days) and tagging the four skills explicitly. Everything else maps to existing items (see `TRACEABILITY-schedule-vs-plan.md`).

---



