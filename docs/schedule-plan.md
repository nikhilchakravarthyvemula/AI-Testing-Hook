# Testing Harness — Delivery Schedule

**Kickoff:** 2026-05-15 (Fri)  |  **Week 1:** 2026-05-18 (Mon)  |  **Today:** 2026-06-15  |  **Deadline:** 2026-09-30

**Team:** Nikhil Vemula (Lead) · Ankit (Junior, onboarded 2026-06-01) · Nikhil Kalsi (Scrum Master)


> Work weeks are **Mon–Fri** — every task **starts Monday, ends Friday** (no weekend start/end). Several tasks share a week (~5 effort-days/dev). Completed work = weeks 1–5 (kickoff → today, Nikhil Vemula). Remaining runs to **Sep 30**; Ankit joins **Jun 1**. Lowest-priority/optional items are deferred past Sep 30 to hold the deadline.


> **Skills-first** (per `IMPLEMENTATION-PLAN-DEV.md` §7–§9): the indexer, mock-data, api-test generation and validation run as **registered skills**, and the agent **skill-calling bridge** is included so the harness can invoke them.


## Summary

| Owner | Done | Backlog | Deferred | Backlog start | Backlog end |
|---|---|---|---|---|---|
| Nikhil Vemula | 21 | 40 | 2 | 2026-06-22 | 2026-09-25 |
| Ankit | 0 | 58 | 2 | 2026-06-01 | 2026-09-25 |
| Nikhil Kalsi | 0 | 5 (ongoing) | 0 | 2026-05-18 | 2026-09-25 |

**Deadline check:** last in-scope week **W19**, finishing **2026-09-25** ✅ within Sep 30 (Mon–Fri only).


_4 items deferred past Sep 30 (optional + lowest-priority) — see the Deferred section._


## Near-term plan (W5–W7) — current focus

_Agreed sequencing for the next three weeks. This **supersedes the W5–W7 rows** in the full backlog table below; broader items originally pencilled into these weeks fold back into the programme after the rollout. **W8+ dates are unchanged.**_

**W5 · Jun 15–19 — Skills + agentic harness** _(starting this week)_

| Item | Owner |
|---|---|
| Build the mock-data skill (shared body synthesis) | Ankit |
| Wrap the indexer as a skill (output-indexer) | Ankit |
| Re-point api-test generator at the mock-data skill | Ankit |
| Build the test-validator skill (validate + recreate on invalid body) | Ankit |
| Build the agent skill-calling bridge + wire agent mode | Nikhil Vemula |

**W6 · Jun 22–26 — Integration**

| Item | Owner |
|---|---|
| Integrate the pipeline: scan → index → mock-data → generate → validate → run (skills wired end-to-end) | Nikhil Vemula |
| Wire run + report through the test-executor | Ankit |
| End-to-end dry run on a reference app + close integration gaps | Nikhil Vemula · Ankit |

**W7 · Jun 29–Jul 3 — API-testing rollout to HSBC**

| Item | Owner |
|---|---|
| API test-gen + validate skills running end-to-end against the HSBC target | Nikhil Vemula |
| Run + report via the test-executor | Ankit |
| HSBC restricted-env basics — container + offline/egress + local model (API slice) | Nikhil Vemula |
| Skill-calling via the harness (agent drives the API-testing skills) | Ankit |

> After W7, the programme continues with the full backlog below (analytics, learning & resilience, full multi-app deployment, stabilization) through **Sep 30**.


## Completed — already delivered (Nikhil Vemula)

