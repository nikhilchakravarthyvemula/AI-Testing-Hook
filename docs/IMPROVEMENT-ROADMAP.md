# Improvement Roadmap — borrowing from kg-gen, Acontext, and agent-qa

_Analysis of three reference projects against the current testing harness, with concrete, prioritized recommendations._

| Reference | What it is | Harness layer it maps to | Status of that layer today |
|---|---|---|---|
| [kg-gen + NetworkX article](https://www.marktechpost.com/2026/05/20/how-to-build-knowledge-graph-generation-pipelines-from-text-with-kg-gen-networkx-analytics-and-interactive-visualizations/) | LLM extracts (subject, predicate, object) triples from text → NetworkX analytics → interactive viz | **Context Layer** (`knowledge-synthesizer`, `feature-extractor`, `gap-analyzer`, `mind-map-builder`) | Empty dirs. You build graphs (`click-graph.json`, graphify AST) but run **zero graph analytics**. |
| [Acontext](https://github.com/memodb-io/Acontext) | "Agent Skills as a Memory Layer" — distills what an agent *did and how it turned out* into reusable Markdown skill files; tool-based recall | **`feedback/` + `skill-register/` + agentic-harness memory** | Feedback just appends `testRuns[]` to `knowledge.json`. Skills are hand-written static Python classes. No learning loop. |
| [agent-qa](https://github.com/vostride/agent-qa) | Agentic E2E test runtime: NL tests, self-healing execution, execution memory, action cache, sandboxed hooks | **Execution Layer + Generation Layer** | Generates static Playwright specs that fail on the first broken selector. No healing, no execution memory, no plan cache. |

The three are complementary, not overlapping. Together they close the loop your architecture diagram already draws but hasn't implemented: **graph tells you what to test → execution tells you what happened → memory distills why → feeds back to graph confidence.**

---

## TL;DR — what to do, in priority order

1. **Highest ROI / lowest effort: add NetworkX analytics over the graphs you already produce.** You don't need kg-gen for this part. Load `click-graph.json` into NetworkX, compute PageRank/betweenness/communities, and use them to **rank test generation by risk** and **auto-cluster features**. This fills three empty Context Layer dirs with ~a few hundred lines of deterministic Python.
2. **Medium effort, compounding ROI: a skill-memory loop (Acontext pattern, not necessarily the product).** When a generated test fails, flakes, or gets healed, distill a Markdown runbook and store it where the next run reads it. This is the difference between a pipeline and a system that gets better each run.
3. **Highest effort, evaluate build-vs-borrow: self-healing execution + action cache (agent-qa).** Your biggest robustness gap. Either adopt agent-qa directly (mind the license — see below) or port the three ideas into your `execution-layer`.
4. **Use kg-gen narrowly** for the *unstructured* sources you have no extractor for today (Jira ACs, Confluence, tribal markdown). Don't point it at code or crawl data — you already have better deterministic graphs there.

---

## 1. kg-gen + NetworkX → Context Layer

### What the article actually does

A four-stage pipeline: (1) `KGGen.generate()` uses an LLM to pull **entities, edges, and relations (s, p, o triples)** out of plain text; (2) chunking handles long passages and **clustering merges synonymous entities** ("Joe" ↔ "Joseph") and relation types; (3) it converts the graph to NetworkX and runs **degree centrality, betweenness, PageRank, predicate-frequency, and Louvain community detection**; (4) it renders an interactive PyVis HTML graph (nodes sized by PageRank, colored by community) and exports **JSON + GraphML** for Gephi/Cytoscape.

### What you already have (don't rebuild)

- `output/indexed_output/click-graph.json` — *"Intent-driven graph: pages → intents → APIs (LLM-annotated)."* That is already an (s, p, o) triple store in your domain.
- `context-layer/content-extractor/graphify/` — deterministic AST nodes + edges + semantic enrichment for code.
- `context-layer/graph-viewer/` with `render-html.mjs` + `shapers/` — you already render interactive HTML (`click-graph.html`, `ui-routes.html`). This is your PyVis equivalent; **keep it.**

### The actual gap

You build graphs and draw them, but you never **analyze** them, and four Context Layer dirs are empty: `knowledge-synthesizer/`, `feature-extractor/`, `gap-analyzer/`, `mind-map-builder/`. The article is a blueprint for filling exactly those.

### Concrete implementation

| Borrowed technique | Fills | What it gives you |
|---|---|---|
| PageRank + betweenness + degree centrality | `gap-analyzer/` (and feeds Generation) | **Risk-based test prioritization.** Highest-centrality pages/endpoints = most-depended-on = test first. Pipe the score into `test-plan-creator` as a priority field. |
| Louvain community detection | `feature-extractor/` | **Automatic feature clustering.** Replaces the planned "URL-prefix grouping" with structure-aware clusters that survive routing changes. |
| Entity/edge clustering (canonical → synonyms) | `knowledge-synthesizer/` | **Cross-source fact reconciliation.** The same endpoint named differently across OpenAPI vs. crawl vs. code gets merged — exactly the synthesizer's job per its README. |
| 2-hop neighborhood / reachability queries | `gap-analyzer/` | **Orphan + impact detection.** Unreachable pages, endpoints with no test, and "changed file → affected tests" impact analysis for diff-scoped runs. |
| GraphML export | `mind-map-builder/` | Human exploration in Gephi/Cytoscape, complementing your existing HTML viewer. |
| `kg-gen` triple extraction | New extractor under `content-extractor/` | Triples from **unstructured** sources only: Jira ACs, Confluence, tribal markdown. These have no graph today. |

A pragmatic split: **use NetworkX (pure, deterministic, free) for analytics over all existing graphs immediately**; introduce **kg-gen (LLM, costs tokens, nondeterministic) only for text sources**. Node.js note: you can run NetworkX as a small Python sidecar reading `click-graph.json` (you already ship a `.venv` under `context-layer/content-extractor/graphify/` and a Python AST extractor — there's precedent for Python in this repo), or use `graphology` + `graphology-metrics` to stay in-process in Node.

### Watch-outs

- kg-gen output is nondeterministic and costs tokens — keep it out of the hot path and cache by source hash.
- Don't let an LLM-extracted graph overwrite your deterministic AST/crawl facts; merge with the indexer's tier/confidence model (`TIER_CONFIDENCE` in `context-layer/indexer/lib/models.mjs`), keeping LLM triples at a lower tier.

---

## 2. Acontext → feedback loop + skill-register

### What it actually does

Acontext distills, from a session's messages and execution trace, **what the agent did and how it turned out** — successes, failures, user preferences — and writes them as **Markdown skill files** following a schema you define in `SKILL.md`. Recall is **tool-based** (`get_skill`, `get_skill_file`), not embedding similarity: the agent decides what it needs and fetches whole files. Plain Markdown, git-friendly, portable across models. (Apache-2.0 licensed; self-hostable via Docker, or borrow just the pattern.)

### Why this fits your harness unusually well

- Your `feedback/README.md` describes a thin loop: parse Playwright JSON, append to `knowledge.json#facts.testRuns[]`. That's data, not *learning*.
- You already have a **`tribal-knowledge/`** source that "reads a markdown notes folder" — Acontext would *write* into exactly that kind of folder, automatically.
- Your `TODO.md` and `agentic-harness/README.md` are full of hand-written lessons ("local small models collapse on 400-line prompts," "agent declared success on a stale graph — we added an honesty rule," "Sign Out must never be auto-clicked"). These are precisely the distilled-runbook artifacts Acontext produces automatically.

### Concrete implementation

Turn the feedback arrow into a learning loop:

1. **Trigger on outcome.** Extend `feedback/results-to-kb.mjs`: on every test fail, flake, or *heal* (once you add healing), emit a distillation request.
2. **Distill to Markdown.** One LLM pass (through your existing `agentic-harness`) turns the run trace into a structured note: *symptom → root cause → fix/workaround → applies-to (app, page, endpoint)*. Example auto-generated skill: `skills/learned/superalign-login.md` — "login form needs `waitForUrlStable`; `router.push` redirect isn't caught by a plain wait."
3. **Store as files, git-tracked.** Write under a new `skills/learned/` folder. Markdown = diffable, reviewable, portable — matches agent-qa's "review QA like code" philosophy too.
4. **Recall by tool, not embedding.** Add a `get_skill` / `get_skill_file` tool to `agentic-harness/registry.py` so generation and execution agents can pull relevant runbooks into context before acting. This is the I_AGENT "memory" box on your diagram, currently unimplemented.

### Build vs. borrow

Borrow the **pattern**, be cautious about the **dependency**. Acontext's backend is a full stack (PostgreSQL/S3/Redis/RabbitMQ). For a single-team harness that's heavy. Start by reimplementing the distill→markdown→tool-recall loop in ~150 lines against your existing `agentic-harness`; adopt the real product only if you need multi-agent skill sharing at scale. Either way, **keep skills as plain Markdown in git** — that's the durable, lock-in-free part of the idea.

---

## 3. agent-qa → Execution Layer (+ Generation)

### What it actually does

An agentic E2E runtime with features you can map one-to-one onto your gaps:

- **Self-healing execution** — when a click/fill/select fails, it re-observes the UI and tries a different path **in the same run**, instead of failing on the first broken selector.
- **Execution memory** — builds memory from product/suite/test observations and feeds it into future runs; curates memory from steps it had to heal.
- **Action cache** — reuses validated plans across similar runs to cut planner work, tokens, and runtime.
- **Sandboxed hooks** — Node/Bun/Python/Bash setup/teardown in Docker containers.
- **NL tests** + **BYO LLM** (OpenAI/Anthropic-compatible, Gemini, local, subscriptions).

### Where you stand

- BYO LLM: **parity already** — your `model-api-connector` + `agentic-harness` backend resolution (minimax → openai → kimi → ollama) does this.
- Self-healing, execution memory, action cache, sandboxed hooks: **missing.** Your `generator/` emits static `@playwright/test` specs; container deploy (Docker) remains unbuilt.

### Concrete implementation (if porting rather than adopting)

| agent-qa feature | Where it goes | Note |
|---|---|---|
| Self-healing runner | wrap `execution-layer/test-executor/` | On selector failure, hand the DOM + intent to an agent that finds an alternate locator and continues. Gate behind a flag — it trades determinism for robustness. |
| Action/plan cache | `testo/` (next to model-api-connector cache) | Key validated step plans by test signature; your diagram already lists a `cache` on `ModelAPIConnector` but it isn't a plan cache yet. |
| Execution memory | shares the §2 skill-memory store | Don't build two memory systems — heal events ARE skill-memory writes. This is where Acontext and agent-qa converge. |
| Sandboxed hooks | build a container-deploy component (Docker) | Docker hooks for fixture seeding / teardown. |

### Build vs. borrow — and a license caveat

agent-qa is the closest thing to *what you're building*, so seriously weigh **adopting it** for the execution layer instead of reimplementing. **But**: despite the "open-source" wording, the repo is tagged `fair-source` and `fsl` (Functional Source License) — that is **not** an OSI-approved open-source license and typically restricts competing commercial use. **Verify `LICENSE.md` before pulling it into a commercial product.** Acontext (Apache-2.0) and NetworkX (BSD) are safe to vendor; agent-qa needs a license read first. If the license is compatible with your use, adopt its runtime and skip months of work; if not, port the three ideas above.

---

## Prioritized roadmap

| Phase | Item | Effort | Impact | Depends on |
|---|---|---|---|---|
| **P0** | NetworkX analytics (PageRank/communities/clustering) over `click-graph.json` → fill `feature-extractor`, `gap-analyzer`, `knowledge-synthesizer` | S | High | nothing — data exists |
| **P0** | Wire centrality score into `test-plan-creator` as test priority | S | High | analytics above |
| **P1** | Skill-memory loop: distill fails/heals → Markdown → `get_skill` tool in agentic-harness | M | High (compounding) | feedback hook |
| **P1** | kg-gen extractor for tribal/Jira/Confluence text only | M | Medium | content-extractor slot |
| **P2** | Self-healing test-executor wrapper (flagged) | L | High | execution memory store |
| **P2** | Action/plan cache | M | Medium | agentic-harness |
| **P2** | Sandboxed hooks (`container-deploy`) | M | Medium | — |
| **eval** | License-check agent-qa; decide adopt-vs-port for execution layer | S | Decision gate | — |

S ≈ days, M ≈ 1–2 weeks, L ≈ multi-week.

## The one insight tying it together

Your architecture already draws the feedback loop (`E_REP -. results feedback .-> KB_ORCH`) but it's a data dump today. These three projects, combined, make it a real loop:

**Graph analytics (kg-gen/NetworkX)** scores what matters → **prioritized generation** tests it → **self-healing execution (agent-qa)** runs it robustly and observes reality → **skill memory (Acontext)** distills the outcome into reusable runbooks → those runbooks raise/lower **graph confidence** and inform the next generation pass. Build P0 and P1 and you have that loop spinning; P2 makes it robust.
