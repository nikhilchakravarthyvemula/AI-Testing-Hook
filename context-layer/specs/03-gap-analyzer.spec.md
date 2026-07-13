# Component 3 — Gap-Analyzer · SPEC

**Status:** Draft v1.0 (for review) — transcribed 2026-07-13 from the HSBC as-built spec
**Depends on:** Component 2 (Knowledge-Synthesizer — `output/synthesized/facts.json`)
**Consumed by:** Component 4 (Feature-Extractor), Component 5 (Knowledge Base + Store), the
generators (which prioritize what to test), and the coverage report.

> This spec defines the **`Gap`** record — the harness's coverage-audit unit. Where a
> generator only tells you *what it can test*, the Gap-Analyzer tells you *what is missing,
> risky, or unverified*. This is the signature output of a **testing** harness.

---

## 1. Purpose & Non-Goals

**Purpose.** Diff the reconciled `CanonicalFact`s to surface **coverage holes** — places
where the evidence is one-sided, contradictory, or untested — and rank them so the
generators and humans work the highest-risk gaps first.

A `CanonicalFact` already tells us *how many independent source families agree* and *where
they disagree* (`provenance.families`, `conflicts[]`). The Gap-Analyzer turns that latent
signal into an explicit, prioritized worklist:

```
facts.json  ──▶  [ Gap-Analyzer ]  ──▶  gaps.json
(trustworthy facts)   detect + rank      (prioritized coverage holes)
```

**Why it exists.** On the current Pulse target, all 49 endpoint facts are **runtime-only**
(`corroborationCount:1`, confidence 0.95) and 18 facts carry unresolved `conflicts`. Nothing
today converts "runtime-observed but never declared in a spec" or "AST says auth-required,
runtime says not" into an actionable item. The generators therefore cannot prioritize, and
no one can answer *"what did we miss?"*.

**Non-Goals.**
- MUST NOT re-run extraction, crawling, or synthesis — it consumes only `facts.json`.
- MUST NOT merge, re-canonicalize, or mutate facts (that is Component 2).
- MUST NOT cluster gaps into features (that is Component 4).
- MUST NOT persist to a database or embed vectors (that is Component 5).
- MUST NOT call an LLM or the network. The Gap-Analyzer is **pure and deterministic**.
- SHOULD NOT invent gap types not derivable from the fact fields it is given.

---

## 2. Terminology

| Term | Definition |
|---|---|
| **CanonicalFact** | The synthesizer's output unit (Component 2 §4): one real entity with fused `confidence`, `provenance.families`, `conflicts[]`, and retained `observations`. Input unit here. |
| **Source family class** | `runtime` \| `code` \| `spec` \| `docs` — the evidence class recorded in `provenance.families[].class`. |
| **Gap** | One coverage hole: a `{type, subject, severity, priority, …}` record (§4). Output unit. |
| **Detector** | A pure function `facts → Gap[]` for one gap type (§5.1–5.4). |
| **Shadow endpoint** | An endpoint **observed at runtime but never declared** in a spec or code family — undocumented surface area. |
| **Conflict gap** | An attribute where ≥2 sources disagreed and the synthesizer surfaced it in `conflicts[]`. |
| **Low-trust fact** | A critical-kind fact resting on a single source family (`corroborationCount < 2`) or below a confidence floor — unverified by any independent evidence. |
| **Untested endpoint** | An endpoint fact with no linked test-coverage evidence (§5.2). |
| **Coverage input** | An optional set of already-tested endpoint keys used to suppress `untested` gaps (§3, §5.2). Absent ⇒ every endpoint is untested. |

---

## 3. Inputs

**Primary source.** `output/synthesized/facts.json` — the Component 2 envelope:
```jsonc
{
  "generatedAt": "<ISO8601>",
  "target": { "baseUrl": "https://…" },
  "sourceTopics": ["apis", "…"],
  "stats": { "canonicalFacts": 565, "conflicts": 63, /* … */ },
  "facts": [ /* CanonicalFact[] */ ]
}
```
Each consumed `CanonicalFact` MUST expose: `factId`, `kind`, `key`, `attributes`,
`confidence`, `provenance.families[].class`, `provenance.corroborationCount`, and
`conflicts[]` (per Component 2 §4).

