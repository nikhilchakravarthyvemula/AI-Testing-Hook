# P0-03 — Per-Run Knowledge Store · SPEC

**Status:** Draft v1.0 (for review)
**Depends on:** existing context pipeline outputs (synthesizer `facts.json`,
gap-analyzer `gaps.json`, feature-extractor `features.json`), p0-02a (S2)
**Consumed by:** p0-04 (context-server), p0-05 (plan creator), p0-08 (report)
**Supersedes:** the Postgres+pgvector direction of component 5 in
`context-layer/specs/CONTEXT-LAYER-COMPONENTS.md` — blank-slate runs need no
database and no embeddings.

> Component 5-lite. One queryable JSON store per run: reconciled facts +
> features + gaps + provenance, merged and indexed, written once during the
> `store` stage, read-only ever after. This is the single source everything
> downstream (MCP server, plan creator, report) queries.

---

## 1. Purpose & Non-Goals

**Purpose.** `build.mjs` merges the understand-stage outputs into
`store/knowledge.json` with lookup indexes, and `store.mjs` (a query library)
gives Node consumers typed accessors so nobody re-parses raw stage outputs.

**Non-Goals.**
- MUST NOT persist beyond the run workspace or read any previous run.
- MUST NOT use a database, embeddings, or vector search (superseded — see
  header). The MCP interface (p0-04) is where a storage upgrade would slot in
  later without touching consumers.
- MUST NOT re-run synthesis/gap/feature logic — it merges their outputs.
- MUST NOT mutate facts, except the one defined enrichment below (S2 merges).

## 2. The one LLM touchpoint: S2 residue match

The synthesizer's deterministic canonicalize+block leaves a residue of
ambiguous near-duplicate pairs (it already surfaces conflicts/families).
During `build`, for each residue pair, one `complete({useCase: "S2", schema:
{same: boolean, confidence}})` call via the connector decides merge/keep.

- Volume guard: if residue pairs exceed `S2_MAX_PAIRS` (default 50), take the
  top pairs by confidence-impact and ledger a note — a bigger residue means
  blocking is broken; fix that, don't buy more calls.
- Degraded (`ok: false`): pairs stay unmerged; each affected fact gets
  `"s2": "skipped"` in its provenance; one `markDegraded()` entry.
- Merged pairs record both observations (explainability, per component-2
  conventions).

## 3. Output — `store/knowledge.json`

```jsonc
{
  "runId": "…", "builtAt": "<ISO8601>",
  "target": { "url": "…", "profile": "url-only|url+code" },
  "facts":    [ /* CanonicalFact[], post-S2 */ ],
  "features": [ /* feature clusters, from feature-extractor */ ],
  "gaps":     [ /* Gap[], from gap-analyzer */ ],
  "indexes": {
    "factsByKey":     { "GET /api/v2/cart": "fact:…" },
    "factsByFeature": { "feat:checkout": ["fact:…"] },
    "gapsByFeature":  { "feat:checkout": ["gap:…"] },
    "pagesByFeature": { "feat:checkout": ["/cart", "/checkout"] }
  },
  "stats": { "facts": 0, "features": 0, "gaps": 0, "s2Merges": 0, "s2Skipped": 0 }
}
```

`store.mjs` exposes: `load(workspace)`, `getFeature(idOrName)`,
`queryEndpoints(filter)`, `listGaps({featureId?, severity?})`,
`featureContext(featureId)` — the last returns the exact composite the MCP
tool and plan creator both serve (feature + its facts + gaps + pages, ranked
by confidence).

## 4. Acceptance

1. Build against an existing logtrim `output/` snapshot: store validates
   against §3, every fact reachable through at least one index.
2. With `ENGINE_PROVIDER=mock` (no fixtures): store still builds; stats show
   `s2Skipped > 0`; degradation recorded.
3. `featureContext()` returns identical data through `store.mjs` and through
   the p0-04 MCP tool (shared implementation, proven by test).
4. Runtime: full build < 5s on the logtrim-sized dataset (it's a merge, not
   a computation).
