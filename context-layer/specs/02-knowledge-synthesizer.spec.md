# Component 2 — Knowledge-Synthesizer · SPEC

**Status:** v1.0 — as-built reconstruction (captured 2026-07-13 from the working HSBC implementation; supersedes draft v0.1)
**Depends on:** Component 0 (Content-Extractor), Component 1 (Provenance & Confidence Schema)
**Consumed by:** Component 3 (Gap-Analyzer), Component 4 (Feature-Extractor), Component 5 (Knowledge Base + Store)

> This spec defines the **`CanonicalFact`** — the central data structure of the
> context layer. Components 3–6 all read `CanonicalFact`s; changes here ripple to
> all of them. This revision documents what was actually built and validated
> against a real target (Pulse); §10 lists where it deviates from draft v0.1 and why.

---

## 1. Purpose & Non-Goals

**Purpose.** Turn the indexer's *N* noisy, exact-key-deduplicated observations into
**one canonical, trustworthy fact per real entity**, with a fused confidence, a
provenance trail, and any residual disagreements surfaced as explicit conflicts.

It solves the concrete defect documented in `CONTEXT-LAYER-COMPONENTS.md`: the
indexer dedups by *exact key only*, so `/users/{id}` (AST), `/users/:id` (spec), and
`/users/123` (live) become three separate "single-source" items and
`combineConfidence` never runs. The synthesizer canonicalizes them into one fact
whose confidence reflects that independent sources agree.

**Non-Goals.**
- MUST NOT cluster facts into features — that is Component 4.
- MUST NOT compute coverage gaps — that is Component 3.
- MUST NOT persist to a database or embed vectors — that is Component 5.
- MUST NOT re-run extraction; it consumes only `output/indexed_output/`.
- SHOULD NOT invent attributes not present in any observation.

---

## 2. Module Layout (as built)

```
context-layer/knowledge-synthesizer/
  synthesize.mjs            ← CLI entrypoint: node synthesize.mjs
  lib/
    canonicalize.mjs        ← entity resolution + path templating
    families.mjs            ← source family classification
    fusion.mjs              ← noisy-OR confidence fusion
    conflicts.mjs           ← attribute fusion + conflict surfacing (incl. VOLATILE set)
    models.mjs              ← CanonicalFact assembly + envelope builder
    load-indexed.mjs        ← reads output/indexed_output/*.json
knowledge-base/
  schema.mjs                ← DiscoveryTier enum, confidenceForTier(), combineConfidence()
```

**CLI:** `node context-layer/knowledge-synthesizer/synthesize.mjs`
Reads `output/indexed_output/`, writes `output/synthesized/facts.json`.

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
  `DiscoveryTier`. Unknown tiers are a per-observation error (§6.5).

---

## 4. Entity Resolution (canonicalize.mjs)

### 4.1 Path templating

All parameter-segment spellings collapse to `{id}`: `/users/:id`, `/users/{id}`,
`/users/<id>`, `/users/123` → `/users/{id}`.

A path segment is rewritten to `{id}` when it matches any of:

| Segment pattern | Rule |
|---|---|
| `:id`, `{id}`, `<id>` | explicit placeholder → `{id}` |
| purely numeric (`^\d+$`) | → `{id}` |
| UUID format | → `{id}` |
| 8+ hex chars | → `{id}` |
| base64url `[A-Za-z0-9_-]{16,}` **with ID entropy** (see below) | → `{id}` |

**The `_hasIdEntropy()` heuristic (hard-won on Pulse):** a long base64url-looking
segment is only treated as an ID if it contains a digit, OR contains `-`/`_`, OR is
mixed-case. All-lowercase long strings are route names, not IDs. Rationale: Pulse
uses 22-char mixed-case base64url tenant IDs (e.g. `iM5XCHE5aF0r5pievMBJNQ`,
`oz7f-vIm3vARa_YcLMhEeQ`); a naïve `[A-Za-z0-9_-]{16,}` also matched route names
like `application-management` and wrongly merged distinct routes.

### 4.2 Normalization

