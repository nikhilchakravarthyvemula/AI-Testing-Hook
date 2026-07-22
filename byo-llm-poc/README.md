# byo-llm-poc — invert the LLM (spec-12 POC)

A self-contained proof-of-concept for **spec-12**: instead of an internal LLM
reasoning during a scan (the retired harness + MiniMax path, deleted in
spec-13), the **deterministic pipeline runs with its internal LLM switched
off** and emits clean JSON, and the **host agent's LLM** (Claude Code /
Copilot / Cursor) does the reasoning — then writes it back.

It reuses the **existing** context-layer pipeline (`content-extractor/run.mjs`,
crawler, extractors, `indexer/index.mjs`). Just `node` + the existing scripts.

## The loop

```
  ctx scan ──► run.mjs (CRAWLER_LLM=0, LLM_FRAMEWORK_DETECTION=never, SKIP=graphify)
             ──► index.mjs
             ──► clean JSON envelope + output/run-summary.json
                 + a "delegation" block: per-page un-annotated clickables + intent-schema
        │
        ▼  (the host model reads the pages + schema, classifies each clickable)
  ctx annotate-intents <dir>  ──► identity-keyed merge (by clickable id, not position)
                              ──► SAFETY DERIVED (host can't mark a Delete safe)
                              ──► re-index
        │
        ▼
  ctx context [--topic …]  ──► consumable indexed context for the host to reason over
```

## Commands

```bash
# 1. deterministic scan → JSON + delegation (use --reuse to skip the crawl in a demo)
node byo-llm-poc/ctx.mjs scan --url https://app.example.com [--codebase /path] [--reuse] --json

# 2. host classifies intents into <delegation-dir>/host-intents.json, then:
node byo-llm-poc/ctx.mjs annotate-intents output/delegation/<run-id> --run-id <run-id> --json

# 3. read back the enriched context
node byo-llm-poc/ctx.mjs context --topic click-graph --json
```

`ctx help` for the full list.

## Contract

- **stdout is JSON-only** — exactly one object per command. Every human/diagnostic
  line goes to **stderr** and `output/tool-runs/ctx-<run-id>.log`. (`… --json | jq .ok`
  works.)
- **Exit codes:** `0` ok · `1` a stage failed · `2` bad usage.
- **No internal LLM** in skill mode: `scan` sets `CRAWLER_LLM=0`. Graphify and
  framework detection run deterministically by construction (spec-13), so
  nothing needs skipping — zero LLM calls happen inside the pipeline.
- **Write-back trust boundary:** intents merge by a stable clickable `id` (not by
  position), unknown ids are rejected, and `destructive`/`safeToClick` are
  **re-derived** by the CLI — a hallucinating or hijacked host cannot mark a
  destructive control safe (spec-12 §12 B4).

## What this POC demonstrates vs. leaves out

**Shows:** the end-to-end inversion — deterministic facts → host reasoning →
identity-keyed, safety-derived write-back → re-index → consumable context; clean
`--json` with a stderr/log split; page/batch-scoped delegation (spec-12 §12 B3/B5).

**Out of scope (see spec-12 §12):** graphify semantic enrichment / `enrich-graph`
(needs an AST-only graph source); PII/DLP redaction of crawled bodies+screenshots
before they reach the host; secret redaction on the pipeline's own stdout; packaging;
MCP facade; the `context --plan` host-agnostic playbook for Copilot/Cursor.

## Claude Code skill

`SKILL.md` here is the Claude Code skill that drives this CLI (`/ctx`). To try it,
copy it to `~/.claude/skills/testo-context/SKILL.md`.

## MCP server (VS Code Copilot / Cursor / any MCP host)

`mcp_server.py` is a **second entry point over the same deterministic core** — it shells
the same `ctx.mjs` for the pipeline steps, but does the LLM step via **MCP sampling**
(`ctx.session.create_message`) instead of the CLI's delegation/write-back dance. The host
(Copilot) runs the reasoning on its own model — **no API key in this code**.

Tools: `scan` (deterministic), `scan_and_classify` (scan → sample the host to classify
clickables → write back with safety re-derived → re-index, all in one call), `context`.

Registered in `.vscode/mcp.json` (points at the consolidated venv python). In VS Code:
open **Copilot Chat → Agent mode**, the tools appear in the picker; ask *"scan this app and
summarize the API surface"* and the agent calls `scan_and_classify`, which samples Copilot's
model for the classification.

Notes (per the MCP sampling model): the first sampling call triggers an approval prompt;
Copilot Business/Enterprise needs the MCP policy enabled by an admin; long crawls should
report progress (the server uses `ctx.info`); sampling burns the user's Copilot quota
(batched per page). The deterministic CLI path remains the non-VS-Code fallback.

**This gives three surfaces over one core:** CLI (universal / CI), Claude Code SKILL.md,
and MCP+sampling (Copilot/Cursor). All reuse the same deterministic pipeline; none needs an
LLM key in our code.
