# Traceability — Schedule ↔ Implementation Plan (SOT)

_`IMPLEMENTATION-PLAN-DEV.md` is the **source of truth** (SOT): it defines the engineering modules (A1–E27) and the foundation already built. This doc maps the dated `schedule-plan.md` onto that SOT — both directions — so you can see that every module is scheduled and where every scheduled task belongs._

Inputs: 21 completed (C1–C21), 95 in-scope backlog (1–95), 4 deferred, 5 Scrum-Master (ongoing).

---

## 1. Alignment summary

| Check | Result |
|---|---|
| SOT engineering modules with ≥1 scheduled task | **27 / 27 (100%)** — A1–E27 all covered (D21/D22 via the deferred section) |
| Completed work mapped to the SOT foundation (§4) | **21 / 21 (100%)** |
| In-scope tasks tracing to a discrete SOT module | **75 / 95 (79%)** |
| In-scope tasks that are cross-cutting (no single module) | **20 / 95 (21%)** — 10 Documentation, 10 Stabilization & Release |
| Deferred items consistent (schedule ↔ SOT) | **4 / 4** — map to D21 (Postgres KB) + D22 (web-ui), both deferred in the SOT too |

**Verdict:** strong alignment. Every module in the plan has owners + weeks in the schedule, the completed work matches the foundation, and the deadline (Sep 25 < Sep 30) holds. The only divergence: the SOT has **no Documentation and no Stabilization/Release module**, yet the schedule (correctly) budgets ~20 tasks for them. Fix = add those two as explicit workstreams in the SOT (see §4).

### Workstream ↔ Bundle correspondence

| Schedule workstream | SOT bundle(s) / phase |
|---|---|
| Core Loop | Bundles 1, 2, 3, 5 (KB, execution, feedback, generation) |
| Context Analytics | Bundle 4 (= Module 1) |
| Learning & Resilience | Bundle 6 (= Modules 2 & 3) |
| Deployment & Scale | Bundle 7 (+ Documentation tasks mis-tagged here) |
| Cleanup & Tests | Bundle 8 (E23–E27) |
| Stabilization & Release | _no SOT bundle_ (cross-cutting) |

---

## 2. Forward map — SOT module → scheduled tasks

Each SOT module and the schedule items that deliver it (with owner + week span).

| SOT module | Bundle / Phase | Schedule items | Owner(s) | Weeks |
|---|---|---|---|---|
| Foundation (built, §4) | Phase 0 | C1–C21 | Vemula | W1–W5 |
| **A1** KB build/store | B1 / P1 | 1, 2, 20, 21, 22 | Ankit, Vemula | W3, W6 |
| **A2** test-executor | B2 / P2 | 5, 31, 32, 37, 38 | Ankit, Vemula | W3, W7, W8 |
| **A3** report-generator | B2 / P2 | 6, 7 | Ankit | W4 |
| **A4** feedback loop | B3 / P2 | 8, 9 | Ankit | W4 |
| **A5** wire UI/E2E gen | B2 / P2 | 10, 11, 44 | Ankit, Vemula | W5, W9 |
| **A6** test-plan-creator | B5 / P4 | 12, 39 | Ankit, Vemula | W5, W8 |
| **A7** validator | B5 / P4 | 13, 14, 45, 46 | Ankit, Vemula | W5, W9 |
| **A8** model providers | B5 / P1 | 3, 4, 23, 29, 30 | Ankit, Vemula | W3, W6, W7 |
| **B9** graph-analytics | B4 / P3 | 17, 53, 54, 55 | Ankit, Vemula | W6, W10 |
| **B10** feature-extractor | B4 / P3 | 18, 56 | Ankit, Vemula | W6, W10 |
| **B11** gap-analyzer | B4 / P3 | 19, 61 | Ankit, Vemula | W6, W11 |
| **B12** knowledge-synthesizer | B4 / P3 | 15, 47 | Ankit, Vemula | W6, W9 |
| **B13** mind-map-builder | B4 / P3 | 24, 25, 26 | Ankit | W7 |
| **B14** text-kg → KB | B4 / P3 | 16 | Ankit | W6 |
| **C15** skill-memory (Module 2) | B6 / P5 | 27, 28, 62, 63, 69, 70 | Ankit, Vemula | W7, W11, W12 |
| **C16** self-healing (Module 3) | B6 / P5 | 33, 75, 76, 77, 79, 80 | Ankit, Vemula | W8, W13, W14 |
| **D17** container-deploy | B7 / P6 | 34, 35, 81 | Ankit, Vemula | W8, W15 |
| **D18** multi-app isolation | B7 / P6 | 36, 82, 83 | Ankit, Vemula | W8, W15 |
| **D19** offline / restricted | B7 / P6 | 40, 41, 42, 43, 48 | Ankit | W9, W10 |
| **D20** egress automation | B7 / P6 | 85, 89 | Vemula | W16, W17 |
| **D21** Postgres KB _(optional)_ | B7 / deferred | _Deferred:_ design + implement DB store | Vemula | W20 |
| **D22** web-ui _(deferred)_ | B7 / deferred | _Deferred:_ scaffold dashboard + results view | Ankit | W20 |
| **E23** reconcile knowledge-sources | B8 | 49 | Ankit | W10 |
| **E24** de-dup generators | B8 | 50 | Ankit | W10 |
| **E25** mock-data-creator | B5 / B8 | 51 | Ankit | W10 |
| **E26** tests | B8 | 52, 57, 58 | Ankit | W10, W11 |
| **E27** button-classify / safe-click | B8 | 59, 86 | Ankit, Vemula | W11, W16 |
| _Documentation_ **(not a SOT module)** | — | 60, 64, 65, 66, 67, 68, 71, 72, 73, 87 | Ankit, Vemula | W11–W17 |
| _Stabilization & Release_ **(not a SOT module)** | — | 74, 78, 84, 88, 90, 91, 92, 93, 94, 95 | Ankit, Vemula | W13–W19 |

