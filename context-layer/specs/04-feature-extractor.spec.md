# Component 4 — Feature-Extractor · SPEC

**Status:** Draft v1.0 (for review) — transcribed 2026-07-13 from the HSBC as-built spec
**Depends on:** Component 2 (Knowledge-Synthesizer — `output/synthesized/facts.json`).
Optionally enriches with Component 3 (Gap-Analyzer — `output/gaps/gaps.json`) when present.
**Consumed by:** Component 5 (Knowledge Base + Store — the feature becomes the primary
retrieval unit), Component 6 (Context-Server — `get_feature_context("Checkout")`), the
generators (one coherent suite per feature), and the coverage report ("Checkout 80% covered").

> This spec defines the **`Feature`** record — the *right altitude* for everything
> downstream. A generator prompted per-feature produces a coherent suite; a coverage report
> reads as "Admin 80% covered"; and the store retrieves "everything about Checkout" as one
> unit. The Feature-Extractor clusters reconciled facts into functional areas.

---

## 1. Purpose & Non-Goals

**Purpose.** Cluster the reconciled `CanonicalFact`s (endpoints, pages, interactions,
redirects, …) into **features** — functional areas of the system-under-test such as
"Authentication", "Admin", "Tenants", "Rules" — using deterministic structural signals
(URL/path prefixes, SPA route fragments, and co-occurrence) so that everything downstream
operates at the feature grain rather than on 700 loose facts.

```
facts.json  ──▶  [ Feature-Extractor ]  ──▶  features.json
(trustworthy facts)   cluster + name + link    (feature → {endpoints, pages, interactions, gaps})
  (+ optional gaps.json for per-feature coverage rollup)
```

**Why it exists.** On the current Pulse target the synthesizer emits ~714 facts (~46
endpoints under `/pulseviews/api/...`, a hash-routed SPA whose interactions carry
`fromPage` fragments like `#admin/authorizationKeys`, plus pages and redirects). Nothing
today groups `/pulseviews/api/admin/config`, the `#admin/*` interactions, and the admin page
into one "Admin" unit. Generators therefore see a flat, altitude-less list and cannot produce
per-feature suites, and coverage cannot be reported per functional area.

**Non-Goals.**
- MUST NOT re-run extraction, crawling, or synthesis — it consumes only `facts.json`
  (and optionally `gaps.json`).
- MUST NOT merge, re-canonicalize, or mutate facts (that is Component 2).
- MUST NOT compute gaps (that is Component 3) — it MAY *roll up* existing gaps per feature.
- MUST NOT persist to a database or embed vectors (that is Component 5).
- MUST NOT call the network. An LLM naming pass is **optional and off by default**; the
  deterministic path MUST be complete on its own.
- SHOULD NOT invent feature membership not derivable from the fact fields it is given.

---

## 2. Terminology

| Term | Definition |
|---|---|
| **CanonicalFact** | The synthesizer's output unit (Component 2 §4): one real entity with `factId`, `kind`, `key`, `attributes`, `confidence`, `provenance`. Input unit here. |
| **Feature** | One functional area: a `{featureId, name, members, coverage, …}` record (§4). Output unit. |
| **Member** | A `CanonicalFact` assigned to a feature, referenced by `factId` + `kind` (not duplicated in full). |
| **Feature key** | The deterministic slug a fact clusters under, derived from its structural signal (§5.1), e.g. `admin`, `tenants`, `auth`. |
| **Route fragment** | An SPA hash route recorded in an interaction's `fromPage`, e.g. `#admin/authorizationKeys` → fragment `admin`. |
| **Co-occurrence** | Two facts appearing on the same page / same route fragment / same interaction-graph edge — evidence they belong together. |
| **Confidence (clustering)** | How strongly a fact belongs to its assigned feature `[0,1]` (§5.3) — distinct from the fact's own trust `confidence`. |
| **Unassigned bucket** | The reserved feature (`featureId:"_unassigned"`) collecting facts no signal could place. Kept explicit, never dropped. |