**Optional coverage input.** `--coverage <path>` (or `output/coverage/covered-endpoints.json`
when present) — a JSON array of endpoint identity strings (`"<METHOD> <pathTemplate>"`) that
already have tests. Used only by the `untested` detector (§5.2). When absent, the detector
runs in **conservative mode**: every endpoint fact is reported untested, which is the truthful
state before any generation has happened.

**Preconditions.**
- Missing `facts.json` is a **hard error** (exit non-zero) — the synthesizer must run first.
- An empty `facts[]` array is tolerated (produces zero gaps, exit 0).
- Malformed facts (missing `kind`/`provenance`) are skipped with a counted warning, never fatal.

---

## 4. Outputs

**File:** `output/gaps/gaps.json` (single file).

**Envelope:**
```jsonc
{
  "generatedAt": "<ISO8601>",            // copied from facts.json for lineage
  "target": { "baseUrl": "…" },          // copied from facts.json
  "source": "output/synthesized/facts.json",
  "config": {                            // effective thresholds, for reproducibility
    "lowTrustConfidence": 0.9,
    "minCorroboration": 2,
    "lowTrustKinds": ["endpoint", "route", "model", "db-table"],
    "coverageProvided": false
  },
  "stats": {
    "factsAnalyzed": 565,
    "endpointsAnalyzed": 49,
    "totalGaps": 116,
    "byType": { "shadow-endpoint": 49, "untested-endpoint": 49, "conflict": 18, "low-trust": 49 },
    "bySeverity": { "high": 67, "medium": 49, "low": 0 }
  },
  "gaps": [ /* Gap[] — sorted by priority desc, then gapId asc */ ]
}
```

**`Gap` (THE contract — Components 4/5 and the generators depend on this shape):**
```jsonc
{
  "gapId": "shadow-endpoint::endpoint::GET::same-origin::/pulseviews/api/admin/config",
  "type": "shadow-endpoint",     // shadow-endpoint | untested-endpoint | conflict | low-trust
  "kind": "endpoint",            // kind of the subject fact
  "severity": "high",            // high | medium | low  (bucketed from priority, §5.5)
  "priority": 0.76,              // [0,1] deterministic ranking score (§5.5)
  "subject": {                   // enough to locate & act on the fact, without duplicating it
    "factId": "endpoint::GET::same-origin::/pulseviews/api/admin/config",
    "kind": "endpoint",
    "key": { "method": "GET", "originKey": "same-origin", "pathTemplate": "/pulseviews/api/admin/config" }
  },
  "title": "Undocumented endpoint: GET /pulseviews/api/admin/config",
  "detail": "Observed live (runtime) but absent from every spec and code source. No contract declares it.",
  "evidence": {                  // the fact signals that justified the gap (explainability)
    "confidence": 0.95,
    "corroborationCount": 1,
    "familyClasses": ["runtime"],
    "conflict": null             // populated only for type=conflict (§5.3)
  },
  "recommendation": "Add an OpenAPI/contract entry and a contract test; confirm intended auth."
}
```

**Field rules.**
- `gapId` MUST be deterministic and stable across runs for the same `(type, subject, detail-key)`.
  For `conflict` gaps it MUST include the conflicting attribute name so multiple conflicts on
  one fact yield distinct gaps.
- `priority` MUST be in `[0,1]`; `severity` MUST be derived from `priority` by fixed buckets (§5.5).
- `evidence.conflict` MUST be `null` for non-conflict gaps and the `{attribute, values, resolution}`
  triple for `conflict` gaps.
- A single fact MAY produce multiple gaps of different types (e.g. an endpoint can be both a
  shadow endpoint and untested). This is intentional — they are distinct remediations.

---

## 5. Behavior

The analyzer runs each detector independently over the fact set, concatenates the results,
prioritizes, and writes the envelope. Detectors are **pure** and **order-independent**.

### 5.1 Detector — `shadow-endpoint` (observed, undeclared)
- Scope: `kind === "endpoint"` only.
- Fires when `provenance.families` contains a **`runtime`** class **and no `spec` and no
  `code`** class. (Runtime surface with no contract/source backing it.)
- Rationale: undocumented endpoints are unmanaged attack/change surface; every one is a
  contract-test candidate. On the current target this fires for all 49 endpoints.