Beyond templating: strip query string and hash; collapse `//` → `/`; remove trailing
slash; uppercase the HTTP method.

### 4.3 Canonical key & origin semantics

```
endpoint|{METHOD}|{originKey}|{pathTemplate}
```

**Origin semantics matter:** the current target's base URL collapses to the literal
`same-origin`; cross-origin hosts (CDN, auth provider, backend APIs) keep their host
as `originKey` and therefore never merge with app endpoints.

### 4.4 Blocking (performance guard only)

Before any comparison, items are bucketed by a cheap deterministic block key:

```
endpoint|{METHOD}|{originKey}|seg={count}|first={firstSegment}
```

e.g. `endpoint|GET|same-origin|seg=4|first=api` groups all 4-segment GET endpoints
under `/api/...`. Only items in the same block are ever merge candidates. Blocking
does NOT decide identity — the canonical key does. `SYNTH_BLOCK_MAX` (env, default
`200`) shards oversized blocks.

### 4.5 LLM residue pass — interface defined, NOT implemented

`SYNTH_LLM` (env) defaults to **`0` (off)** and the pass is currently a stub:
non-identical canonical keys stay separate (conservative — never over-merge), and
`stats.llmMatchCalls` is always `0`.

The defined interface for a future implementation: `SYNTH_LLM=1` enables one batched
LLM call per block over the fuzzy residue (same block, non-identical canonical keys,
e.g. `/user/{id}` vs `/users/{id}`). On any failure it MUST fail safe (no merge).

The synthesizer MUST NOT merge across `kind` boundaries.

---

## 5. Confidence Fusion (families.mjs + fusion.mjs)

### 5.1 Source families (explicit mapping in `families.mjs`)

| Family class | Sources | Family key |
|---|---|---|
| `runtime` | `crawler`, `mock-data` | always `"runtime"` (one family per fact) |
| `spec` | `openapi-spec`, `openapi-file`, `markdown-apispec` | `spec:{sourceFile}` |
| `docs` | `docs`, `docs-extracted`, `diagram`, `user-answered`, `user` | `docs:{sourceFile}` |
| `code` | everything else (AST extractors, framework extractors, graphify, …) | `code:{sourceFile}` |

**Key rules:**
- For `code`/`spec`/`docs`, the family is keyed by **`sourceFile`**, not `sourceId`:
  two extractors reading the same file = one family (MAX); two different files = two
  independent families (noisy-OR).
- `runtime` is special: crawler and mock-data are correlated views of the same live
  system, so they are always one `"runtime"` family regardless of file.
- The family key MUST NOT use `contentHash` — that addresses content, not artifact
  identity, and would wrongly split correlated runtime observations.

### 5.2 The math (textbook noisy-OR, implemented verbatim)

```js
// knowledge-base/schema.mjs
export function combineConfidence(a, b) {
  return 1 - (1 - a) * (1 - b);
}

// fusion.mjs — reduction across families:
const confidence = families.reduce(
  (acc, f) => combineConfidence(acc, f.maxConfidence), 0
);
```

- Within a family: `MAX(confidence)`.
- Across families: fold `combineConfidence` left-to-right (commutative/associative,
  so order-independent).
- Result rounded to **6 decimal places**.
- A single-source fact retains its tier confidence exactly (no inflation).
- `confidence` MUST be in `[0,1]`, monotonic non-decreasing in corroboration.

---

## 6. Attribute Fusion & Conflicts (conflicts.mjs)

### 6.1 Precedence

For each attribute observed by ≥1 source, produce one canonical value:
(a) highest `discoveryTier`; (b) on tier tie, most-corroborated value; (c) on further
tie, deterministic order by `sourceId`. Runtime-authoritative fields (e.g.
`statusCounts`, observed auth, latency) prefer `live_observed` regardless of ranking.

### 6.2 Conflict surfacing

Any attribute where ≥2 sources supply materially different values is recorded in
`conflicts` (even when a value is chosen, `resolution: "kept-highest-tier"`).
Whitespace/case-only differences do not count.

### 6.3 Volatile attribute suppression (hard-won on real crawls)

