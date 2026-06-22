# Module 1 — Knowledge-Graph Analytics & Text-Triple Extraction

_Borrowed from: "kg-gen + NetworkX Analytics + Interactive Visualizations." Target layer: **Context Layer**._

## Goal

Two distinct capabilities, deliberately separated:

1. **Graph analytics over the graphs you already build** — deterministic, free, no LLM. Load `click-graph.json` into NetworkX, compute centrality / communities / orphans, and use the results to (a) prioritize test generation by risk, (b) auto-cluster features, (c) surface coverage gaps, (d) size/color the existing interactive viz. This fills the four empty Context Layer dirs.
2. **LLM triple extraction for unstructured text** (`kg-gen`) — only for sources you have *no* extractor for today (tribal markdown, Jira ACs, Confluence). Emits `(subject, predicate, object)` triples that merge into the same graph at a low confidence tier.

The split matters: you do **not** need kg-gen for code or crawl data — you already have richer deterministic graphs there (`graphify`, the crawler). kg-gen earns its keep only on prose.

## Current state (verified against the repo)

- `output/indexed_output/click-graph.json` is a single-item envelope; the graph lives at `items[0].primary = { nodes, edges, summary }`.
  - `nodes` = `{ pages[], routes[], intents[], forms[], apis[] }`. IDs are strings: `page:<url>`, `intent:<category>:<name>`, `api:<METHOD>:<path>`, `route:<fw>:<pattern>`, `form:<pageUrl>#<idx>`.
  - `edges` = flat `[{ from, to, relation, ...}]`. Populated relations today: `contains` (page→intent), `navigates_to` (intent→page, page→page), `triggers` (page→api, from live capture). Defined-but-empty: `invokes` (intent→api, LLM-predicted), `submits_to` (form→api), `realizes` (route→page).
  - `summary` (current run): `pages:119, intents:247, apis:16, edges:726, visitedPages:10, unvisitedPages:109, apisWithCallers:15`.
- Visualization seam: `context-layer/graph-viewer/index.mjs` loops `SHAPERS = [clickGraphShaper, uiRoutesShaper]`; each shaper exports `sourceFile`, `outputFile`, and `shape(bundle) → { nodes, edges, meta }`; `lib/render-html.mjs#renderToFile({ nodes, edges, meta, outputPath })` writes a self-contained vis-network HTML. Node objects accept `size`, `color`, `group`, `_raw`.
- Pipeline orchestrator: `context-layer/scan.mjs` runs `STAGES` serially via `execFileSync('node', [entrypoint])`. Current stages: `content-extractor`, `indexer`, `graph-viewer`. `gap-analyzer` and `mind-map-builder` are present but **commented out**.
- `context-layer/indexer/index.mjs` builds 12 topic files from source bundles using `lib/models.mjs` (`observation()`, `indexedItem()`, `computeConsensus()`, `TIER_CONFIDENCE`).
- `knowledge-base/` has **only** `schema.mjs` — `build.mjs`/`store.mjs` do not exist. `schema.mjs` exports `DiscoveryTier`, `confidenceForTier(tier)`, `provenance({...})`, `combineConfidence(a,b)`. `graph_extracted → 0.65`, `docs_extracted → 0.55`.
- **No graph library installed anywhere** (no networkx, kg-gen, or graphology). Python venvs exist: `scripts/graphify/.venv` (py3.14, has openai/anthropic/openharness) and `context-layer/content-extractor/_lib/.venv` (py3.14). Neither has networkx.
- `context-layer/{feature-extractor,gap-analyzer,knowledge-synthesizer,mind-map-builder}` are all **empty dirs**.

## Architecture

Insert one analytics stage after the indexer, then let the four (currently empty) Context Layer components consume its output. The existing graph-viewer reads the analytics to style nodes.

```
content-extractor → indexer → [NEW] graph-analytics → feature-extractor → gap-analyzer → mind-map-builder → graph-viewer
                                      │                      │                  │              │                 │
                                      ▼                      ▼                  ▼              ▼                 ▼
                          graph-analytics.json         features.json       gaps.json    *.graphml / *.mmd   *.html (sized/colored)
```

A separate, optional text extractor sits at the content-extractor layer (not in the analytics path):

```
text sources (md / jira / confluence) → content-extractor/text-kg/extract.py (kg-gen) → output/sources/text-kg.json → indexer (merged into click-graph topic, tier=docs_extracted)
```

