# Component 2 — Knowledge-Synthesizer · SPEC

**Status:** Draft v0.1
**Depends on:** Component 0 (Content-Extractor), Component 1 (Provenance & Confidence Schema)
**Consumed by:** Component 3 (Gap-Analyzer), Component 4 (Feature-Extractor), Component 5 (Knowledge Base + Store)

> This spec defines the **`CanonicalFact`** — the central data structure of the
> context layer. Components 3–6 all read `CanonicalFact`s; changes here ripple to
> all of them.

---

## 1. Purpose & Non-Goals

**Purpose.** Turn the indexer's *N* noisy, exact-key-deduplicated observations into
**one canonical, trustworthy fact per real entity**, with a fused confidence, a
provenance trail, and any residual disagreements surfaced as explicit conflicts.

It solves the concrete defect documented in `CONTEXT-LAYER-COMPONENTS.md`: the
indexer dedups by *exact key only*, so `/users/{id}` (AST), `/users/:id` (spec), and
`/users/123` (live) become three separate "single-source" items and
`combineConfidence` never runs. The synthesizer canonicalizes them into one fact
whose confidence reflects that three independent sources agree.

**Non-Goals.**
- MUST NOT cluster facts into features — that is Component 4.
- MUST NOT compute coverage gaps — that is Component 3.
- MUST NOT persist to a database or embed vectors — that is Component 5.
- MUST NOT re-run extraction; it consumes only `output/indexed_output/`.
- SHOULD NOT invent attributes not present in any observation.

---

## 2. Terminology

| Term | Definition |
|---|---|
| **Observation** | One source's view of an entity, as emitted by the indexer: `{sourceId, discoveryTier, confidence, sourceFile?, fields}`. |
| **IndexedItem** | The indexer's per-topic bucket: `{id, topic, primary, observations[], consensus}`. Input unit. |
| **CanonicalFact** | The synthesizer's output unit: one real entity, fused across observations (§4). |
| **Entity resolution** | Deciding which observations refer to the *same real entity* despite differing keys. |
| **Blocking** | Cheap deterministic bucketing (by kind + normalized key) that limits which observation pairs are compared. |
| **Fuzzy residue** | The observation pairs within a block that neither match nor mismatch deterministically; resolved by LLM. |
| **Independent sources** | Sources whose evidence is not derived from one another (e.g. `crawler` vs `python-fastapi`). Distinct from a **source family** (e.g. two AST extractors reading the same file). |
| **Noisy-OR** | Confidence fusion `1 − Π(1 − cᵢ)` over independent corroborating sources. |

---

## 3. Inputs

**Source.** All topic files under `output/indexed_output/*.json` **except** `index.json`
and any `graphs/` subdirectory.

**Per-file schema (produced by the indexer — do not modify):**
```jsonc
{
  "topic": "apis",
  "generatedAt": "<ISO8601>",
  "target": "<string|null>",
  "itemCount": 42,
  "sourcesContributing": ["python-fastapi", "crawler"],
  "items": [ /* IndexedItem[] */ ]
}
```
**IndexedItem:**
```jsonc
{
  "id": "GET:/api/v1/users/{id}",
  "topic": "apis",
  "primary": { /* topic-specific canonical-ish view */ },
  "observations": [
    { "sourceId": "python-fastapi", "discoveryTier": "ast",
      "confidence": 0.90, "sourceFile": "/abs/app.py", "fields": { /* … */ } }
  ],
  "consensus": "agreed | single-source | conflicting"
}
```

**Preconditions.**
- The indexer MUST have run this session; a missing `output/indexed_output/` is a
  hard error (exit non-zero). An empty topic file is tolerated (contributes 0 facts).
- Every observation MUST carry a `discoveryTier` valid per `knowledge-base/schema.mjs`
  `DiscoveryTier`. Unknown tiers are a per-observation error (§5, error handling).

---

## 4. Outputs

**File:** `output/synthesized/facts.json` (single file; MAY be sharded by kind later —
see Open Questions).

**Envelope:**
```jsonc
{
  "generatedAt": "<ISO8601>",
  "target": "<string|null>",
  "sourceTopics": ["apis", "routes", "..."],
  "stats": {
    "inputItems": 812,
    "canonicalFacts": 655,
    "mergedByCanonicalization": 157,  // items collapsed by entity resolution
    "conflicts": 23,
    "llmMatchCalls": 11
  },
  "facts": [ /* CanonicalFact[] */ ]
}
```