`conflicts.mjs` maintains a **`VOLATILE` set (~20 attributes)** — e.g. `avgRequestMs`,
`statusCounts`, `sampleRequestHeaders`, `triggeredByPages`, `consoleMessages`,
`elementText` — that differ on every crawl sample. Without suppression they generated
hundreds of spurious "conflicts" that drowned out genuine semantic disagreements for
the Gap-Analyzer. Rule: fuse a canonical value for volatile attributes normally, but
**suppress the conflicts entry**.

### 6.4 Edge cases

- **Empty input topic:** contributes 0 facts, not an error.
- **Single observation:** valid `CanonicalFact`, `corroborationCount: 1`, `conflicts: []`.

### 6.5 Errors

- **Unknown `discoveryTier`:** log a warning, keep the observation in `observations`,
  exclude it from fusion, record in stats.
- **LLM match failure/timeout (when enabled):** fail safe (no merge); increment a stat.
- No network access except the (currently stubbed) LLM matcher.

---

## 7. Output (models.mjs)

**File:** `output/synthesized/facts.json` (single file, as built).

**Envelope:**
```jsonc
{
  "generatedAt": "<ISO8601>",
  "target": "<string|null>",
  "sourceTopics": ["apis", "routes", "..."],
  "stats": {
    "inputItems": 812,
    "canonicalFacts": 655,
    "mergedByCanonicalization": 157,   // items collapsed by entity resolution
    "conflicts": 23,
    "llmMatchCalls": 0                 // always 0 in current impl (LLM pass stubbed)
  },
  "facts": [ /* CanonicalFact[] */ ]
}
```

**`CanonicalFact` (THE contract — Components 3/4/5/6 depend on this exact shape):**
```jsonc
{
  "factId": "endpoint::GET::same-origin::/api/v1/users/{id}",
  "kind": "endpoint",       // endpoint|route|page|model|dependency|interaction|db-table|redirect|test-field
  "key": {
    "method": "GET",
    "originKey": "same-origin",        // or the cross-origin host
    "pathTemplate": "/api/v1/users/{id}"
  },
  "attributes": { /* fused, conflict-resolved fields */ },
  "confidence": 0.987,
  "provenance": {
    "families": [
      { "key": "runtime", "class": "runtime", "sourceIds": ["crawler"] }
      /* … one entry per contributing family … */
    ],
    "fusion": { "method": "noisy-or-of-family-max", "familyCount": 2 },
    "tiers": ["ast", "live_observed"],
    "corroborationCount": 2,           // # of independent FAMILIES that agree on key
    "highestTier": "live_observed",
    "contentHash": "6f6a5dc4286b52de"  // 16-char SHA-256 prefix over fused content
  },
  "observations": [ /* raw verbatim Observation[], for explainability */ ],
  "equivalenceGroup": [                // raw IndexedItem ids canonicalized into this fact
    "GET:/api/v1/users/{id}", "GET:/api/v1/users/:id"
  ],
  "conflicts": [
    { "attribute": "authRequired",
      "values": [ /* {value, sources[]} */ ],
      "resolution": "kept-highest-tier",   // or "unresolved"
      "chosen": true }
  ]
}
```

**Field rules.**
- `factId` is **identity-addressed, not content-addressed**: it derives from the
  canonical key (`kind::METHOD::originKey::pathTemplate`) and is stable across runs.
  Attribute drift changes `provenance.contentHash`, never the `factId`. (Component 5
  uses `contentHash` for incremental re-index diffing.)
- `attributes` MUST be the *fused* view; per-source raw values remain in `observations`.
- `conflicts` MUST be empty `[]` (not omitted) when there is no disagreement.

---

## 8. Invariants

- **Determinism:** with `SYNTH_LLM=0` (the default), identical input MUST produce
  byte-identical output (stable sort by `factId`).
- **Idempotency:** running twice on unchanged inputs yields identical `facts.json`.
- **Conservatism:** never merge two distinct real entities in preference to leaving
  them separate (precision over recall on merges). The stubbed LLM pass preserves
  this by construction.
