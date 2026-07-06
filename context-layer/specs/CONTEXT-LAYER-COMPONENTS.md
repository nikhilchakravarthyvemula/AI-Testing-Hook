# Context Layer — Component Breakdown & Build Plan

> Reconciles the V11 architecture diagram, the current codebase, and the deep-research
> conclusions into the definitive list of components to build, in dependency order.
>
> The context layer is a **transformation pipeline**: it turns raw, noisy, overlapping
> observations of the system-under-test into *trustworthy, deduplicated, feature-organized,
> gap-aware facts served just-in-time to the generators*. Each component is one stage of that
> transformation.

---

## The mental model

```
RAW OBSERVATIONS ──▶ TRUSTWORTHY FACTS ──▶ ORGANIZED + GAP-AWARE ──▶ STORED/RANKED ──▶ SERVED
   (many sources)      (dedup + fused)      (features + gaps)         (KB + vectors)   (MCP)
```

Everything below fills one arrow. Build them in this order because **each consumes the output
of the one before it**.

---

## Component 0 — Content-Extractor · ✅ BUILT (needs one upgrade)

- **What:** The orchestrator that runs ~30 source extractors (crawler, graphify, AST, OpenAPI,
  framework extractors) in a staged parallel pipeline and writes per-source bundles.
- **Why it exists:** You can't reason about a system you haven't observed. This is the
  acquisition layer — get everything the SUT reveals from code, runtime, and specs.
- **In → Out:** target URL + codebase → `output/sources/*.json`.
- **Upgrade needed (from research):** move provenance from **per-bundle → per-fact** (populate
  `sourceFile`, line ranges, `contentHash` per entity) so downstream staleness and lineage work.

## Component 1 — Provenance & Confidence Schema · ✅ BUILT (needs consolidation)

- **What:** `knowledge-base/schema.mjs` — the shared vocabulary of trust: `DiscoveryTier`,
  `confidenceForTier()`, `provenance()`, `combineConfidence()`.
- **Why it exists:** Every fact must carry *where it came from* and *how much to trust it*. This
  is the common currency the whole layer speaks. (Diagram calls this the "Audit log.")
- **Upgrade needed:** kill the **duplicate** tier table in `indexer/lib/models.mjs`; make this
  the *single* source of truth. Upgrade `combineConfidence` from `MAX` → **noisy-OR** (it's
  currently dead code — defined, never called).

---

## Component 2 — Knowledge-Synthesizer · 🔨 BUILD FIRST (highest value)

- **What:** Turns *N* noisy, overlapping observations into **one** canonical fact. Three
  sub-steps: **(a) entity resolution** (canonicalize `/users/{id}` ≡ `/users/:id` ≡
  `/users/123`, block, LLM-match the fuzzy residue); **(b) confidence fusion** (noisy-OR across
  independent sources, MAX within same-source families); **(c) per-fact provenance/lineage**.
- **Why it exists — the core problem it solves:** Today the indexer dedups by *exact key only*,
  so the same real endpoint seen three ways looks like three low-confidence "single-source"
  items, and `combineConfidence` never runs. The synthesizer is what makes facts **trustworthy**:
  deduplicated, corroboration-boosted, and explainable.
- **In → Out:** indexer observations → canonical facts, each with a fused confidence + kept
  observations for explainability + surfaced conflicts.
- **Depends on:** Components 0, 1.
- *(Diagram: this is the missing brain behind "Validator" + "Indexed output.")*

## Component 3 — Gap-Analyzer · 🔨 BUILD SECOND

- **What:** Diffs the reconciled sources to surface disagreement as **coverage gaps**:
  spec-declared-but-unobserved, observed-but-undeclared (shadow endpoint), documented-but-absent,
  untested.
- **Why it exists:** This is the **signature output of a *testing* harness**. A generator that
  only tests what it observed can never tell you what it *missed*. Gaps turn the harness from a
  test *generator* into a coverage *auditor*. It consumes the `conflicting` cases the synthesizer
  surfaces (which today just get a dead label).
- **In → Out:** reconciled facts + conflicts → `gaps.json` (prioritized coverage holes).
- **Depends on:** Component 2 — you must diff *canonicalized* facts, or `/users/{id}` vs
  `/users/:id` shows up as a false gap.

## Component 4 — Feature-Extractor · 🔨 BUILD THIRD

- **What:** Clusters endpoints + pages + interactions into **features** (functional areas:
  "Authentication," "Checkout") by URL-prefix + co-occurrence.
- **Why it exists:** The *right altitude* for everything downstream — generators produce coherent
  suites when prompted per-feature, coverage reports read as "Checkout 80% covered," and
  (crucially) **the feature becomes the primary retrieval unit** for serving context.
- **In → Out:** reconciled facts → `features.json` (feature → {endpoints, pages, interactions}).
- **Depends on:** Component 2 (cluster reconciled, not raw-duplicated, facts).

---

## Component 5 — Knowledge Base + Store (+ selective embeddings) · 🔨 BUILD FOURTH

- **What:** The unified single source of truth. This is the never-built `knowledge-base/build.mjs`
  + `store.mjs` — merge reconciled facts + features + gaps + provenance into one queryable store,
  and (per research) add **selective vector embeddings** for semantic recall. Target:
  **Postgres + pgvector** with hybrid BM25+vector.
