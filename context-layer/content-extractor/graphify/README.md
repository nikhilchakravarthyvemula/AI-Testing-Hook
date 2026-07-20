# context-layer/content-extractor/graphify

The **pipeline adapter** for graphify. `run.mjs` auto-discovers this folder as
source id `graphify` (it has `extract.mjs`).

`extract.mjs` shells out to the harness (`testo/harness/bin/call_tool.py graphify`)
against `TARGET_CODEBASE`, then writes a normalized source bundle at
`output/graphify/bundle.json` (pointing at the produced `graph.json`) with a
freshness guard.

## Where the actual tool lives

The graphify **harness tool** (the `GraphifyTool` the registry loads, plus its
`with_minimax.py` backend launcher and the standalone `agent.py` dev script)
moved to **`testo/harness/agentic_harness/tools/graphify/`** — it's a harness
concern, not a content-extractor concern. This folder keeps only the pipeline
adapter. The registry wires it via `source_path` in
`testo/harness/agentic_harness/registry/tool_registry.py`.

## Interpreter

Both the adapter's spawn and the tool run under the shared harness venv at
`context-layer/content-extractor/_lib/.venv` (the single consolidated Python env).
`requirements.txt` here records graphify's original deps (openharness-ai, pydantic,
openai) — now folded into `_lib/requirements.txt`.

## Backends

`GRAPHIFY_BACKEND` selects the LLM backend (minimax / ollama / auto). `minimax`
routes through `testo/harness/agentic_harness/tools/graphify/with_minimax.py`
(registers a MiniMax backend + strips `<think>` blocks). `gemini` is intentionally
disabled in this checkout.