| # | Item | Workstream | Week | Start | Due |
|---|---|---|---|---|---|
| C1 | testo CLI (scan / generate / ask) | Platform / CLI | W1 | 2026-05-18 | 2026-05-22 |
| C2 | Crawler engine (BFS + capture) | Discovery & Context | W1 | 2026-05-18 | 2026-05-22 |
| C3 | Graphify code-graph extractor | Discovery & Context | W1 | 2026-05-18 | 2026-05-22 |
| C4 | Graphify run engine | Discovery & Context | W1 | 2026-05-18 | 2026-05-22 |
| C5 | DB-schema extractor (AST + LLM) | Discovery & Context | W1 | 2026-05-18 | 2026-05-22 |
| C6 | Framework detection + 20+ code-extractors | Discovery & Context | W2 | 2026-05-25 | 2026-05-29 |
| C7 | Mock-data + OpenAPI extractors | Discovery & Context | W2 | 2026-05-25 | 2026-05-29 |
| C8 | Text-kg + Jira + Confluence extractors | Discovery & Context | W2 | 2026-05-25 | 2026-05-29 |
| C9 | Indexer — 13 topics | Discovery & Context | W2 | 2026-05-25 | 2026-05-29 |
| C10 | API-spec verifier (authenticity gate) | Discovery & Context | W2 | 2026-05-25 | 2026-05-29 |
| C11 | Intelligent login classifier | Discovery & Context | W3 | 2026-06-01 | 2026-06-05 |
| C12 | Intent-extraction performance tuning | Discovery & Context | W3 | 2026-06-01 | 2026-06-05 |
| C13 | Route-tree wired into the crawler | Discovery & Context | W3 | 2026-06-01 | 2026-06-05 |
| C14 | Graph viewer (interactive HTML) | Discovery & Context | W3 | 2026-06-01 | 2026-06-05 |
| C15 | API-test generator (verified spec) | Generation | W3 | 2026-06-01 | 2026-06-05 |
| C16 | API-test self-repair loop | Generation | W4 | 2026-06-08 | 2026-06-12 |
| C17 | OpenAPI write/mutation test-gen | Generation | W4 | 2026-06-08 | 2026-06-12 |
| C18 | Agentic harness (LLM tool-calling) | Infrastructure | W4 | 2026-06-08 | 2026-06-12 |
| C19 | Skill register | Infrastructure | W4 | 2026-06-08 | 2026-06-12 |
| C20 | Model connector (MiniMax) | Infrastructure | W4 | 2026-06-08 | 2026-06-12 |
| C21 | Provenance / confidence schema | Knowledge Base | W5 | 2026-06-15 | 2026-06-19 |

## In-scope backlog — Mon–Fri weeks (Week 1 → Sep 30)