- **Why it exists:** Downstream needs *one* place to query — "give me everything about Checkout,
  ranked by trust." Today `indexed_output/*.json` is an ad-hoc stand-in; this makes it canonical
  and adds semantic search for "find anything about X." Research says pgvector is the right
  consolidated store at your scale (not a graph DB — your relations are already deterministic).
- **In → Out:** facts + features + gaps → `knowledge.json` / Postgres rows + vector index.
- **Depends on:** Components 2–4.
- **Cost discipline (research):** deterministic-first, local code-specialized embeddings,
  AST-aware chunking, Merkle/content-hash incremental re-index so you re-embed only what changed.

## Component 6 — Context-Server / Retrieval API (MCP-first) · 🔨 BUILD FIFTH

- **What:** The interface generators actually call. Exposes MCP **tools** —
  `get_feature_context("Checkout")`, `query_endpoints(...)`, `list_gaps()` — returning
  **confidence-ranked, provenance-tagged, top-k, budgeted** results.
- **Why it exists:** Producing good facts is half the job; *delivering* them without poisoning the
  LLM's context is the other half. Research is emphatic: just-in-time retrieval beats
  context-stuffing (avoids "context rot"), and MCP is now the industry standard. This is where
  "context quality for the LLM" is actually realized.
- **In → Out:** generator query → the exact slice of the KB it needs.
- **Depends on:** Component 5 (can serve over files/SQLite initially, migrate storage behind the
  same MCP interface later — matches the "MCP-first, defer the DB" direction).

## Component 7 — Mind-Map-Builder · 🔨 BUILD LAST (parallelizable)

- **What:** Human-facing Mermaid + interactive HTML graphs of the knowledge (routes, endpoint
  graph, feature map). The existing `graph-viewer` is a partial start.
- **Why it exists:** Explainability, debugging, and human trust — "show me what the harness
  understands about this app." Not on the critical serving path, so it comes last and can be
  built in parallel.
- **Depends on:** Component 5 (visualizes the KB).

---

## How they compose into the full context layer

```
┌─ Component 1: Provenance & Confidence Schema (the trust currency — underpins ALL) ─┐
│                                                                                    │
│  [0] Content-Extractor ──▶ [2] Knowledge-Synthesizer ──┬──▶ [3] Gap-Analyzer ──┐   │
│   acquire raw facts         resolve + fuse + lineage   │     coverage gaps     │   │
│   (per-fact provenance)     (ONE trustworthy fact)     └──▶ [4] Feature-Extractor  │
│                                                              cluster → features  │  │
│                                                                     │            │  │
│                                    [5] Knowledge Base + Store  ◀────┴────────────┘  │
│                                     unified facts + features + gaps + embeddings    │
│                                                     │                               │
│                                    [6] Context-Server (MCP) ──▶ to GENERATORS       │
│                                     ranked, provenance-tagged, just-in-time         │
│                                                     │                               │
│                                    [7] Mind-Map-Builder ──▶ to HUMANS               │
└────────────────────────────────────────────────────────────────────────────────────┘
```

**The logic of the sequence:**

1. **Acquire** before you can reconcile (0).
2. **Reconcile** before you can diff or cluster — gaps and features on un-deduplicated facts are
   garbage (2 → 3, 4).
3. **Store** the reconciled+organized result as the canonical KB before you can serve it (5).
4. **Serve** it well — the whole point — via MCP (6).
5. **Visualize** for humans, off the critical path (7).

**Why this is "the full context layer" and not more:** together these seven take you from *"here
are 30 raw source dumps"* to *"here is the single most-trustworthy, feature-organized,
gap-annotated fact about the system, delivered to the generator exactly when it asks, with its
provenance attached"* — which is precisely the two objectives: **maximum context quality for the
LLM, at minimum cost.**

---

## Status snapshot & build order

| # | Component | Status | Build order |
|---|---|---|---|
| 0 | Content-Extractor | ✅ Built (needs per-fact provenance) | — |
| 1 | Provenance & Confidence Schema | ✅ Built (consolidate + noisy-OR) | — |
| 2 | Knowledge-Synthesizer | 🔨 Greenfield | **1st** |
| 3 | Gap-Analyzer | 🔨 Greenfield | 2nd |
| 4 | Feature-Extractor | 🔨 Greenfield | 3rd |
| 5 | Knowledge Base + Store (+ embeddings) | 🔨 Greenfield (`build.mjs`/`store.mjs` absent) | 4th |
| 6 | Context-Server (MCP-first) | 🔨 Greenfield | 5th |
| 7 | Mind-Map-Builder | 🔨 Partial (`graph-viewer`) | Last / parallel |

**Component 2 (Knowledge-Synthesizer) is the correct first build** — it's the highest-value gap,
it unblocks 3, 4, and 5, and it touches code (`schema.mjs`, the indexer) that already exists.

---

## Related documents

- Deep-research report: `~/Documents/AI_Testing_Harness_Context_Layer_Research_20260629/report.md`
  (knowledge representation, backend evaluation, confidence fusion, cost-efficient extraction,
  MCP serving — with sources/evidence/claims ledgers).
- Current provenance/merge implementation: `knowledge-base/schema.mjs`, `context-layer/indexer/`.
