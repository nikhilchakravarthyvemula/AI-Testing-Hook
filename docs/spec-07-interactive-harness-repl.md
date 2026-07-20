# Spec 07 — `testo` as an interactive testing harness (Claude-CLI-like REPL)

_Target: **Infrastructure** (agentic-harness) + **Interfaces** (`testo`)._

> **Goal:** using the harness should feel like Claude Code — an interactive REPL where you
> converse with the harness; it plans, calls the testing tools (scan / generate / execute /
> report / graphify / ask-anything), streams tool activity, asks permission for risky actions,
> and persists sessions.

**Today:** `testo ask` is single-shot — `bin/ask.py` runs one `invoke_via_free_agent` and
exits; plain `print` rendering; a throwaway engine per call; `PermissionMode.FULL_AUTO`; no
sessions, no slash commands, no memory.

---

## 1. Decisive discovery — we wire it, we don't build it

**OpenHarness (already installed) ships the entire interactive stack.** Verified in the
installed package (`context-layer/content-extractor/graphify/.venv/.../site-packages/openharness/`):

| Capability | Where it already exists |
|---|---|
| Multi-turn engine | `QueryEngine` retains history across `submit_message()` calls (`engine/query_engine.py:54,156,186`); `set_system_prompt / set_model / set_max_turns / set_permission_checker` are runtime-mutable |
| Canonical REPL loop | `ui/runtime.py:583-664` — submit → render events → snapshot save; `MaxTurnsExceeded` + `continue_pending` handling |
| Streaming event renderer | `ui/output.py:56 render_event()` |
| Interactive permissions | `PermissionPrompt = Callable[[str,str],Awaitable[bool]]` threaded `QueryEngine → QueryContext` (`query.py:53,150,921-954`); modes `DEFAULT / PLAN / FULL_AUTO`; ready-made dialog `ui/permission_dialog.py` (wired in `ui/backend_host.py:101`) |
| Slash commands | `commands/registry.py` — `SlashCommand`, `CommandRegistry`, `/`-dispatch |
| Sessions | `services/session_storage.py` (`save/load/list_session_snapshots`, per-project dir keyed by cwd sha1) + `services/session_backend.py` |
| Terminal deps | rich 15, prompt_toolkit 3.0.52, textual 8.2.6 — already in the venv |
| Full-stack template | `ui/backend_host.py:90-110` — engine + both callbacks + session_backend + permission_mode wired together |
| TTY path | `testo.mjs:71` and `ask.mjs:65` both spawn with `stdio:'inherit'` → prompt_toolkit gets a real TTY through both hops |

So the plan is a **wiring job**: compose OpenHarness's runtime with agentic-harness's existing
pieces (BackendResolver, ToolRegistry, standard toolbelt) behind a new REPL entrypoint.

---

## 2. Approach

**New entrypoint `testo/harness/bin/repl.py` + a small
`agentic_harness/repl/` package.** Use `harness_service.AgenticHarness` as the reference for
engine construction, but build a **long-lived** engine with `permission_prompt` /
`ask_user_prompt` callbacks and a session_backend (the seam `ui/backend_host.py` demonstrates).

### Workstreams

| WS | What | Key work | Days |
|----|------|----------|:---:|
| **WS1 REPL core** | `bin/repl.py` + `repl/` glue | Long-lived `QueryEngine` (history retained); loop per `ui/runtime.py`; render via `ui/output.render_event`; toolbelt = `build_toolbelt(ToolRegistry custom tools)`; backend via existing `BackendResolver` | 4–5 |
| **WS2 Permissions** | deny-by-default + interactive approval | Mode `DEFAULT` (not FULL_AUTO); supply `permission_prompt` (y/n via the `ui/permission_dialog` pattern); persisted allowlist in `~/.testo/settings.json`; `/permissions` command. **Also satisfies spec-05's P5 deny-by-default prerequisite.** | 3–4 |
| **WS3 Sessions** | save / resume | Wire `session_backend` snapshots per turn; `testo --continue` / `--resume <id>`; `/sessions`, `/save` | 2 |
| **WS4 Slash commands + statusline** | `/help /tools /model /backend /clear /usage /permissions /exit` via `CommandRegistry`; statusline `backend·model·session tokens` | `/usage` reads per-turn `usage` + the `output/*-usage.jsonl` sinks | 3 |
| **WS5 Project context** | `HARNESS.md` | Auto-load repo `HARNESS.md` into the system prompt (engine `set_system_prompt`, rebuilt per turn as `ui/runtime.py:581` does); harness role prompt describing the testing tools | 1–2 |
| **WS6 `testo` launcher** | REPL as default | `testo` (no args) → spawn `bin/repl.py` (today no-cmd prints help + exit(1), `testo.mjs:56-59`); `testo -p "…"` one-shot alias onto ask | 1 |
| **WS7 Tool catalog** | the testing tools in the REPL | = **spec-05 P0/P1** (SubprocessStageTool + registry rows for scan/generate/execute/report leaves) — a dependency, not duplicated here. The REPL is useful day 1 with the standard toolbelt + graphify; it gains the full 50-tool catalog as spec-05 lands | (spec-05) |

**Effort: ~3 weeks (1 engineer) for WS1–WS6.** With spec-05 P0/P1 alongside (~3–4 wks), the
full "Claude-like testing harness" lands in **~4–6 weeks**.

### Files
- **new** `testo/harness/bin/repl.py`, `agentic_harness/repl/{loop.py,commands.py,permissions.py,statusline.py}`
- **new** `HARNESS.md` (repo-root project context)
- edit `testo/harness/agentic_harness/services/harness_service.py` (expose a
  long-lived engine with callbacks; keep `submit()` back-compat) and `pyproject.toml` (declare
  `rich` / `prompt_toolkit` explicitly — already installed transitively)
- edit `the retired interfaces/cli/testo.mjs (since replaced by the testo/repl.py REPL)` (no-args → repl; `-p` alias), `ask.mjs` (retired with the Node CLI)
  (share the venv-python resolution)
- **reuse (no fork):** openharness `ui/runtime.py`, `ui/output.py`, `ui/permission_dialog.py`,
  `commands/registry.py`, `services/session_{storage,backend}.py`, `standard_toolbelt.py`;
  agentic-harness `backends/{resolver,catalog}.py`, `registry/tool_registry.py`

---

## 3. Verification
1. `testo` opens the REPL; multi-turn: a follow-up referencing the prior answer → history retained.
2. "graphify <repo>" (today) / "scan https://…" (post-spec-05) → streamed tool blocks rendered
   via `render_event`.
3. A mutating tool (bash `rm`, file_write) triggers an interactive y/n; deny → tool blocked,
   conversation continues; allowlist persists across restarts.
4. `testo --continue` restores the last session (messages + tool metadata); `/sessions` lists
   snapshots.
5. `/usage` shows per-turn and session token totals matching the `output/*-usage.jsonl` sinks.
6. Golden-output guard: deterministic `testo scan` untouched — byte-identical.

## 4. Out of scope (this pass)
- The full tool catalog itself (spec-05 P0/P1 dependency).
- Textual full-screen TUI (`ui/textual_app.py` exists — line-based REPL first).
- Memory/skill distillation across sessions (spec-02 territory).