| # | Item | Workstream | Owner | Week | Start | Due |
|---|---|---|---|---|---|---|
| 1 | Build the mock-data skill (shared body synthesis) | Core Loop | Ankit | W3 | 2026-06-01 | 2026-06-05 |
| 2 | Wrap the indexer as a skill (output-indexer) | Core Loop | Ankit | W3 | 2026-06-01 | 2026-06-05 |
| 3 | Re-point api-test generator at the mock-data skill | Core Loop | Ankit | W3 | 2026-06-01 | 2026-06-05 |
| 4 | Wire the output-indexer + knowledge build into the scan | Core Loop | Ankit | W3 | 2026-06-01 | 2026-06-05 |
| 5 | Smoke-test the knowledge file | Core Loop | Ankit | W3 | 2026-06-01 | 2026-06-05 |
| 6 | Add provider selection | Core Loop | Ankit | W4 | 2026-06-08 | 2026-06-12 |
| 7 | Smoke-test each model provider | Core Loop | Ankit | W4 | 2026-06-08 | 2026-06-12 |
| 8 | Add the run command to the CLI | Core Loop | Ankit | W4 | 2026-06-08 | 2026-06-12 |
| 9 | Build the results dashboard | Core Loop | Ankit | W4 | 2026-06-08 | 2026-06-12 |
| 10 | Add the report command to the CLI | Core Loop | Ankit | W5 | 2026-06-15 | 2026-06-19 |
| 11 | Write run results back into the knowledge file | Core Loop | Ankit | W5 | 2026-06-15 | 2026-06-19 |
| 12 | Trigger feedback automatically after a run | Core Loop | Ankit | W5 | 2026-06-15 | 2026-06-19 |
| 13 | Add the UI-test generation command | Core Loop | Ankit | W5 | 2026-06-15 | 2026-06-19 |
| 14 | Register the UI generator as a skill | Core Loop | Ankit | W5 | 2026-06-15 | 2026-06-19 |
| 15 | Add the plan command to the CLI | Core Loop | Ankit | W6 | 2026-06-22 | 2026-06-26 |
| 16 | Build the test-validator skill (syntax + schema checks) | Core Loop | Ankit | W6 | 2026-06-22 | 2026-06-26 |
| 17 | Validate generated tests via the test-validator skill | Core Loop | Ankit | W6 | 2026-06-22 | 2026-06-26 |
| 18 | Fold merged records into the knowledge file | Context Analytics | Ankit | W6 | 2026-06-22 | 2026-06-26 |
| 19 | Add written-doc knowledge to the knowledge file | Context Analytics | Ankit | W6 | 2026-06-22 | 2026-06-26 |
| 20 | Build the agent skill-calling bridge + wire agent mode | Core Loop | Nikhil Vemula | W6 | 2026-06-22 | 2026-06-26 |
| 21 | Define the knowledge-file structure | Core Loop | Nikhil Vemula | W6 | 2026-06-22 | 2026-06-26 |
| 22 | Merge indexed outputs into the knowledge file | Core Loop | Nikhil Vemula | W6 | 2026-06-22 | 2026-06-26 |
| 23 | Run analytics as part of a scan | Context Analytics | Ankit | W7 | 2026-06-29 | 2026-07-03 |
| 24 | Run feature grouping in the scan | Context Analytics | Ankit | W7 | 2026-06-29 | 2026-07-03 |
| 25 | Run gap analysis in the scan | Context Analytics | Ankit | W7 | 2026-06-29 | 2026-07-03 |
| 26 | Export an explorable app map | Context Analytics | Ankit | W7 | 2026-06-29 | 2026-07-03 |
| 27 | Export a scenario tree diagram | Context Analytics | Ankit | W7 | 2026-06-29 | 2026-07-03 |
| 28 | Add knowledge-file read/write helpers | Core Loop | Nikhil Vemula | W7 | 2026-06-29 | 2026-07-03 |
| 29 | Add OpenAI model provider | Core Loop | Nikhil Vemula | W7 | 2026-06-29 | 2026-07-03 |
| 30 | Add local (Ollama) model provider | Core Loop | Nikhil Vemula | W7 | 2026-06-29 | 2026-07-03 |
| 31 | Add Anthropic model provider | Core Loop | Nikhil Vemula | W7 | 2026-06-29 | 2026-07-03 |
| 32 | Run the generated UI tests + emit JSON | Core Loop | Nikhil Vemula | W7 | 2026-06-29 | 2026-07-03 |
| 33 | Run map building in the scan | Context Analytics | Ankit | W8 | 2026-07-06 | 2026-07-10 |
| 34 | Inject relevant notes into runs | Learning & Resilience | Ankit | W8 | 2026-07-06 | 2026-07-10 |
| 35 | Consolidate + prune notes | Learning & Resilience | Ankit | W8 | 2026-07-06 | 2026-07-10 |
| 36 | Record heal events into memory | Learning & Resilience | Ankit | W8 | 2026-07-06 | 2026-07-10 |
| 37 | Add compose + run scripts | Deployment & Scale | Ankit | W8 | 2026-07-06 | 2026-07-10 |
| 38 | Run the generated API tests in the runner | Core Loop | Nikhil Vemula | W8 | 2026-07-06 | 2026-07-10 |
| 39 | Define one unified results format | Core Loop | Nikhil Vemula | W8 | 2026-07-06 | 2026-07-10 |
| 40 | Add retry-once and flaky detection | Core Loop | Nikhil Vemula | W8 | 2026-07-06 | 2026-07-10 |
| 41 | Add a CI pipeline | Deployment & Scale | Ankit | W9 | 2026-07-13 | 2026-07-17 |
| 42 | Build self-service intake (URL + creds) | Deployment & Scale | Ankit | W9 | 2026-07-13 | 2026-07-17 |
| 43 | Bundle the graph viewer UI library locally | Deployment & Scale | Ankit | W9 | 2026-07-13 | 2026-07-17 |
| 44 | Build the test-plan creator | Core Loop | Nikhil Vemula | W9 | 2026-07-13 | 2026-07-17 |
| 45 | Derive UI scenarios from user flows | Core Loop | Nikhil Vemula | W9 | 2026-07-13 | 2026-07-17 |
| 46 | Add quality + coverage checks to the validator skill | Core Loop | Nikhil Vemula | W9 | 2026-07-13 | 2026-07-17 |
| 47 | Add the AI quality-judge gate to the validator skill | Core Loop | Nikhil Vemula | W9 | 2026-07-13 | 2026-07-17 |
| 48 | Make browser install work offline | Deployment & Scale | Ankit | W10 | 2026-07-20 | 2026-07-24 |
| 49 | Point installs at internal mirrors | Deployment & Scale | Ankit | W10 | 2026-07-20 | 2026-07-24 |
| 50 | Default to a local model in restricted mode | Deployment & Scale | Ankit | W10 | 2026-07-20 | 2026-07-24 |
| 51 | Handle corporate certificate trust | Deployment & Scale | Ankit | W10 | 2026-07-20 | 2026-07-24 |
| 52 | Fold the knowledge-sources folder into docs | Cleanup & Tests | Ankit | W10 | 2026-07-20 | 2026-07-24 |
| 53 | De-duplicate findings across sources | Context Analytics | Nikhil Vemula | W10 | 2026-07-20 | 2026-07-24 |
| 54 | Set up the analytics dependencies | Context Analytics | Nikhil Vemula | W10 | 2026-07-20 | 2026-07-24 |
| 55 | Load the app graph into the analytics engine | Context Analytics | Nikhil Vemula | W10 | 2026-07-20 | 2026-07-24 |
| 56 | Score importance + detect communities | Context Analytics | Nikhil Vemula | W10 | 2026-07-20 | 2026-07-24 |
| 57 | Remove the duplicate UI generator | Cleanup & Tests | Ankit | W11 | 2026-07-27 | 2026-07-31 |
| 58 | Add tests for the extractors | Cleanup & Tests | Ankit | W11 | 2026-07-27 | 2026-07-31 |
| 59 | Add tests for indexer + knowledge file | Cleanup & Tests | Ankit | W11 | 2026-07-27 | 2026-07-31 |
| 60 | Add tests for the test runner | Cleanup & Tests | Ankit | W11 | 2026-07-27 | 2026-07-31 |
| 61 | Group the app into named features | Context Analytics | Nikhil Vemula | W11 | 2026-07-27 | 2026-07-31 |
| 62 | Find coverage gaps + untested areas | Context Analytics | Nikhil Vemula | W11 | 2026-07-27 | 2026-07-31 |
| 63 | Improve the safe-click crawling pass | Cleanup & Tests | Ankit | W12 | 2026-08-03 | 2026-08-07 |
| 64 | Update the architecture overview | Deployment & Scale | Ankit | W12 | 2026-08-03 | 2026-08-07 |
| 65 | Document the knowledge base + schema | Deployment & Scale | Ankit | W12 | 2026-08-03 | 2026-08-07 |
| 66 | Write the CLI command reference | Deployment & Scale | Ankit | W12 | 2026-08-03 | 2026-08-07 |
| 67 | Document execution + reporting | Deployment & Scale | Ankit | W12 | 2026-08-03 | 2026-08-07 |
| 68 | Define the per-app memory format | Learning & Resilience | Nikhil Vemula | W12 | 2026-08-03 | 2026-08-07 |
| 69 | Build the memory distiller core | Learning & Resilience | Nikhil Vemula | W12 | 2026-08-03 | 2026-08-07 |
| 70 | Add distiller routing + storage | Learning & Resilience | Nikhil Vemula | W12 | 2026-08-03 | 2026-08-07 |
| 71 | Document the analytics module | Deployment & Scale | Ankit | W13 | 2026-08-10 | 2026-08-14 |
| 72 | Document the memory module | Deployment & Scale | Ankit | W13 | 2026-08-10 | 2026-08-14 |
| 73 | Document self-healing execution | Deployment & Scale | Ankit | W13 | 2026-08-10 | 2026-08-14 |
| 74 | Write the onboarding guide (add an app) | Deployment & Scale | Ankit | W13 | 2026-08-10 | 2026-08-14 |
| 75 | Add recall tools to fetch notes | Learning & Resilience | Nikhil Vemula | W13 | 2026-08-10 | 2026-08-14 |
| 76 | Build self-healing locator fallbacks | Learning & Resilience | Nikhil Vemula | W13 | 2026-08-10 | 2026-08-14 |
| 77 | Add AI-assisted locator resolve | Learning & Resilience | Nikhil Vemula | W13 | 2026-08-10 | 2026-08-14 |
| 78 | Document the test strategy + 3 gates | Deployment & Scale | Ankit | W14 | 2026-08-17 | 2026-08-21 |
| 79 | Build the KT / handover pack | Deployment & Scale | Ankit | W14 | 2026-08-17 | 2026-08-21 |
| 80 | Bug-fix & stabilization buffer 2 | Stabilization & Release | Ankit | W14 | 2026-08-17 | 2026-08-21 |
| 81 | Capture the page state for healing | Learning & Resilience | Nikhil Vemula | W14 | 2026-08-17 | 2026-08-21 |
| 82 | Add heal cache + retry logic | Learning & Resilience | Nikhil Vemula | W14 | 2026-08-17 | 2026-08-21 |
| 83 | UAT support & feedback fixes | Stabilization & Release | Ankit | W15 | 2026-08-24 | 2026-08-28 |
| 84 | Add sandboxed setup/teardown hooks | Learning & Resilience | Nikhil Vemula | W15 | 2026-08-24 | 2026-08-28 |
| 85 | Build the container image | Deployment & Scale | Nikhil Vemula | W15 | 2026-08-24 | 2026-08-28 |
| 86 | Make outputs per-app (no collisions) | Deployment & Scale | Nikhil Vemula | W15 | 2026-08-24 | 2026-08-28 |
| 87 | Regression suite + smoke pack | Stabilization & Release | Ankit | W16 | 2026-08-31 | 2026-09-04 |
| 88 | Add a job queue + workers | Deployment & Scale | Nikhil Vemula | W16 | 2026-08-31 | 2026-09-04 |
| 89 | Add proxy support to crawler + browser | Deployment & Scale | Nikhil Vemula | W16 | 2026-08-31 | 2026-09-04 |
| 90 | Add AI button classification for crawling | Cleanup & Tests | Nikhil Vemula | W16 | 2026-08-31 | 2026-09-04 |
| 91 | Documentation & KT polish | Stabilization & Release | Ankit | W17 | 2026-09-07 | 2026-09-11 |
| 92 | Write the restricted/offline deploy guide | Deployment & Scale | Nikhil Vemula | W17 | 2026-09-07 | 2026-09-11 |
| 93 | Write the egress / NetSec proposal | Deployment & Scale | Nikhil Vemula | W17 | 2026-09-07 | 2026-09-11 |
| 94 | Integration test pass (end-to-end) | Stabilization & Release | Nikhil Vemula | W17 | 2026-09-07 | 2026-09-11 |
| 95 | Performance & load hardening | Stabilization & Release | Ankit | W18 | 2026-09-14 | 2026-09-18 |
| 96 | Bug-fix & stabilization buffer 1 | Stabilization & Release | Nikhil Vemula | W18 | 2026-09-14 | 2026-09-18 |
| 97 | Security review & remediation | Stabilization & Release | Ankit | W19 | 2026-09-21 | 2026-09-25 |
| 98 | Production cutover + handover sign-off | Stabilization & Release | Nikhil Vemula | W19 | 2026-09-21 | 2026-09-25 |

## Deferred — after Sep 30

| Item | Workstream | Owner | Week | Start | Due |
|---|---|---|---|---|---|
| Scaffold the web dashboard | Deployment & Scale | Ankit | W20 | 2026-09-28 | 2026-10-02 |
| Build the web results view | Deployment & Scale | Ankit | W20 | 2026-09-28 | 2026-10-02 |
| Design a database-backed knowledge store | Deployment & Scale | Nikhil Vemula | W20 | 2026-09-28 | 2026-10-02 |
| Implement the database store | Deployment & Scale | Nikhil Vemula | W20 | 2026-09-28 | 2026-10-02 |

## Scrum Master — ongoing (Nikhil Kalsi)

| Item | Start | End |
|---|---|---|
| Set up Jira board, sprints + workflow | 2026-05-18 | 2026-09-25 |
| Backlog grooming + estimation | 2026-05-18 | 2026-09-25 |
| Sprint demos + stakeholder reporting | 2026-05-18 | 2026-09-25 |
| Track risks + external dependencies | 2026-05-18 | 2026-09-25 |
| Release + UAT coordination | 2026-05-18 | 2026-09-25 |