Every A1–E27 module has at least one scheduled owner-assigned task. ✅

---

## 3. Reverse map — every scheduled task → SOT module

| # | Scheduled item | Workstream | → SOT | Bundle/Phase |
|---|---|---|---|---|
| 1 | Wire knowledge-file build into the scan | Core Loop | A1 | B1/P1 |
| 2 | Smoke-test the knowledge file | Core Loop | A1 | B1/P1 |
| 3 | Add provider selection | Core Loop | A8 | B5/P1 |
| 4 | Smoke-test each model provider | Core Loop | A8 | B5/P1 |
| 5 | Add the run command to the CLI | Core Loop | A2 | B2/P2 |
| 6 | Build the results dashboard | Core Loop | A3 | B2/P2 |
| 7 | Add the report command to the CLI | Core Loop | A3 | B2/P2 |
| 8 | Write run results back into the knowledge file | Core Loop | A4 | B3/P2 |
| 9 | Trigger feedback automatically after a run | Core Loop | A4 | B3/P2 |
| 10 | Add the UI-test generation command | Core Loop | A5 | B2/P2 |
| 11 | Register the UI generator as a skill | Core Loop | A5 | B2/P2 |
| 12 | Add the plan command to the CLI | Core Loop | A6 | B5/P4 |
| 13 | Add syntax checks for generated tests | Core Loop | A7 | B5/P4 |
| 14 | Run the validator before execution | Core Loop | A7 | B5/P4 |
| 15 | Fold merged records into the knowledge file | Context Analytics | B12 | B4/P3 |
| 16 | Add written-doc knowledge to the knowledge file | Context Analytics | B14 | B4/P3 |
| 17 | Run analytics as part of a scan | Context Analytics | B9 | B4/P3 |
| 18 | Run feature grouping in the scan | Context Analytics | B10 | B4/P3 |
| 19 | Run gap analysis in the scan | Context Analytics | B11 | B4/P3 |
| 20 | Define the knowledge-file structure | Core Loop | A1 | B1/P1 |
| 21 | Merge indexed outputs into the knowledge file | Core Loop | A1 | B1/P1 |
| 22 | Add knowledge-file read/write helpers | Core Loop | A1 | B1/P1 |
| 23 | Add OpenAI model provider | Core Loop | A8 | B5/P1 |
| 24 | Export an explorable app map | Context Analytics | B13 | B4/P3 |
| 25 | Export a scenario tree diagram | Context Analytics | B13 | B4/P3 |
| 26 | Run map building in the scan | Context Analytics | B13 | B4/P3 |
| 27 | Inject relevant notes into runs | Learning & Resilience | C15 | B6/P5 |
| 28 | Consolidate + prune notes | Learning & Resilience | C15 | B6/P5 |
| 29 | Add local (Ollama) model provider | Core Loop | A8 | B5/P1 |
| 30 | Add Anthropic model provider | Core Loop | A8 | B5/P1 |
| 31 | Run the generated UI tests + emit JSON | Core Loop | A2 | B2/P2 |
| 32 | Run the generated API tests in the runner | Core Loop | A2 | B2/P2 |
| 33 | Record heal events into memory | Learning & Resilience | C16 (+C15) | B6/P5 |
| 34 | Add compose + run scripts | Deployment & Scale | D17 | B7/P6 |
| 35 | Add a CI pipeline | Deployment & Scale | D17 | B7/P6 |
| 36 | Build self-service intake (URL + creds) | Deployment & Scale | D18 | B7/P6 |
| 37 | Define one unified results format | Core Loop | A2 | B2/P2 |
| 38 | Add retry-once and flaky detection | Core Loop | A2 | B2/P2 |
| 39 | Build the test-plan creator | Core Loop | A6 | B5/P4 |
| 40 | Bundle the graph viewer UI library locally | Deployment & Scale | D19 | B7/P6 |
| 41 | Make browser install work offline | Deployment & Scale | D19 | B7/P6 |
| 42 | Point installs at internal mirrors | Deployment & Scale | D19 | B7/P6 |
| 43 | Default to a local model in restricted mode | Deployment & Scale | D19 (+A8) | B7/P6 |
| 44 | Derive UI scenarios from user flows | Core Loop | A5 | B2/P2 |
| 45 | Add quality + coverage checks | Core Loop | A7 | B5/P4 |
| 46 | Add optional AI quality-judge gate | Core Loop | A7 | B5/P4 |
| 47 | De-duplicate findings across sources | Context Analytics | B12 | B4/P3 |
| 48 | Handle corporate certificate trust | Deployment & Scale | D19 | B7/P6 |
| 49 | Fold the knowledge-sources folder into docs | Cleanup & Tests | E23 | B8 |
| 50 | Remove the duplicate UI generator | Cleanup & Tests | E24 | B8 |
| 51 | Resolve the mock-data placeholder | Cleanup & Tests | E25 | B5/B8 |
| 52 | Add tests for the extractors | Cleanup & Tests | E26 | B8 |
| 53 | Set up the analytics dependencies | Context Analytics | B9 | B4/P3 |
| 54 | Load the app graph into the analytics engine | Context Analytics | B9 | B4/P3 |
| 55 | Score importance + detect communities | Context Analytics | B9 | B4/P3 |
| 56 | Group the app into named features | Context Analytics | B10 | B4/P3 |
| 57 | Add tests for indexer + knowledge file | Cleanup & Tests | E26 | B8 |
| 58 | Add tests for the test runner | Cleanup & Tests | E26 | B8 |
| 59 | Improve the safe-click crawling pass | Cleanup & Tests | E27 | B8 |
| 60 | Update the architecture overview | Deployment & Scale | _Documentation_ | — |
| 61 | Find coverage gaps + untested areas | Context Analytics | B11 | B4/P3 |
| 62 | Define the per-app memory format | Learning & Resilience | C15 | B6/P5 |
| 63 | Build the memory distiller core | Learning & Resilience | C15 | B6/P5 |
| 64 | Document the knowledge base + schema | Deployment & Scale | _Documentation_ | — |
| 65 | Write the CLI command reference | Deployment & Scale | _Documentation_ | — |
| 66 | Document execution + reporting | Deployment & Scale | _Documentation_ | — |
| 67 | Document the analytics module | Deployment & Scale | _Documentation_ | — |
| 68 | Document the memory module | Deployment & Scale | _Documentation_ | — |
| 69 | Add distiller routing + storage | Learning & Resilience | C15 | B6/P5 |
| 70 | Add recall tools to fetch notes | Learning & Resilience | C15 | B6/P5 |
| 71 | Document self-healing execution | Deployment & Scale | _Documentation_ | — |
| 72 | Write the onboarding guide (add an app) | Deployment & Scale | _Documentation_ | — |
| 73 | Document the test strategy + 3 gates | Deployment & Scale | _Documentation_ | — |
| 74 | Bug-fix & stabilization buffer 2 | Stabilization & Release | _Stabilization_ | — |
| 75 | Build self-healing locator fallbacks | Learning & Resilience | C16 | B6/P5 |
| 76 | Add AI-assisted locator resolve | Learning & Resilience | C16 | B6/P5 |
| 77 | Capture the page state for healing | Learning & Resilience | C16 | B6/P5 |
| 78 | UAT support & feedback fixes | Stabilization & Release | _Stabilization_ | — |
| 79 | Add heal cache + retry logic | Learning & Resilience | C16 | B6/P5 |
| 80 | Add sandboxed setup/teardown hooks | Learning & Resilience | C16 | B6/P5 |
| 81 | Build the container image | Deployment & Scale | D17 | B7/P6 |
| 82 | Make outputs per-app (no collisions) | Deployment & Scale | D18 | B7/P6 |
| 83 | Add a job queue + workers | Deployment & Scale | D18 | B7/P6 |
| 84 | Regression suite + smoke pack | Stabilization & Release | _Stabilization_ (≈E26) | — |
| 85 | Add proxy support to crawler + browser | Deployment & Scale | D20 | B7/P6 |
| 86 | Add AI button classification for crawling | Cleanup & Tests | E27 | B8 |
| 87 | Write the restricted/offline deploy guide | Deployment & Scale | _Documentation_ (D19) | — |
| 88 | Documentation & KT polish | Stabilization & Release | _Stabilization / Docs_ | — |
| 89 | Write the egress / NetSec proposal | Deployment & Scale | D20 | B7/P6 |
| 90 | Build the KT / handover pack | Deployment & Scale | _Stabilization_ | — |
| 91 | Integration test pass (end-to-end) | Stabilization & Release | _Stabilization_ | — |
| 92 | Performance & load hardening | Stabilization & Release | _Stabilization_ | — |
| 93 | Security review & remediation | Stabilization & Release | _Stabilization_ | — |
| 94 | Bug-fix & stabilization buffer 1 | Stabilization & Release | _Stabilization_ | — |
| 95 | Production cutover + handover sign-off | Stabilization & Release | _Stabilization_ | — |