- Severity leans **high** and scales with `confidence` (a high-confidence undocumented
  endpoint is more certainly real).

### 5.2 Detector — `untested-endpoint`
- Scope: `kind === "endpoint"` only.
- Coverage set `C` = the optional coverage input (§3), keyed by `"<METHOD> <pathTemplate>"`.
- Fires when the endpoint's key is **not** in `C`. With no coverage input, `C = ∅` ⇒ every
  endpoint fires (truthful pre-generation state; `config.coverageProvided:false` records this).
- Rationale: this is the raw "what still needs a test" worklist that feeds the generators.
- Severity **medium** by default, raised when the same endpoint is also a shadow endpoint
  (untested **and** undocumented ranks above untested-but-documented).

### 5.3 Detector — `conflict`
- Scope: **all** kinds.
- Fires **once per conflicting attribute**: for every fact with non-empty `conflicts[]`, emit
  one gap per `conflicts[]` entry, embedding `{attribute, values, resolution}` in
  `evidence.conflict`.
- Rationale: a surfaced conflict (e.g. `authRequired: true` from AST vs `false` from runtime)
  is a correctness question a test must settle. `resolution:"unresolved"` outranks a resolved
  conflict.
- Severity leans **high** for `unresolved`, **medium** otherwise.

### 5.4 Detector — `low-trust` (single-source / low-confidence)
- Scope: **critical kinds only** — default `["endpoint", "route", "model", "db-table"]`
  (configurable, §6). Interactions/pages/redirects being single-source is expected and MUST
  NOT flood the report.
- Fires when a fact's `provenance.corroborationCount < GAP_MIN_CORROBORATION` **or**
  `confidence < GAP_LOW_TRUST_CONF`.
- Rationale: a critical fact resting on one family has no independent confirmation; a test (or
  a second extraction source) is what verifies it. <!-- ⚠ tail of this sentence was cut off in
  the photo (lines ~194–197) — verify against the HSBC file -->

### 5.5 Prioritization (normative)
- Each gap gets a deterministic `priority ∈ [0,1]`:
  `priority = clamp01( typeWeight[type] * (0.5 + 0.5 * confidence) )`
  with fixed base weights (initial, tunable):

  | type | weight |
  |---|---|
  | `shadow-endpoint` | 0.80 |
  | `conflict` | 0.70 |
  | `untested-endpoint` | 0.60 |
  | `low-trust` | 0.45 |

  Cross-signal bumps: `untested` **+0.15** when the endpoint is also shadow; `conflict`
  **+0.10** when `resolution === "unresolved"`. Result is re-clamped to `[0,1]`.
- Severity buckets: `priority ≥ 0.7 → high`, `≥ 0.4 → medium`, else `low`.
- Gaps MUST be sorted by `priority` **descending**, then `gapId` **ascending** (tie-break),
  so identical input yields byte-identical output.

### 5.6 Edge cases & errors
- **Empty `facts[]`:** zero gaps, exit 0.
- **Fact missing `provenance`/`kind`:** skip, increment `stats.skipped`, warn once.
- **Coverage file missing/malformed:** treat as no coverage (conservative), warn once, never fatal.
- **Unknown `kind` for a detector's scope:** simply not matched — not an error.

---

## 6. Interface

**CLI:** `node context-layer/gap-analyzer/analyze.mjs [--coverage <path>]`
Reads `output/synthesized/facts.json`, writes `output/gaps/gaps.json`.

**Pipeline position** (`context-layer/scan.mjs`): content-extractor → indexer →
knowledge-synthesizer → **gap-analyzer** → graph-viewer.

**Env:**
| Var | Default | Effect |
|---|---|---|
| `GAP_LOW_TRUST_CONF` | `0.9` | Confidence floor for the `low-trust` detector. |
| `GAP_MIN_CORROBORATION` | `2` | Min independent families before a critical fact is trusted. |
| `GAP_LOW_TRUST_KINDS` | `endpoint,route,model,db-table` | Kinds the `low-trust` detector scopes to. |
| `GAP_COVERAGE_FILE` | *(unset)* | Path to the coverage input; `--coverage` overrides. |