---

## 3. Inputs

**Primary source.** `output/synthesized/facts.json` — the Component 2 envelope (§4 there):
```jsonc
{
  "generatedAt": "<ISO8601>",
  "target": { "baseUrl": "https://…" },
  "sourceTopics": ["apis", "pages", "interactions", "redirects", "…"],
  "stats": { "canonicalFacts": 714, /* … */ },
  "facts": [ /* CanonicalFact[] */ ]
}
```

Each consumed `CanonicalFact` MUST expose: `factId`, `kind`, `key`, `attributes`,
`confidence` (per Component 2 §4). The extractor reads structural fields per kind:

| kind | signal fields used for clustering |
|---|---|
| `endpoint` | `key.pathTemplate` (segment after `…/api/`), `key.method` |
| `page` | `key.id` (URL path + hash fragment) |
| `interaction` | `attributes.fromPage` (URL + hash fragment), `attributes.elementText` |
| `redirect` | `attributes.from`, `attributes.to` (path prefixes) |
| `interaction-graph` | `nodes`/`edges` for co-occurrence (optional signal, §5.2) |
| `route` | `key` path template (when present; absent on current target) |
| `model` / `db-table` / `dependency` / `test-field` | name/path hints; else `_unassigned` |

**Optional coverage enrichment.** `output/gaps/gaps.json` (Component 3), when present, is read
**read-only** to roll up open gaps per feature (§5.4). Absent ⇒ `coverage` is reported with
`gapsProvided:false` and gap counts zero.

**Preconditions.**
- Missing `facts.json` is a **hard error** (exit non-zero) — the synthesizer must run first.
- An empty `facts[]` array is tolerated (produces zero features, exit 0).
- Malformed facts (missing `kind`/`key`) are skipped with a counted warning, never fatal.
- `gaps.json` missing/malformed is non-fatal (coverage rollup simply omitted).

---

## 4. Outputs

**File:** `output/features/features.json` (single file).

**Envelope:**
```jsonc
{
  "generatedAt": "<ISO8601>",            // copied from facts.json for lineage
  "target": { "baseUrl": "…" },          // copied from facts.json
  "source": "output/synthesized/facts.json",
  "config": {                            // effective knobs, for reproducibility
    "minFeatureSize": 2,
    "apiSegmentDepth": 1,
    "llmNaming": false,
    "gapsProvided": true
  },
  "stats": {
    "factsAnalyzed": 714,
    "featureCount": 9,
    "assignedFacts": 690,
    "unassignedFacts": 24,
    "byKind": { "endpoint": 46, "page": 1, "interaction": 620, "redirect": 23 }
  },
  "features": [ /* Feature[] — sorted by featureId asc; _unassigned always last */ ]
}
```

**`Feature` (THE contract — Components 5/6 and the generators depend on this shape):**
```jsonc
{
  "featureId": "admin",                    // deterministic slug (stable across runs)
  "name": "Admin",                         // human label (Title-Cased slug; LLM-refined if enabled)
  "signal": "api-path+route-fragment",     // which rule(s) placed members here (§5.1) — explainability
  "summary": "Administrative configuration, authorization keys, and settings.",
  "members": {                             // factIds only — never the full fact (Component 5 joins them)
    "endpoints":    ["endpoint::GET::same-origin::/pulseviews/api/admin/config"],
    "pages":        ["page::…/#admin"],
    "interactions": ["interaction::…#admin/authorizationKeys::button:Add Key"],
    "redirects":    [],
    "other":        []
  },
  "memberCount": 37,
  "confidence": 0.86,                      // aggregate clustering confidence for the feature (§5.3)
  "entrypoints": ["/pulseviews/management/#admin"],  // representative pages/routes to start from
  "coverage": {                            // rolled up from gaps.json when present (§5.4)
    "openGaps": 12,
    "byGapType": { "shadow-endpoint": 6, "untested-endpoint": 6 },
    "highSeverityGaps": 6,
    "testableEndpoints": 6
  }
}
```