**`CanonicalFact` (THE contract — Components 3/4/5/6 depend on this exact shape):**
```jsonc
{
  "factId": "endpoint::GET::/api/v1/users/{id}",   // stable, deterministic, content-addressed
  "kind": "endpoint",            // endpoint|route|page|model|dependency|interaction|db-table|redirect|test-field
  "key": {                       // canonical identity for this kind (used for equality & joins)
    "method": "GET",
    "pathTemplate": "/api/v1/users/{id}"
  },
  "attributes": {                // fused canonical attributes; union of observed fields, conflicts resolved
    "operationId": "getUser",
    "authRequired": true,
    "responseSchemas": { "200": { /* … */ } },
    "statusCounts": { "200": 42, "404": 3 }
  },
  "confidence": 0.987,           // fused (noisy-OR across independent sources) — see §5
  "provenance": {                // per-fact lineage (Component 1 upgrade target)
    "sources": [
      { "sourceId": "python-fastapi", "discoveryTier": "ast", "confidence": 0.90,
        "sourceFile": "/abs/app.py", "sourceLineStart": 40, "sourceLineEnd": 55, "contentHash": "sha256:…" },
      { "sourceId": "crawler", "discoveryTier": "live_observed", "confidence": 0.95,
        "sourceFile": null }
    ],
    "tiers": ["ast", "live_observed", "spec"],
    "corroborationCount": 3,     // # of INDEPENDENT sources that agree on key
    "highestTier": "live_observed"
  },
  "observations": [ /* the raw Observation[] that fused into this fact — verbatim, for explainability */ ],
  "equivalenceGroup": [          // the raw IndexedItem ids canonicalized into this fact
    "GET:/api/v1/users/{id}", "GET:/api/v1/users/:id", "GET:/api/v1/users/123"
  ],
  "conflicts": [                 // attribute-level disagreements that survived fusion
    { "attribute": "authRequired",
      "values": [ { "value": true,  "sources": ["python-fastapi"] },
                  { "value": false, "sources": ["crawler"] } ],
      "resolution": "kept-highest-tier",   // or "unresolved"
      "chosen": true }
  ]
}
```

**Field rules.**
- `factId` MUST be deterministic and stable across runs given the same canonical key
  (used by Component 5 for incremental re-index / content-hash diffing).
- `attributes` MUST be the *fused* view; per-source raw values remain in `observations`.
- `conflicts` MUST be empty `[]` (not omitted) when there is no disagreement.
- `confidence` MUST be in `[0,1]`.

---

## 5. Behavior

### 5.1 Entity resolution (canonicalization)
1. The synthesizer MUST group input `IndexedItem`s **by kind** (topic → kind mapping is
   fixed: `apis→endpoint`, `routes→route`, `pages→page`, `models→model`,
   `dependencies→dependency`, `interactions→interaction`, `db-schema→db-table`,
   `redirects→redirect`, `test-data→test-field`; `mock-data`/`openapi` merge into
   `endpoint`; `click-graph` is passed through as a single `interaction-graph` fact).
2. Within a kind, it MUST **block** by a normalized key (e.g. path with params
   templatized: `:id`, `{id}`, numeric/UUID segments → `{param}`; host stripped;
   trailing slash removed). Blocking MUST be deterministic and case-normalized.
3. Items in the same block with **identical normalized keys** MUST merge with no LLM
   call (the common case; fixes the exact-key defect).
4. The **fuzzy residue** (same block, non-identical normalized keys — e.g.
   `/user/{id}` vs `/users/{id}`) MAY be resolved by a single batched LLM match call
   per block. `SYNTH_LLM=0` MUST disable the LLM pass; unresolved residue then stays
   as separate facts (conservative — never over-merge).
5. The synthesizer MUST NOT merge across `kind` boundaries.

### 5.2 Confidence fusion (normative)
- Sources MUST be partitioned into **independent sources** vs **same-source families**
  (family = same `sourceId` root, or configured correlated set).
- Within a family, the fused contribution MUST be `MAX(confidence)` (correlated
  evidence must not be double-counted).
- Across independent families, the fact confidence MUST be **noisy-OR**:
  `confidence = 1 − Π_f (1 − c_f)` where `c_f` is each family's MAX.
- `confidence` MUST be monotonic non-decreasing in corroboration and MUST never
  exceed `1`. A single-source fact MUST retain that source's tier confidence exactly.
- This replaces the dead `combineConfidence` (MAX-only) in `schema.mjs`; Component 1
  MUST expose a `fuseConfidence(sources)` implementing noisy-OR that this component calls.

### 5.3 Attribute fusion & conflicts
- For each attribute observed by ≥1 source, the synthesizer MUST produce a single
  canonical value using this precedence: (a) highest `discoveryTier`; (b) on tier tie,
  most-corroborated value; (c) on further tie, deterministic order by `sourceId`.
- **Runtime-authoritative fields** (e.g. `statusCounts`, `observedAuth`, latency) MUST
  prefer `live_observed` regardless of tier ranking.
- Any attribute where ≥2 sources supply *materially different* values MUST be recorded
  in `conflicts` (even when a value is chosen). Whitespace/case-only differences MUST
  NOT count as conflicts.