- **Explainability:** every `CanonicalFact` retains all contributing raw
  `observations` and its `equivalenceGroup`.
- **Perf budget:** ≤ 5 s wall-clock for a 5k-observation corpus with `SYNTH_LLM=0`.

**Env:**
| Var | Default | Effect |
|---|---|---|
| `SYNTH_LLM` | `0` | `1` would enable the fuzzy-residue LLM matcher (not yet implemented). |
| `SYNTH_BLOCK_MAX` | `200` | Max block size before sharding (perf guard). |

---

## 9. Acceptance Criteria

1. Given AST `/users/{id}`, spec `/users/:id`, and live `/users/123` (same origin),
   the output contains **one** `endpoint` fact whose `equivalenceGroup` lists all
   three source ids. ✅ fixture-verifiable.
2. That fact's `confidence` equals the noisy-OR fold of the family MAXes — e.g. two
   families at `{0.90, 0.95}` → `1 − (0.10 · 0.05)` = `0.995` — not the plain MAX. ✅
3. Two AST extractors reading the **same file** contribute one `code:{sourceFile}`
   family (MAX), not two noisy-OR terms; the same extractors on **different files**
   contribute two. ✅
4. `crawler` + `mock-data` always fuse as the single `"runtime"` family, even when
   their `sourceFile`s differ. ✅
5. A same-path endpoint on a cross-origin host (e.g. CDN) does NOT merge with the
   same-origin endpoint (distinct `originKey`). ✅
6. `application-management` (long, all-lowercase) is preserved as a route segment;
   `iM5XCHE5aF0r5pievMBJNQ` (mixed-case base64url) templatizes to `{id}`. ✅
7. `authRequired` disagreeing across sources appears in `conflicts` with a chosen
   value; `avgRequestMs` differing across crawl samples does NOT (VOLATILE set),
   though it still gets a fused canonical value. ✅
8. Two runs on unchanged input produce byte-identical `facts.json`. ✅
9. Missing `output/indexed_output/` exits non-zero with a clear message. ✅
10. No tier/confidence table exists outside `knowledge-base/schema.mjs`. ✅

---

## 10. Deviations from draft v0.1 (what the build changed, and why)

| Draft v0.1 said | As built | Why |
|---|---|---|
| `context-layer/synthesizer/` | `context-layer/knowledge-synthesizer/` with a `lib/` split (canonicalize / families / fusion / conflicts / models / load-indexed) | one module per pipeline stage |
| `factId` "content-addressed" | **identity-addressed**; `contentHash` moved into `provenance` | attribute drift must not change fact identity, or Component 5 diffing breaks |
| `key` = method + pathTemplate | adds **`originKey`** (same-origin collapse; cross-origin hosts distinct) | CDN/auth/backend endpoints must never merge with app endpoints |
| `SYNTH_LLM` default `1` | default **`0`**, pass stubbed (interface only) | deterministic rules covered the real target; conservative no-merge is safe |
| family = "same `sourceId` root" | explicit 4-class table; keyed by **`sourceFile`** (never `contentHash`); `runtime` always one family | correlated evidence is per-artifact, not per-extractor; crawler+mock-data observe the same live system |
| `fuseConfidence(sources)` new API | kept `combineConfidence(a,b)` (now real noisy-OR) + fold in `fusion.mjs` | smaller schema.mjs surface; fold is order-independent |
| conflicts for any material difference | **VOLATILE set (~20 attrs) suppressed** from conflicts | crawl-sample noise generated hundreds of spurious conflicts drowning real ones |
| — | `_hasIdEntropy()` gate on base64url segments | Pulse tenant IDs vs route names like `application-management` |
| open: single vs sharded output | single `facts.json` confirmed | counts stayed well under the ~5k threshold |

## 11. Open Questions (carried forward)

- **LLM matcher model & prompt contract** — interface defined (§4.5), implementation
  pending; needs a strict JSON verdict schema.
- **Cross-kind links** (page→endpoint "triggers") — still deferred to Components 4/5.
- **Staleness decay** in fusion via `contentHash` age — deferred.