**Field rules.**
- `featureId` MUST be a deterministic, stable slug (lowercase, `[a-z0-9-]`) derived from the
  clustering signal; identical input MUST yield identical ids across runs.
- A fact MUST belong to **exactly one** feature (hard partition) — no double counting. When
  multiple signals compete, the deterministic precedence in §5.1 decides the single winner.
- `members` MUST reference facts by `factId` only; the full fact stays in `facts.json`.
- `_unassigned` MUST always be emitted (even if empty) and MUST sort last, so downstream can
  see what was not placed.
- `coverage` MUST be present with zeroed counts and `gapsProvided:false` recorded in
  `config` when `gaps.json` is absent.
- `confidence` MUST be in `[0,1]`.

---

## 5. Behavior

The extractor derives a **feature key** per fact, groups facts by key, applies a minimum-size
merge, names + summarizes each cluster, rolls up coverage, and writes the envelope. All steps
are **pure** and **deterministic**.

### 5.1 Feature-key derivation (per fact, deterministic precedence)
Each fact is assigned to **exactly one** feature key by the first rule that matches:

1. **API path segment** (`endpoint`, and `route` when present): take the path template, find
   the segment immediately **after** the API base marker (`/api/`, `/rest/`, `/v{n}/`, or
   `graphql`); the feature key is that segment (configurable depth via `apiSegmentDepth`).
   e.g. `/pulseviews/api/admin/config` → `admin`; `/pulseviews/api/tenants/{id}` → `tenants`.
   When no API marker exists, use the first non-app-prefix path segment.
2. **SPA route fragment** (`page`, `interaction`): parse the URL hash of `key.id` /
   `attributes.fromPage`; the feature key is the first fragment segment.
   e.g. `…/management/#admin/authorizationKeys` → `admin`.
3. **Redirect endpoints** (`redirect`): key from the **`to`** path's first meaningful segment
   (the destination is the feature the user lands in); `login`/`logout`/`auth`/`sso` → `auth`.
4. **Co-occurrence fallback** (§5.2): a fact with no structural key inherits the feature of the
   page/route it co-occurs with in the `interaction-graph`, if unambiguous.
5. **Semantic buckets:** well-known segments MUST fold into canonical feature keys via a small
   deterministic synonym map — `login|logout|signin|signout|sso|session|auth` → `auth`. The map
   is data, not code, and configurable (§6). Everything else keeps its literal segment key.
6. **Unassigned:** no rule matched ⇒ `_unassigned`.

Rules are tried in the order above; the **first** match wins (a single, explainable winner
recorded in `Feature.signal`). Key derivation MUST be case-normalized and trailing-slash
insensitive.

### 5.2 Co-occurrence (secondary signal)
- The single `interaction-graph` fact (nodes = pages/elements, edges = navigations/triggers)
  MAY be used to (a) place structurally-keyless facts (rule 4) and (b) record `entrypoints`.
- Co-occurrence MUST only *place* a fact when the inherited feature is **unambiguous** (all
  neighbors agree); ambiguous cases fall through to `_unassigned` (conservative).
- Co-occurrence MUST NOT override a structural key from rules 1–3.