### 5.4 Edge cases & errors
- **Empty input topic:** contributes 0 facts, not an error.
- **Observation with unknown `discoveryTier`:** log a warning, keep the observation in
  `observations`, but exclude it from fusion; record in stats.
- **Single observation:** produces a valid `CanonicalFact` with `corroborationCount:1`
  and `conflicts:[]`.
- **LLM match failure/timeout:** MUST fail safe (do not merge); increment a stat.
- The component MUST be **pure w.r.t. its inputs** — no network except the optional LLM
  matcher.

---

## 6. Interface

**CLI:** `node context-layer/synthesizer/synthesize.mjs`
Reads `output/indexed_output/`, writes `output/synthesized/facts.json`.

**Env:**
| Var | Default | Effect |
|---|---|---|
| `SYNTH_LLM` | `1` | `0` disables the fuzzy-residue LLM matcher (deterministic-only). |
| `SYNTH_BLOCK_MAX` | `200` | Max block size before it MUST shard blocks (perf guard). |

**Functions (module `synthesize.mjs` + `lib/`):**
| Function | Signature | Description |
|---|---|---|
| `synthesize(indexedDir)` | `async (string) → {facts, stats}` | Top-level: load topics → resolve → fuse → write. |
| `loadIndexedTopics(dir)` | `(string) → IndexedItem[]` | Reads all `*.json` topic files (skips `index.json`, `graphs/`). |
| `blockKey(kind, key)` | `(string, object) → string` | Deterministic normalized blocking key (templatized path etc.). |
| `resolveEntities(items)` | `async (IndexedItem[]) → EquivGroup[]` | Blocking + exact-merge + optional LLM residue match. |
| `fuseConfidence(sources)` | `(SourceRef[]) → number` | Noisy-OR across independent families, MAX within a family. |
| `fuseAttributes(observations)` | `(Observation[]) → {attributes, conflicts}` | Attribute precedence + conflict surfacing (§5.3). |
| `toCanonicalFact(group)` | `(EquivGroup) → CanonicalFact` | Assembles the output record incl. `factId`, provenance. |

**Consumes from Component 1:** `DiscoveryTier`, `confidenceForTier`, and the new
`fuseConfidence` (noisy-OR). MUST import from `knowledge-base/schema.mjs` — MUST NOT
re-declare a tier table (the indexer's duplicate table in `lib/models.mjs` is to be
removed under Component 1).

---

## 7. Invariants

- **Determinism:** with `SYNTH_LLM=0`, identical input MUST produce byte-identical
  output (stable sort by `factId`). With the LLM on, only the fuzzy-residue grouping
  may vary; everything else stays deterministic.
- **Idempotency:** running twice on unchanged inputs yields identical `facts.json`.
- **Conservatism:** the synthesizer MUST never merge two distinct real entities in
  preference to leaving them separate (precision over recall on merges).
- **Explainability:** every `CanonicalFact` MUST retain all contributing raw
  `observations` and the `equivalenceGroup` of source ids.
- **Perf budget:** ≤ 5 s wall-clock for a 5k-observation corpus with `SYNTH_LLM=0`;
  LLM residue calls ≤ 1 per block.

---

## 8. Acceptance Criteria

1. Given AST `/users/{id}`, spec `/users/:id`, and live `/users/123`, the output
   contains **one** `endpoint` fact with `corroborationCount:3` and `equivalenceGroup`
   listing all three source ids. ✅ verifiable by fixture.
2. That fact's `confidence` equals noisy-OR of `{0.90, 0.95, 0.95}` (= `1 − (0.10·0.05·0.05)` = `0.99975`), **not** `0.95`. ✅
3. Two AST extractors reading the same file contribute a single family MAX, not two
   noisy-OR terms. ✅
4. An attribute where AST says `authRequired:true` and live says `false` appears in
   `conflicts` with a chosen value and `resolution`. ✅
5. `SYNTH_LLM=0` produces byte-identical output across two runs (determinism). ✅
6. Missing `output/indexed_output/` exits non-zero with a clear message. ✅
7. No import of a tier/confidence table other than `knowledge-base/schema.mjs`. ✅
8. Every emitted fact validates against the §4 JSON schema (CI schema check). ✅

---

## 9. Open Questions

- **Sharding:** single `facts.json` vs per-kind files (`facts/endpoint.json`, …). Leaning
  per-kind once counts exceed ~5k for Component 5 incremental re-index.
- **LLM matcher model & prompt contract:** which model, and a strict JSON schema for
  match verdicts (mirror the crawler's `intent-extract` discipline).
- **Cross-kind links:** should a page→endpoint "triggers" relation be a fact here or
  deferred to Component 4/5? Currently deferred.
- **`fuseConfidence` staleness decay:** research suggests down-weighting stale sources
  via `contentHash` age — deferred to a later revision.
