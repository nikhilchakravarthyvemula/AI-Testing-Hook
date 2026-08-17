# AI Testing Hook — BYO-LLM monorepo

An architecture-shaped testing hook: point it at a live web app (plus,
optionally, its codebase) and it crawls, extracts, indexes, generates API
tests, and executes them — with **the host model doing all LLM reasoning**.

**LLM strategy: BYO-LLM.** There are **no API keys in this repo** and no
internal LLM orchestration. The reasoning steps (click-intent classification)
run on whatever model the developer already has — VS Code Copilot via the MCP
server's sampling bridge, or Claude Code via the `/ctx` skill. Everything else
in the pipeline is deterministic.

## Front doors

| Surface | Where | How the LLM connects |
|---|---|---|
| **MCP server** (`ai-hook`) | `mcp-server/` — tools `test_app` (narrated end-to-end run), `scan`, `generate`, `execute`, `context` | MCP **sampling**: the crawler's own LLM calls route through a loopback bridge → `create_message` → the host model |
| **Claude Code skill** (`/ctx`) | `.claude/skills/testo-context/` over `byo-llm-poc/ctx.mjs` | The host classifies clickables itself and writes them back (`annotate-intents`) |

## Folder map

```
├── mcp-server/                 ▼ the MCP front door (FastMCP + sampling bridge)
│   ├── ai_hook_mcp/              server.py (5 tools) · bridge.py · milestones.py (narration)
│   └── docs/ARCHITECTURE.md      how the inversion works, hop by hop
│
├── byo-llm-poc/                ▼ the skill front door (deterministic CLI)
│   └── ctx.mjs                   scan / annotate-intents / context / generate / execute
│
├── testo/                      ▼ shared runtimes
│   ├── skill-register/           skill registry + call_skill.py (--json result marker)
│   └── model-api-connector/      getClient('host') — the single LLM seam (no keys)
│
├── context-layer/              ▼ Context Layer
│   ├── content-extractor/        orchestrator (run.mjs) — crawler, graphify (direct,
│   │                             deterministic), framework-detector, code-extractors
│   └── indexer/                  merges source bundles → output/indexed_output/ topics
│
├── generation-layer/           ▼ Generation Layer
│   ├── api-test-generator/       deterministic curl-test builder + runner (skill)
│   ├── perf-test-generator/      perf scripts
│   ├── feature-slice/            feature manifest + tagging + PDF report (report-pdf.mjs)
│   └── allure-reporter/          Allure reporting
│       (UI specs: testo/src/crawler/generator/e2e.mjs via `ctx generate`)
│
├── execution-layer/            ▼ Execution Layer (report-generator stub)
├── feedback/                   ▼ feedback arrow (future: storage skills — docs/spec-10)
├── docs/                       spec-04 … spec-14 (design history; spec-13/14 = this shape)
└── output/                     runtime artifacts (gitignored)
```

## Quick start (VS Code Copilot)

1. Open this folder in VS Code — `.vscode/mcp.json` registers the `ai-hook` server.
2. Copilot Chat → Agent mode → ask: *"test my app at http://localhost:3000,
   codebase /path/to/repo"* → the `test_app` tool runs the narrated loop:
   scanner → crawler (LLM calls sampled to Copilot) → graphify → indexer →
   generator → executor → summary.
3. First sampling call prompts for approval (Copilot Business/Enterprise needs
   the MCP policy enabled by an admin).

Retired in the BYO-LLM migration (spec-13): the internal agentic harness +
REPL (`testo/harness`, `testo/repl.py`), the MiniMax provider, and every
`MINIMAX_*` / `LLM_FRAMEWORK_DETECTION` / `DBSCHEMA_LLM` env knob.

## Build status

Run the `progress` workflow for a per-spec report, or see `TODO.md`.
