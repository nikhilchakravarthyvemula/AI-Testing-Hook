# Testing Harness

Project layout mirrors the **AI-Based Automated Testing Hook** architecture
diagram. Each top-level folder corresponds 1:1 to a box on the diagram.

## Folder ↔ diagram mapping

```
testing Harness/
│
├── scripts/                    ◄── existing working tools (UNCHANGED)
│   ├── crawler/                  Crawlee + Playwright crawler
│   └── graphify/                 LLM-enriched code knowledge graph
│
├── interfaces/                 ▼ Interfaces (blue box)
│   ├── cli/                      CLI entrypoint that orchestrates the pipeline
│   └── web-ui/                   deferred
│
├── knowledge-sources/          ▼ Knowledge Sources (orange row)
│   ├── live-links/               thin wrapper → calls scripts/crawler/
│   ├── codebase/                 wraps scripts/graphify/ + deterministic AST extractor
│   ├── openapi/                  HTTP probe for /openapi.json on the target
│   ├── git-repos/                git log/blame extractor
│   ├── jira-projects/            Jira REST API (optional, config-driven)
│   ├── confluence/               Confluence REST API (optional, config-driven)
│   ├── tribal-knowledge/         reads markdown notes folder
│   └── qa-bot/                   LLM-powered Q&A (deferred to LLM phase)
│
├── knowledge-base/             ▼ Knowledge Base (single source of truth)
│
├── context-layer/              ▼ Context Layer (purple)
│   ├── content-extractor/        the orchestrator — wraps source extractors
│   ├── gap-analyzer/             spec vs observed diff, missing-coverage detection
│   ├── knowledge-synthesizer/    multi-source fact reconciliation
│   ├── feature-extractor/        clusters endpoints + pages into features
│   └── mind-map-builder/         Mermaid + interactive HTML graphs
│
├── generation-layer/           ▼ Generation Layer (pink)
│   ├── test-plan-creator/        builds explicit test-plan.json
│   ├── test-script-generator/    emits Playwright .spec.mjs files
│   ├── mock-data-creator/        field-type defaults + config overrides
│   └── validator/                ESLint + parse-check + diff vs previous
│
├── execution-layer/            ▼ Execution Layer (green)
│   ├── test-executor/            wraps `playwright test`
│   └── report-generator/         unified HTML dashboard
│
├── feedback/                   ▼ feedback arrow
│                                 test results → knowledge.json
│
├── infrastructure/             ▼ Cross-Cutting (cyan row)
│   ├── model-api-connector/      pluggable LLM client (scaffold; no LLM yet)
│   ├── agentic-harness/          OpenHarness wrapper (scaffold)
│   ├── skill-register/           skills.json registry
│   ├── postgresql/               deferred
│   └── container-deploy/         deferred
│
├── output/                     runtime artifacts (gitignored)
└── tests/                      generated Playwright tests
```

## Build status

Tracked in `TODO.md` and per-folder READMEs.
