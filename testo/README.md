# testo — interactive testing harness (Claude-CLI style)

An interactive REPL front door for the harness. You converse with an agent; it
plans and calls the harness tools (bash / read / grep / glob / graphify / … and
the scan/generate/execute/report tools as they land), streaming activity to the
terminal the way Claude Code does.

```
$ ./testo/testo

  testo — interactive testing harness
  backend minimax  model MiniMax-M2.7  tools 9  cwd .

› where is BASE_URL read in the crawler?
⏺ Grep(BASE_URL)
  ⎿ 6 matches
⏺ Read(context-layer/content-extractor/crawler/crawl.mjs)
  ⎿ Read 10 lines
BASE_URL is read at context-layer/content-extractor/crawler/crawl.mjs:43 …
```

## Run
```bash
./testo/testo            # from the repo root (the launcher cd's to the repo)
```
Uses the graphify venv's Python (has OpenHarness + rich + prompt_toolkit) and adds
`testo/harness` to the path — nothing to install.

## Slash commands
| command | what |
|---|---|
| `/help` | list commands |
| `/tools` | list every callable tool (standard toolbelt + registry) with params |
| `/model [name]` | show or switch the model |
| `/backend` | show the resolved backend + base URL |
| `/clear` | reset the conversation (keep the session open) |
| `/usage` | turns · tool calls · token totals |
| `/cwd` | working directory |
| `/exit` | quit (or Ctrl-D) |

### Pipelines (deterministic — no LLM)
Ported from the retired Node CLI; each is a full pipeline, not a single tool.

| command | runs |
|---|---|
| `/scan --url U [--sso --email E --pass P] [--codebase P] …` | the full context-layer scan (`context-layer/scan.mjs`): crawl + framework detection + code extraction + graphify. `--help` for all flags. |
| `/generate api-tests [--url U --user E --pass P --no-execute] …` | `skill-register` → `api-test-generator` (build + run curl API tests). `--help` for flags. |

### Debugging
`/run <tool> k=v …` invokes one registered tool directly, without the LLM —
useful for testing a tool in isolation (no tokens, no dependence on the model
formatting args). e.g. `/run scan.crawler base_url=http://localhost:3000`.

Or just talk — the agent picks and calls tools itself.

## The tools the agent can call
`python testo/tools_list.py` prints the catalogue. Today: the 8 standard
OpenHarness tools (`bash`, `read_file`, `write_file`, `edit_file`, `glob`,
`grep`, `todo_write`, `agent`) + `graphify`. The scan/generate/execute/report
tools appear here automatically as they're registered in
`agentic_harness/registry/tool_registry.py` (see `docs/spec-09`).

## How it fits together
- `bootstrap.py` — puts `agentic_harness` on the path + loads `.env`.
- `repl.py` — one long-lived `AgenticHarness` (retains conversation history across
  turns) driven in a `prompt_toolkit` loop.
- `render.py` — turns the OpenHarness event stream (`ToolExecutionStarted/Completed`,
  `AssistantTextDelta`, …) into the `⏺ Tool(arg)` / `⎿ result` output.
- `tools_list.py` — the tool inventory (`/tools`).
- `testo` — the launcher (picks the venv Python, roots at the repo).

## Notes
- Backend/model come from `.env` (MiniMax by default). MiniMax-M2.7 is occasionally
  weak at tool-argument JSON (you may see a tool retry); switch with `/model` or
  point at a stronger backend. GitHub Models support is specced in `docs/spec-08`.
- Deny-by-default permission prompts, sessions/resume, and a project `HARNESS.md`
  are the next steps (see `docs/spec-07`). Today the agent auto-runs tools.