**Language decision:** implement analytics in **Python with NetworkX** (faithful to the article; `louvain_communities`, `pagerank`, `betweenness_centrality` are all built-in in `networkx>=3.1`). Keep `scan.mjs` uniform by giving the stage a thin Node `run.mjs` that shells into a venv Python — exactly the pattern `npm run code-ast` already uses (`_lib/.venv/bin/python … extract.py`). A pure-Node alternative (`graphology` + `graphology-metrics` + `graphology-communities-louvain`) is viable if you want zero Python in this layer; noted at the end.

## New files (file-by-file plan)

| Path | Lang | Role |
|---|---|---|
| `context-layer/graph-analytics/analyze.py` | py | Load graph(s) → NetworkX → centrality, communities, predicate freq, orphans → write `graph-analytics.json` |
| `context-layer/graph-analytics/run.mjs` | node | Stage entrypoint: locate venv, spawn `analyze.py`, validate output shape |
| `context-layer/graph-analytics/requirements.txt` | — | `networkx>=3.1`, `scipy`, `numpy` |
| `context-layer/graph-analytics/README.md` | md | Usage + schema |
| `context-layer/feature-extractor/extract-features.mjs` | node | Communities + node metadata → `features.json` (feature clusters) |
| `context-layer/gap-analyzer/analyze-gaps.mjs` | node | Cross-topic set diffs + analytics orphans → `gaps.json` |
| `context-layer/mind-map-builder/build.mjs` | node | Export GraphML (Gephi/Cytoscape) + per-feature scenario tree (Mermaid) |
| `context-layer/content-extractor/text-kg/extract.py` | py | kg-gen over text → triples → `output/sources/text-kg.json` (auto-discovered) |

**Edited files:**

| Path | Change |
|---|---|
| `context-layer/scan.mjs` | Add `graph-analytics` stage after `indexer`; enable `feature-extractor`, `gap-analyzer`, `mind-map-builder` stages |
| `context-layer/graph-viewer/lib/shapers/click-graph.mjs` | Read `graph-analytics.json`; set node `size` from PageRank, `color`/`group` from community; add legend entries |
| `context-layer/indexer/topics/click-graph.mjs` | Merge `text-kg` triples as `invokes`/`contains` edges with provenance tier `docs_extracted` |
| `context-layer/content-extractor/_lib/.venv` (or new venv) | `pip install networkx scipy numpy` (and `kg-gen` if text extraction enabled) |

## Data shapes

`output/indexed_output/graph-analytics.json`:

```json
{
  "topic": "graph-analytics",
  "generatedAt": "ISO",
  "target": { "baseUrl": "..." },
  "graph": { "nodes": 392, "edges": 726, "directed": true, "components": 3 },
  "nodes": {
    "api:GET:/api/features/sdk-gIwyr3jR5GjHi6HA": {
      "kind": "api",
      "degree": 0.027, "in": 10, "out": 0,
      "pagerank": 0.0184,
      "betweenness": 0.0,
      "community": 2,
      "orphan": false,
      "priority": 0.91
    }
  },
  "communities": [
    { "id": 0, "label": "Insights", "size": 34, "members": ["page:...", "api:...", "intent:..."] }
  ],
  "predicateFrequency": { "contains": 540, "triggers": 132, "navigates_to": 54 },
  "orphans": {
    "apisNoCaller": ["api:GET:/api/health"],
    "pagesUnvisited": ["page:https://.../settings"],
    "intentsNoApi": ["intent:mutation:save-draft"]
  },
  "ranking": [ { "id": "api:GET:/v2/endpoints", "priority": 0.97 } ]
}
```

`priority` = normalized blend (e.g. `0.6*pagerank_norm + 0.4*betweenness_norm`) — the single number Generation sorts by.

`output/indexed_output/features.json`:

```json
{ "topic": "features", "features": [
  { "id": "feat-insights", "label": "Insights", "community": 0,
    "pages": ["page:.../insights"], "apis": ["api:GET:/v2/endpoints"],
    "intents": ["intent:navigation:open-insights"], "centralityRank": 1 }
] }
```

`output/indexed_output/gaps.json`:

```json
{ "topic": "gaps", "gaps": [
  { "type": "observed_not_specced", "api": "api:GET:/api/features/sdk-...", "severity": "medium",
    "detail": "Seen live (43 samples) but absent from openapi.json" },
  { "type": "orphan_api",        "api": "api:GET:/api/health", "severity": "low" },
  { "type": "unvisited_page",    "page": "page:.../settings", "severity": "high" },
  { "type": "intent_without_api","intent": "intent:mutation:save-draft", "severity": "medium" }
] }
```