**Functions (module `analyze.mjs` + `lib/`):**
| Function | Signature | Description |
|---|---|---|
| `analyze(factsPath, opts)` | `(string, object) → Envelope` | Top-level: load → detect → prioritize → assemble. |
| `loadFacts(path)` | `(string) → {facts, target, generatedAt}` | Reads & validates the facts envelope. |
| `detectShadowEndpoints(facts)` | `(Fact[]) → Gap[]` | §5.1 |
| `detectUntestedEndpoints(facts, coverage)` | `(Fact[], Set) → Gap[]` | §5.2 |
| `detectConflicts(facts)` | `(Fact[]) → Gap[]` | §5.3 |
| `detectLowTrust(facts, cfg)` | `(Fact[], object) → Gap[]` | §5.4 |
| `prioritize(gaps)` | `(Gap[]) → Gap[]` | §5.5 scoring + deterministic sort. |

**Consumes:** only the `CanonicalFact` shape from Component 2. It MUST NOT import extractor,
indexer, or synthesizer internals — only the public `facts.json` file.

---

## 7. Invariants

- **Determinism:** identical `facts.json` (+ identical coverage + env) MUST produce
  byte-identical `gaps.json`. All arrays deterministically ordered (§5.5).
- **Idempotency:** running twice on unchanged inputs yields identical output.
- **Purity:** no network, no LLM, no mutation of `facts.json`.
- **Explainability:** every `Gap` MUST carry the `evidence` that justified it and a `subject`
  that locates the originating fact by `factId`.
- **Non-destructive multiplicity:** a fact may yield several gaps; the analyzer MUST NOT
  collapse distinct remediations into one.
- **Perf budget:** ≤ 1 s wall-clock for the current corpus (565 facts); linear in fact count.

---

## 8. Acceptance Criteria

1. An endpoint fact with only a `runtime` family produces exactly one `shadow-endpoint` gap;
   an endpoint that also has a `spec` family produces **none**. ✅ verifiable by fixture.
2. With no coverage input, every endpoint fact yields an `untested-endpoint` gap and
   `config.coverageProvided` is `false`; supplying that endpoint's key in `--coverage`
   suppresses its gap. ✅
3. A fact with two `conflicts[]` entries yields **two** `conflict` gaps with distinct `gapId`s,
   each embedding its `{attribute, values, resolution}`. ✅
4. A single-family endpoint fact (`corroborationCount:1`) yields a `low-trust` gap; a
   three-family fact above the confidence floor yields none. ✅
5. `low-trust` does **not** fire for `interaction`/`page`/`redirect` kinds under the default
   `GAP_LOW_TRUST_KINDS`. ✅
6. Gaps are sorted by `priority` desc then `gapId` asc; two runs are byte-identical. ✅
7. Missing `facts.json` exits non-zero with a clear message; empty `facts[]` exits 0 with
   zero gaps. ✅
8. Every emitted `Gap` validates against the §4 shape (all required keys, `priority ∈ [0,1]`,
   `severity` consistent with `priority`). ✅
9. Running on the real `output/synthesized/facts.json` produces `shadow-endpoint:49`,
   `untested-endpoint:49`, `low-trust:49`, and `conflict` = (number of conflict entries across
   the 18 conflicted facts), with no crash. ✅ smoke test.
10. No import outside `context-layer/gap-analyzer/**` and `knowledge-base/schema.mjs` (if any
    trust helper is reused); no read outside `output/`. ✅

---

## 9. Open Questions

- **Coverage source of truth.** Should `untested` cross-reference generated artifacts
  (`output/generation/api-tests/**`, `tests/API/**`) directly, or only a curated
  `covered-endpoints.json`? v1 uses the explicit file to stay pure; auto-derivation is deferred.
- **Spec-drift detector.** Deselected for v1 (no `spec` family in current data). Trivial to add
  later: `spec` family present, `runtime` absent.
- **Type weights & thresholds.** The §5.5 weights are initial guesses; expose them for tuning
  once real prioritization feedback exists.
- **Cross-kind gaps.** e.g. a `page` that triggers an undocumented endpoint. Deferred — needs
  Component 4's feature links.
- **Gap lifecycle / suppression.** Marking a gap "won't fix" / "accepted risk" and carrying that
  across runs — deferred to Component 5 (the store owns state).