---

## 4. Completed work → SOT foundation (§4)

All 21 completed items map to the "Already built" foundation. None is rework; later modules extend them (noted).

| Completed | → SOT foundation | Extended later by |
|---|---|---|
| C1 testo CLI | CLI (`interfaces/cli`) | run/plan/report commands (A2/A3/A6) |
| C2 Crawler engine | content-extractor / crawler | E27 safe-click, D20 proxy |
| C3–C4 Graphify (graph + run) | content-extractor / graphify | — |
| C5 DB-schema extractor | content-extractor / db-schema | — |
| C6 Framework detection + 20+ code-extractors | content-extractor / framework-extractor | — |
| C7 Mock-data + OpenAPI extractors | content-extractor | E25 (mock-data-creator cleanup) |
| C8 Text-kg + Jira + Confluence | content-extractor / text-kg | **B14** (wire triples into KB) |
| C9 Indexer — 13 topics | indexer | new topics (analytics, gaps, features) |
| C10 API-spec verifier | indexer / verify | — |
| C11–C13 Login classifier · intent perf · route-tree | crawler | — |
| C14 Graph viewer | graph-viewer | **D19** (vendor vis-network offline) |
| C15–C16 API-test generator + self-repair | api-test-generator | **A2** (run via executor) |
| C17 OpenAPI write/mutation test-gen | openapi-test-gen | A2 |
| C18 Agentic harness | agentic-harness | C15 (inject recalled skills) |
| C19 Skill register | skill-register | **C15** (skill-memory loop) |
| C20 Model connector (MiniMax) | model-api-connector | **A8** (OpenAI/Anthropic/Ollama) |
| C21 Provenance / confidence schema | knowledge-base/schema.mjs | **A1** (build/store reads it) |

