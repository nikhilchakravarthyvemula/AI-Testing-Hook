# P0-03 — Per-Run Knowledge Store · SPEC

**Status:** v1.1 — **IMPLEMENTED 2026-07-19** (`context-layer/knowledge-store/`:
`build.mjs`, `store.mjs`, `lib/{load,residue,s2,indexes}.mjs`; wired as the
spine's `store` stage). `npm run test:store` — 31 tests. Acceptance verified on
the real 405-fact logtrim snapshot, including a live S2 run. See §5.
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

**Spec-vs-reality correction (found while implementing):** the draft assumed the
synthesizer *emits* the residue. It does not — `facts.json` has no candidate-pair
list and `stats.llmMatchCalls` is 0. So **C3 computes the residue itself**
(`lib/residue.mjs`) and then S2-matches it. This is squarely within the
"S2 enrichment" the Non-Goals allow; it is not re-running synthesis.

**The blocking rule (`residue.mjs`).** Exact-key canonicalization already merged
`/users/{id}` ≡ `/users/:id`. What it can't merge is a **concrete observation
against a templated one** — the live crawl hit
`/agent/get-agent-by-name/Resume%20Analysis` while the spec declares
`/agent/get-agent-by-name/{id}`. The rule pairs two endpoint facts (same method +
origin + segment count) only when one is a strict **instance-of** the other:
every literal segment matches and the paths differ only where the template has a
parameter and the other has a concrete value. Directional, so `/a/{id}` and
`/{x}/b` never pair.

**Why S2 is an LLM gate, not an auto-merge (validated on real data).** On the
405-fact logtrim snapshot the rule surfaced exactly 2 candidates — and one was a
false positive: `/organization/dashboard-stats` vs `/organization/{id}`
(`dashboard-stats` is a named route, not an id value). The rule is deliberately
high-recall / moderate-precision; **S2 is the precision filter.** The live run
confirmed the design: it merged the true pair (`Resume%20Analysis` → `{id}`,
conf 0.9) and rejected the false one, in 2 calls. Never merge on the blocking
rule alone.

Per candidate pair, one `complete({useCase:"S2", schema:{same, confidence}})`;
merge only when `same && confidence ≥ S2_MERGE_MIN_CONFIDENCE` (default 0.7).

- **Volume guard:** pairs are ranked by corroboration impact (concrete side with
  the fewest sources gains most from merging) and capped at `S2_MAX_PAIRS`
  (default 50); the dropped count is reported in a note. On real data the count
  was 2 — a residue near the cap would signal the blocking rule needs tightening.
- **Degraded (`ok:false`):** the engine is down or the budget is spent → stop,
  leave the pairs unmerged, tag each affected fact `provenance.s2 = "skipped"`,
  and return one degradation the spine records via `markDegraded()`. The store
  still builds.
- **Merged pairs** keep both observations, combine confidence via the shared
  `combineConfidence` (noisy-OR), bump `corroborationCount`, and record
  `provenance.s2 = { merged:[…], method:"llm-match", confidence }`. A `remap`
  ({merged-away id → survivor id}) rewrites every index reference so nothing
  points at a fact that no longer exists.

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

1. ✅ Build against the real logtrim `output/` snapshot (405 facts, 21 features,
   281 gaps): store validates against §3, **0 orphans** — every fact reachable
   through `factsByKey` or `factsByFeature`.
2. ✅ `provider: mock`, no fixtures, with a real residue: store still builds,
   `s2Skipped ≥ 1`, both facts tagged `s2:"skipped"`, one degradation recorded.
   (`build.test.mjs`.)
3. ✅ `featureContext()` is one implementation shared by the pure function and
   the `openStore()` binding — `store.test.mjs` asserts they're `deepEqual`, so
   the C4 MCP tool (which calls the pure function) returns identical data.
4. ✅ Runtime **18ms** on the logtrim dataset (target < 5s) — it's a merge.

Plus a live S2 run (§2): on real data, merged the true near-duplicate and
rejected the false candidate in 2 engine calls.

## 5. Implementation notes / deviations

- **Reads only `<workspace>/context/`** (the spine's post-understand snapshot),
  never live `output/` or a prior run — the blank-slate guarantee.
- **`store.mjs` accessors are pure functions of `(store, args)`**, with
  `openStore(workspace)` as the load-and-bind convenience. This is what lets C4
  serve `featureContext` without a second implementation.
- **`resolveResidue` takes an injectable `completeFn`** (defaults to the real
  connector) so the S2 merge/keep/degrade/cap logic is unit-tested
  deterministically without an engine (`lib/s2.test.mjs`).
- **S2 covers endpoints only** in P0 — pages rarely have concrete-vs-template
  ambiguity. Extend `residue.mjs` if that changes.
- **Output stats** carry `s2Candidates` alongside `s2Merges`/`s2Skipped`, so the
  report can show "N proposed, M merged" — the blocking rule's recall is visible.

## 6. Open question

**OQ — should S2 residue detection also run cross-origin / on near-miss
literals?** Today the rule is strict (same method+origin, instance-of only). It
won't catch a typo'd literal (`/agent/{id}/field` vs `/agent/{id}/fields`) or the
same endpoint seen under two origins. Those are real dedup cases but lower-signal
and higher false-positive risk, so they're deferred. Revisit only if a target
app shows material duplication the strict rule misses — the `s2Candidates` stat
is the signal to watch.
