# Context Layer

The processing brain above Knowledge Sources. Sub-components:

| Component | Role | Status |
|---|---|---|
| `content-extractor/` | **The wrapper.** Orchestrates all source extractors (live-links/crawler, codebase/graphify, codebase/deterministic-AST, openapi, git, jira, confluence, tribal). One pipeline step → many sources extracted → many source JSONs produced. | 🚧 building |
| `gap-analyzer/` | Compares sources to surface test-coverage gaps (spec endpoint not observed, observed but undocumented, etc.) | planned |
| `knowledge-synthesizer/` | When the same fact appears in multiple sources, picks the highest-confidence one and records all observations | planned |
| `feature-extractor/` | Groups endpoints + pages into features by URL prefix + co-occurrence | planned |
| `mind-map-builder/` | Mermaid + interactive HTML graphs (mindmap.md, graph.html, endpoint-graph.html) | planned |

## Content Extractor (the main wrapper)

Each source lives in its own sibling folder under
`context-layer/content-extractor/<source-id>/`, with an `extract.mjs`
(Node) or `extract.py` (Python) entrypoint. `run.mjs` auto-discovers
them.

```
context-layer/content-extractor/
├── _lib/                       shared library — testing-agent extractor port + venv
├── run.mjs                     orchestrator (auto-discovery)
│
├── crawler/                    wraps scripts/crawler  (live-app discovery)
├── graphify/                   wraps scripts/graphify (LLM-enriched code graph)
├── python-ast/                 hand-rolled FastAPI/Flask AST extractor
│
├── python-fastapi/             ╮
├── python-flask/               │
├── python-django/              │
├── java-spring/                │  ported from testing-agent
├── java-jaxrs/                 │  (6 backend extractors)
├── csharp-aspnet/              ╯
│
├── nextjs-app/                 ╮
├── nextjs-pages/               │
├── react-router/               │
├── vue-router/                 │
├── angular-router/             │
├── sveltekit/                  │  ported from testing-agent
├── nuxt/                       │  (13 frontend extractors)
├── remix/                      │
├── ember/                      │
├── qwik/                       │
├── astro/                      │
├── preact-router/              │
├── solidstart/                 ╯
│
├── openapi-file/               ╮  spec parsers
├── markdown-apispec/           ╯
│
├── conventions/                ╮
├── csproj/                     │  per-language manifest facts
├── package-json/               │  (npm, maven, pip, .NET)
├── pom-xml/                    │
└── pyproject/                  ╯
```

Each per-source folder writes its own bundle to
`output/sources/<source-id>.json` with provenance. The orchestrator
writes a top-level summary at `output/content-extraction-index.json`.

### Run

```bash
# everything (skips python sources without TARGET_CODEBASE set)
npm run extract

# just the codebase extractors (skip the slow live crawler)
TARGET_CODEBASE=/abs/path/to/repo npm run extract:code

# a single source
TARGET_CODEBASE=/abs/path/to/repo ONLY=python-fastapi npm run extract
```
