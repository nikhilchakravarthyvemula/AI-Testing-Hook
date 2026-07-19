# Agentic Harness

> ⚠️ **DORMANT / SUPERSEDED (2026-07-19).** For the P0 harness the engine layer
> is Node — single-shot calls go through `complete()` and agent sessions through
> `runSession()`, both in `infrastructure/model-api-connector/`, both driving the
> `claude` CLI (see `docs/specs/p0-02-engine-layer.spec.md`, OQ-4). This
> OpenHarness/Python package is **not on any P0 path**. It's left in place as
> reference and as a possible home for a non-Claude/local-model backend later;
> nothing in the run pipeline imports it. Don't extend it without re-opening that
> decision.

Wraps OpenHarness to be the single LLM-tool-calling seam for the project.
Every place that wants "an LLM with tools" goes through here instead of
constructing `QueryEngine` ad-hoc.

This is the architecture-diagram **Agentic Harness** box.

## Why centralise

Previously, `scripts/graphify/tool.py` constructed its own `QueryEngine`
configured to talk to a local `llama3.1:8b` Ollama. That tiny model
routinely hallucinated tool arguments (`{'<path>': ...}` literally with
angle brackets) — pydantic rejected the call, the tool never ran, the
agent declared success, and the graphify wrapper read a stale graph.json
and reported it as fresh.

Moving the agent setup here means:

* One place where backend / model choice is decided (auto-detect from
  the same `.env` keys the rest of the project reads).
* Two clean modes — direct (no LLM) for "I know what I want" calls,
  agent for "let the LLM pick a tool" experiments.
* Honest result accounting — agent mode marks a run as failed if the
  LLM finished without ever invoking a tool, instead of silently
  returning "ok=true" based on hallucinated text.

## Layout

```
infrastructure/agentic-harness/
├── client.py         AgenticHarness — wraps openharness.QueryEngine
├── tool_service.py   ToolService — direct + agent invocation modes
├── registry.py       known-tools table (currently: graphify)
├── bin/
│   └── call_tool.py  CLI entrypoint (this is what callers invoke)
└── README.md
```

## Two invocation modes

### Direct (recommended default)

Bypass the LLM entirely. Use when you already know which tool with which
arguments. This is what the `testo scan` path uses for graphify today.

```bash
python infrastructure/agentic-harness/bin/call_tool.py graphify \
       --mode direct \
       --path /path/to/your/codebase
```

Output: `[tool→] graphify(...)` then the tool's own log, then
`[tool← graphify err=False]`. Exit code 0 on success, 1 on tool-reported
error, 2 on bad args / unknown tool.

### Agent (for experimentation)

Let the LLM read a free-text prompt, decide to call a registered tool,
and pass it the right arguments. Uses whatever backend `client.py`
resolves from env (MiniMax-M2.7 by default today).

```bash
python infrastructure/agentic-harness/bin/call_tool.py graphify \
       --mode agent \
       --prompt "Run graphify on /path/to/your/codebase"
```

Strict honesty rule: if the LLM finishes without invoking a tool, the
command exits non-zero with `[agent←] WARNING: agent never invoked a
tool`. We learned this matters.

## Backend resolution

Same priority chain as `scripts/graphify/tool.py:_auto_backend`:

| Order | Backend | Picked when… | Default model |
|---|---|---|---|
| 1 | `minimax` | `MINIMAX_API_KEY` set | `MiniMax-M2.7` |
| 2 | `openai`  | `OPENAI_API_KEY` set | `gpt-4o-mini` |
| 3 | `kimi`    | `KIMI_API_KEY` set   | `moonshot-v1-32k` |
| 4 | `ollama`  | (fallback)           | `llama3.1:8b` |

Gemini is intentionally absent — user opted out 2026-05-20.

Override the model per backend with `AGENTIC_HARNESS_<BACKEND>_MODEL`
in env. E.g. `AGENTIC_HARNESS_MINIMAX_MODEL=MiniMax-M2`.

## Adding a tool

1. Write the tool — any `openharness.tools.base.BaseTool` subclass + a
   `pydantic.BaseModel` args class.
2. Add a row to `registry.py:_TOOLS`:

   ```python
   _TOOLS = {
       "graphify":   ("scripts/graphify/tool.py", "GraphifyTool", "GraphifyArgs"),
       "your-tool":  ("path/to/your_tool.py",     "YourTool",     "YourArgs"),
   }
   ```

That's it. The CLI picks it up automatically.

## Python environment

Reuses the venv at `scripts/graphify/.venv/` (which has OpenHarness
installed). The graphify wrapper invokes `call_tool.py` with that
interpreter:

```bash
scripts/graphify/.venv/bin/python infrastructure/agentic-harness/bin/call_tool.py …
```

No separate install required.