Gap types (computed from existing topic files): `spec_not_observed` (openapi path with no live `triggers`), `observed_not_specced` (live api not in `openapi.json`), `orphan_api` (`callerCount==0`), `unvisited_page` (`visited==false`), `intent_without_api` (intent node with no outgoing `invokes`/`triggers`), `unreachable_page` (no path from root in undirected graph).

text-kg triples map onto the graph as: each entity → a node (kind inferred or `concept`), each relation → an edge with `relation:"invokes"|"contains"|"relates_to"` and `provenance` block `{ tier:"docs_extracted", confidence:0.55, sourceId:"text-kg", sourceFile }`.

## Code sketches

`analyze.py` (core, ~70 lines):

```python
import json, sys, pathlib
import networkx as nx
from networkx.algorithms.community import louvain_communities

IN  = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "output/indexed_output/click-graph.json")
OUT = pathlib.Path("output/indexed_output/graph-analytics.json")

prim = json.loads(IN.read_text())["items"][0]["primary"]
G = nx.DiGraph()
for kind, arr in prim["nodes"].items():
    for n in arr:
        G.add_node(n["id"], kind=kind[:-1], **{k: v for k, v in n.items() if k != "id"})
for e in prim["edges"]:
    if e["from"] in G and e["to"] in G:
        G.add_edge(e["from"], e["to"], relation=e.get("relation"))

H = G.to_undirected()
pr  = nx.pagerank(G) if G.number_of_edges() else {}
btw = nx.betweenness_centrality(H)
deg = nx.degree_centrality(H)
comms = louvain_communities(H, seed=42) if H.number_of_edges() else []
node_comm = {n: i for i, c in enumerate(comms) for n in c}

def norm(d):
    if not d: return d
    lo, hi = min(d.values()), max(d.values())
    return {k: (v - lo) / (hi - lo) if hi > lo else 0.0 for k, v in d.items()}
prn, btn = norm(pr), norm(btw)

nodes = {}
for n in G.nodes:
    nodes[n] = {
        "kind": G.nodes[n].get("kind"),
        "degree": round(deg.get(n, 0), 4),
        "in": G.in_degree(n), "out": G.out_degree(n),
        "pagerank": round(pr.get(n, 0), 5),
        "betweenness": round(btw.get(n, 0), 5),
        "community": node_comm.get(n),
        "orphan": G.in_degree(n) == 0 and G.out_degree(n) == 0,
        "priority": round(0.6 * prn.get(n, 0) + 0.4 * btn.get(n, 0), 4),
    }
# predicate freq, orphans, ranking, communities labels … then write OUT
```

`run.mjs` (stage entrypoint):

```js
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
const VENV = ['context-layer/graph-analytics/.venv/bin/python',
              'context-layer/content-extractor/_lib/.venv/bin/python'].find(existsSync);
execFileSync(VENV, ['context-layer/graph-analytics/analyze.py'], { stdio: 'inherit' });
// then JSON.parse(output/indexed_output/graph-analytics.json) and assert keys exist
```

`click-graph.mjs` shaper edit (inside the existing `shape()`):

```js
import { readFileSync, existsSync } from 'node:fs';
const A = existsSync('output/indexed_output/graph-analytics.json')
  ? JSON.parse(readFileSync('output/indexed_output/graph-analytics.json')).nodes : {};
// when building each vis node:
const m = A[node.id];
visNode.size  = 12 + Math.round((m?.pagerank ?? 0) * 600);   // PageRank → size
visNode.group = m?.community ?? 'none';                        // community → color
visNode.title += m ? `\nPageRank ${m.pagerank} · community ${m.community}` : '';
```

`extract-features.mjs`: read `graph-analytics.json`; for each community, collect member node ids by kind, label the community by the most central page's `section`, rank by max member `priority`; write `features.json`.

`gap-analyzer/analyze-gaps.mjs`: load `apis.json`, `pages.json`, `openapi.json`, `graph-analytics.json`; emit the gap records above via set differences and the precomputed `orphans` block.

`text-kg/extract.py` (kg-gen):

