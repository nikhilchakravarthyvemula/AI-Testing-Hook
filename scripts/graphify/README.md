# scripts/graphify

Two Python scripts that drive the **graphify** tool through an LLM agent via
OpenHarness.

> graphify is a **tool**, not a skill. The `skill.md` file that the graphify
> package ships with is just how it distributes its agent instructions — we
> treat it as a system prompt.

## Setup (one-time)

```bash
cd "/Users/superalign/Documents/testing Harness/scripts/graphify"
python3 -m venv .venv
./.venv/bin/pip install -r requirements.txt
```

Also need `graphify` itself installed and on `PATH`:

```bash
pipx install graphify         # or: pip install graphify
graphify --help               # sanity check
```

## Two run modes

### `agent.py` — LLM orchestrates with graphify's full instructions

Loads graphify's bundled `skill.md` as the system prompt, gives the LLM the
**full standard tool registry** (bash / file_read / file_write / file_edit /
glob / grep / todo_write / agent), and lets it drive the run end-to-end
(detect → AST → semantic stages, with retries / file inspection / etc.).

Best for: real graphify runs, larger codebases, when you want the agent to
adapt mid-flight.

```bash
# Default: Gemini 2.5 Flash. Auto-loads GEMINI_API_KEY from <target>/.env.
./.venv/bin/python agent.py /path/to/your/project

# Or local Ollama (use a capable model — small ones collapse on 400-line prompts)
OPENHARNESS_BASE_URL=http://localhost:11434/v1 \
OPENHARNESS_MODEL=qwen2.5-coder:32b \
OPENHARNESS_API_KEY_ENV=NOT_SET_OK \
  ./.venv/bin/python agent.py /path/to/your/project
```

### `tool.py` — graphify wrapped as a SINGLE custom tool

Defines a Python wrapper around the `graphify` CLI and registers it as the
**only** tool the LLM can call. No bash, no file tools. The LLM's job
reduces to "call graphify once with the user's path" — works on much smaller
models because the orchestration burden is gone.

Best for: deterministic single-shot runs, testing local-model tool-calling,
restricted-permission environments.

```bash
# Default: local Ollama llama3.1:8b (no key needed)
./.venv/bin/python tool.py /path/to/your/project

# Or Gemini
OPENHARNESS_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/ \
OPENHARNESS_MODEL=gemini-2.5-flash \
OPENHARNESS_API_KEY_ENV=GEMINI_API_KEY \
  ./.venv/bin/python tool.py /path/to/your/project
```

## Environment variables (both scripts)

| Var | Purpose | Default |
|---|---|---|
| `OPENHARNESS_BASE_URL` | OpenAI-compatible endpoint | `agent.py`: Gemini; `tool.py`: Ollama |
| `OPENHARNESS_MODEL` | Model name | `agent.py`: `gemini-2.5-flash`; `tool.py`: `llama3.1:8b` |
| `OPENHARNESS_API_KEY_ENV` | Name of env var holding the API key | `agent.py`: `GEMINI_API_KEY`; `tool.py`: `NOT_SET_OK` (falls back to literal "ollama") |
| `GRAPHIFY_BIN` | Path / name of the graphify CLI binary (`tool.py` only) | `graphify` |
| `GRAPHIFY_INSTRUCTIONS_PATH` | Path to graphify's `skill.md` (`agent.py` only) | auto-located |
| `MAX_TURNS` | Max LLM turns (`agent.py` only) | `80` |

## Output

Graphify writes its artifacts to `<target>/graphify-out/`:
- `.graphify_detect.json` — file detection results
- `.graphify_ast.json` — AST nodes + edges
- `.graphify_semantic.json` — semantic enrichment (if run completes)

## Known issues

- **macOS BashTool patch**: `agent.py` includes a monkey-patch for OpenHarness's
  shell wrapper which assumes util-linux `script -f` (not on BSD). No action
  needed; it's automatic.
- **Local small models collapse on `agent.py`**: anything under ~32B parameters
  tends to emit fake markdown tool calls when the system prompt is large
  (graphify's instructions are 400+ lines). Use `tool.py` instead.