## Deferred → SOT (both deferred there too)

| Deferred item | → SOT | Notes |
|---|---|---|
| Scaffold the web dashboard | **D22** web-ui | deferred in SOT (post Sep 30) |
| Build the web results view | **D22** web-ui | deferred in SOT |
| Design a database-backed knowledge store | **D21** Postgres KB | deferred in SOT (optional) |
| Implement the database store | **D21** Postgres KB | behind same `loadKnowledge/saveKnowledge` interface |

Consistent: the schedule defers exactly what the SOT marks optional/deferred. ✅

---

## 5. Gaps & recommendations

The schedule and SOT line up on all engineering modules. Two categories in the schedule have **no module in the SOT** — they're real, planned work that the plan currently treats as implicit:

1. **Documentation (10 tasks: 60, 64–68, 71–73, 87).** These document specific modules (KB, CLI, execution/reporting, analytics, memory, self-healing, onboarding, test-strategy, offline-deploy). The SOT has no Documentation workstream. _Recommend:_ add a **"Documentation & Enablement"** strand to `IMPLEMENTATION-PLAN-DEV.md` §5, one doc per delivered module. (Also: the schedule tags these under "Deployment & Scale" — a relabel to a "Documentation" workstream would read truer.)
2. **Stabilization & Release (10 tasks: 74, 78, 84, 88, 90–95).** Integration test, perf/load, security, UAT, regression, buffers, KT/handover, cutover. The SOT's §5 phases stop at "deploy & scale." _Recommend:_ add **"Phase 7 — Stabilization & Release"** to the plan so hardening + go-live are first-class.

Minor cross-links (already noted in the maps): item **33** spans C16+C15 (heal events → memory); item **43** spans D19+A8 (local model in restricted mode); item **51** realises E25 as "delete + redirect," matching the SOT's recommendation. The 5 Scrum-Master items are project management and correctly sit outside the engineering SOT.

**Bottom line:** 27/27 SOT modules scheduled, 21/21 completed items accounted for, deferred items consistent. Add the two cross-cutting strands above and the schedule ↔ SOT reconcile 1:1. _Want me to fold those two strands into `IMPLEMENTATION-PLAN-DEV.md`?_