```python
from kg_gen import KGGen
kg = KGGen(model=os.environ.get("TEXT_KG_MODEL", "gpt-4.1-mini"))
g = kg.generate(input_data=text, context="web app behavior & QA notes")
g = kg.cluster(g)                       # merges synonymous entities/relations
# map g.entities → nodes, g.relations (s,p,o) → edges with provenance(tier=docs_extracted)
```

## Integration points

- **scan.mjs** — new `STAGES` order: `content-extractor, indexer, graph-analytics, feature-extractor, gap-analyzer, mind-map-builder, graph-viewer`.
- **Generation (the payoff)** — `api-test-generator` currently caps with `max_tests` but has no ordering. Add an arg `priority_source: Path = output/indexed_output/graph-analytics.json` and sort `api_items` by `ranking` before applying `max_tests`, so a capped run tests the *highest-risk* endpoints first. The future `test-plan-creator` consumes `features.json` + `gaps.json` to scope suites.
- **Knowledge tiers** — analytics-derived facts are recorded via `provenance({ tier: 'graph_extracted', ... })` (0.65); text-kg facts via `docs_extracted` (0.55). Never let either overwrite `live_observed` (0.95) — use `combineConfidence`/`computeConsensus` exactly as the indexer already does.
- **graph-viewer** — no API change; the shaper just reads one more file. The new `mind-map-builder` GraphML is complementary (Gephi/Cytoscape), not a replacement for the HTML viewer.

## Dependencies & config

- Add `networkx>=3.1`, `scipy`, `numpy` to a venv (`pagerank` needs scipy; Louvain is built-in, so the article's `python-louvain` fallback is unnecessary). All BSD-licensed.
- `kg-gen` only if text extraction is enabled — **verify its license** before vendoring; gate the extractor behind an env var.
- Env: `GRAPH_ANALYTICS_INPUT` (default `click-graph.json`), `TEXT_KG_SOURCE` (markdown dir; absent → extractor skipped), `TEXT_KG_MODEL`, `BETWEENNESS_MAX_NODES` (above which use `betweenness_centrality(k=…)` sampling).

## Acceptance tests

1. `analyze.py` on the current `click-graph.json` writes `graph-analytics.json` where every node has a `pagerank`, `pagerank` sums to ≈1.0 over reachable nodes, ≥1 community is detected, and `orphans.apisNoCaller` is non-empty given `apisWithCallers:15 < apis:16`.
2. Re-running is deterministic (Louvain `seed=42`; PageRank stable).
3. `features.json` produces clusters whose labels line up with crawl sections (Insights / Sessions / Graph …).
4. `gaps.json` flags the 109 `unvisited_page`s and any `observed_not_specced` api (the `sdk-…` feature endpoints are live but unlikely to be in `openapi.json`).
5. `click-graph.html` opens with nodes visibly sized by PageRank and colored by community; legend lists communities.
6. With `TEXT_KG_SOURCE` pointed at a 1-page markdown note, `text-kg.json` contains ≥1 triple at tier `docs_extracted`, and the merged graph gains those edges without changing any `live_observed` fact.
7. `api-test-generator --max_tests 5` tests the 5 highest-`priority` endpoints (assert the selected `opId`s match the top of `ranking`).

## Phasing

- **P0a** — `analyze.py` + `run.mjs` + scan stage. (Analytics over the graph you already have. ~1–2 days.)
- **P0b** — graph-viewer styling + `feature-extractor` + `gap-analyzer`. (Fills 2 empty dirs; visible value. ~2–3 days.)
- **P1** — `mind-map-builder` (GraphML + Mermaid) and wire `priority` into `api-test-generator`.
- **P1** — `text-kg` extractor (kg-gen) for tribal/Jira/Confluence.

## Risks / watch-outs

- Directed PageRank with sink nodes (APIs have out-degree 0) — `nx.pagerank` handles dangling nodes via teleport; fine. Betweenness is O(V·E); at ≤500 nodes it's instant, but guard large graphs with `k`-sampling.
- kg-gen is nondeterministic and costs tokens — cache by source content hash, keep tier low, and never overwrite deterministic facts.
- The `knowledge-synthesizer` dir is intentionally **not** addressed here beyond text-kg's `kg.cluster()` synonym-merge; full cross-source entity canonicalization (e.g. `/features/sdk-XXXX` → `/features/{id}` templating) is a sibling task — flagged in Module spec cross-references.
- Python-in-Node stage: `run.mjs` must fail loudly if no venv is found (mirror the honesty rule the agentic-harness already enforces).
