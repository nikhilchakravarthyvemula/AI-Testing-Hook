# graph-viewer

Renders the indexer's per-topic graphs as **self-contained interactive
HTML** — open the file directly (`open click-graph.html`), no server,
no build step.

## What it produces

```
output/indexed_output/graphs/
├── click-graph.html        ← pages × intents × APIs (LLM-merged)
└── graphs-index.json       small registry of what was rendered
```

## What it renders

For each registered graph, emits an HTML page with:

* **vis-network** force-directed layout (CDN-loaded)
* **Search bar** — live-filter nodes by label / tooltip text
* **Click-to-inspect** side panel — shows every field of the selected node
* **Legend + stats** sidebar
* **Pause/fit** controls — physics freezes automatically once layout stabilises
* **Dark palette** by default; light browser themes still work via `color-scheme: light dark`

## Layout

```
context-layer/graph-viewer/
├── index.mjs                       entrypoint (runs all shapers)
├── lib/
│   ├── render-html.mjs             vis-network HTML template (graph-agnostic)
│   └── shapers/
│       └── click-graph.mjs         → output/indexed_output/click-graph.json
└── README.md
```

## Adding a new graph

1. Drop a shaper at `lib/shapers/<name>.mjs` that exports:
   ```js
   export const sourceFile = 'output/indexed_output/<source>.json';
   export const outputFile = '<name>.html';
   export const title      = 'Display title';
   export function shape(bundle) {
     return { nodes: [...], edges: [...], meta: { title, subtitle, counts, legend } };
   }
   ```
2. Register it in `index.mjs:SHAPERS`.

That's it — `render-html.mjs` is agnostic to which graph it's drawing.

## Run it

```bash
# manual
node context-layer/graph-viewer/index.mjs

# automatic — graph-viewer is wired into context-layer/scan.mjs as the
# stage after `indexer`, so a normal `testo scan` regenerates the HTMLs.
testo scan --url ... --codebase ...
```

## Open

```bash
open output/indexed_output/graphs/click-graph.html
```

The HTML is self-contained — copy it anywhere and it still works.
