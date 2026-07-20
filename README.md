# Testing Harness

Project layout mirrors the **AI-Based Automated Testing Hook** architecture
diagram. Each top-level folder corresponds 1:1 to a box on the diagram.

## Folder ↔ diagram mapping

```
testing Harness/
│
├── testo/                      ▼ interactive REPL + shared packages
│   ├── repl.py                   Claude-CLI-style front door (/scan /generate /crawl …)
│   ├── harness/                  agentic_harness (OpenHarness tool-calling engine)
│   ├── skill-register/           skill registry + call_skill.py
│   └── model-api-connector/      pluggable LLM client (MiniMax)
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
│                                 test results → output/ (future: Postgres/graph/bucket
│                                 via storage skills — docs/spec-10)
│
├── output/                     runtime artifacts (gitignored)
└── tests/                      generated Playwright tests
```

## Build status

Tracked in `TODO.md` and per-folder READMEs.