### 5.3 Naming, summary & confidence
- **Name:** default is the Title-Cased, de-slugified `featureId` (`tenants` → "Tenants",
  `auth` → "Authentication" via the synonym map's display label). With `FEAT_LLM=1`, a single
  batched LLM call MAY refine names/summaries from member texts; it MUST NOT change `featureId`
  or membership, only `name`/`summary`. `FEAT_LLM=0` (default) keeps naming deterministic.
- **Summary:** deterministic default lists the dominant member kinds and top path segments; LLM
  may replace the prose (identity unchanged).
- **Feature confidence:** aggregate of member clustering strength:
  `confidence = clamp01( 0.5 + 0.5 * (strongSignalMembers / memberCount) )`
  where a *strong-signal* member is one placed by rules 1–3 (structural), vs rule-4
  co-occurrence or size-merge (weak). A feature whose members are all structurally keyed
  approaches `1.0`; a mostly co-occurrence cluster sits near `0.5`.

### 5.4 Coverage rollup (when `gaps.json` present)
- Each gap's `subject.factId` is matched to its owning feature; the feature's `coverage`
  aggregates `openGaps`, `byGapType`, `highSeverityGaps`, and `testableEndpoints`
  (= endpoint members). Gaps whose `factId` matches no member are counted under
  `_unassigned`. This is a **read-only rollup** — no gap is created, mutated, or re-scored.

### 5.5 Minimum-size handling
- Clusters smaller than `FEAT_MIN_SIZE` (default 2) MUST NOT pollute the feature list as
  singletons. Such facts MUST move to `_unassigned` (default) — never silently dropped.
  (Rationale: a lone fact is not yet a "functional area".) The threshold is configurable; set
  to `1` to keep singletons as their own features.

### 5.6 Edge cases & errors
- **Empty `facts[]`:** zero features (only an empty `_unassigned`), exit 0.
- **Fact missing `key`/`kind`:** skip, increment `stats.skipped`, warn once.
- **All facts unassignable:** a single `_unassigned` feature holding everything, exit 0.
- **`gaps.json` missing/malformed:** skip coverage rollup, `config.gapsProvided:false`, warn
  once, never fatal.
- **LLM naming failure/timeout (when enabled):** fall back to deterministic names, increment a
  stat, never fatal.

---

## 6. Interface

**CLI:** `node context-layer/feature-extractor/extract.mjs [--gaps <path>]`
Reads `output/synthesized/facts.json` (+ optional `output/gaps/gaps.json`), writes
`output/features/features.json`.

**Pipeline position** (`context-layer/scan.mjs`): content-extractor → indexer →
knowledge-synthesizer → gap-analyzer → **feature-extractor** → graph-viewer.

**Env:**
| Var | Default | Effect |
|---|---|---|
| `FEAT_MIN_SIZE` | `2` | Min members before a cluster is a feature; smaller ⇒ `_unassigned`. |
| `FEAT_API_SEGMENT_DEPTH` | `1` | How many path segments after the API marker form the key. |
| `FEAT_SYNONYMS` | *(built-in)* | Path to a JSON synonym/display-label map (overrides built-in). |
| `FEAT_GAPS_FILE` | *(unset)* | Path to the gaps input; `--gaps` overrides. |
| `FEAT_LLM` | `0` | `1` enables the optional LLM naming/summary refinement pass. |

**Functions (module `extract.mjs` + `lib/`):**
| Function | Signature | Description |
|---|---|---|
| `extract(factsPath, opts)` | `async (string, object) → Envelope` | Top-level: load → key → cluster → name → rollup → assemble. |
| `loadFacts(path)` | `(string) → {facts, target, generatedAt}` | Reads & validates the facts envelope. |
| `featureKey(fact, cfg)` | `(Fact, object) → {key, signal}` | §5.1 deterministic key + winning signal. |
| `clusterByKey(facts, cfg)` | `(Fact[], object) → Cluster[]` | Group by key, apply co-occurrence + min-size. |
| `nameFeature(cluster, cfg)` | `(Cluster, object) → {name, summary, confidence}` | §5.3 naming + confidence. |
| `rollupCoverage(features, gaps)` | `(Feature[], Gap[]) → Feature[]` | §5.4 per-feature gap rollup. |

**Consumes:** only the public `facts.json` (and optional `gaps.json`) files. It MUST NOT
import extractor, indexer, synthesizer, or gap-analyzer internals.

---

## 7. Invariants

- **Determinism:** identical `facts.json` (+ identical `gaps.json` + env, `FEAT_LLM=0`) MUST
  produce byte-identical `features.json`. Features sorted by `featureId` asc (`_unassigned`
  last); every member array deterministically ordered by `factId`.
- **Idempotency:** running twice on unchanged inputs yields identical output.
- **Hard partition:** every analyzed fact appears in **exactly one** feature (assigned or
  `_unassigned`); the sum of `memberCount` equals `stats.assignedFacts + unassignedFacts`.
- **Purity:** no network, no mutation of `facts.json`/`gaps.json` (LLM naming, when enabled, is
  the only optional network call and never changes identity or membership).
- **Explainability:** every `Feature` MUST record the `signal` that formed it; every fact's
  placement is traceable to one rule in §5.1.
- **Conservatism:** ambiguous facts go to `_unassigned` rather than being force-fit.
- **Perf budget:** ≤ 1 s wall-clock for the current corpus (~714 facts); linear in fact count.

---

## 8. Acceptance Criteria

1. `/pulseviews/api/admin/config` (endpoint), a `#admin/*` interaction, and the admin
   page/route land in **one** `admin` feature with `signal` reflecting api-path +
   route-fragment. ✅ verifiable by fixture.
2. `/pulseviews/api/tenants/{id}` and `/pulseviews/api/tenants` cluster under `tenants`
   regardless of the templated id. ✅
3. A `login`/`logout` redirect and any `#login` interaction fold into a single `auth` feature
   via the synonym map. ✅
4. Every analyzed fact appears in exactly one feature; `Σ memberCount == assignedFacts +
   unassignedFacts` and no `factId` appears twice. ✅
5. A structural signal (rules 1–3) MUST win over co-occurrence (rule 4) for the same fact. ✅
6. A cluster of size 1 with `FEAT_MIN_SIZE=2` moves to `_unassigned`; with `FEAT_MIN_SIZE=1`
   it becomes its own feature. ✅
7. With `gaps.json` present, each feature's `coverage.openGaps` equals the number of gaps whose
   `subject.factId` is a member; absent ⇒ `config.gapsProvided:false` and zeroed coverage. ✅
8. `_unassigned` is always emitted and always sorts last. ✅
9. Features sorted by `featureId`, members by `factId`; two runs byte-identical
   (`FEAT_LLM=0`). ✅
10. Missing `facts.json` exits non-zero with a clear message; empty `facts[]` exits 0 with only
    an empty `_unassigned`. ✅
11. Every emitted `Feature` validates against the §4 shape (required keys, `confidence ∈ [0,1]`,
    member arrays present). ✅
12. Running on the real `output/synthesized/facts.json` produces an `admin`, `tenants`, and
    `auth` feature (among others) with no crash, and endpoints distributed across features
    matching their `/api/<segment>/` prefixes. ✅ smoke test.
13. No import outside `context-layer/feature-extractor/**`; no read outside `output/`. ✅

---

## 9. Open Questions

- **API-segment depth vs semantics.** `apiSegmentDepth:1` groups `/api/admin/*` as one feature;
  some apps need depth 2 (`/api/admin/keys` vs `/api/admin/users`). Kept configurable; default 1.
- **Overlapping features.** v1 is a hard partition (one fact → one feature). Should a fact ever
  belong to multiple features (e.g. a shared "search" endpoint)? Deferred; would change the
  `members` contract to allow multi-membership.
- **LLM naming contract.** Which model, and a strict JSON schema for `{featureId → {name,
  summary}}` verdicts (mirror the synthesizer's fuzzy-matcher discipline). Deferred behind
  `FEAT_LLM`.
- **Synonym map scope.** The built-in map currently covers auth only. Grow it (admin, billing,
  reporting…) as more targets are seen, or learn it — deferred.
- **Cross-feature flows.** A user journey spanning features (login → dashboard → checkout) is a
  higher-order construct than a feature. Deferred to Component 5/6 (the store owns relations).
- **Feature stability across runs.** As the crawl surface grows, feature keys derived from paths
  are stable, but co-occurrence-placed facts may drift. Structural-first precedence (§5.1)
  minimizes this; a stability metric is deferred.
