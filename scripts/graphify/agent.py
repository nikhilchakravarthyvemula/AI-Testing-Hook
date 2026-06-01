"""Drive the graphify TOOL with an LLM agent via OpenHarness.

Mode "agent": loads graphify's bundled agent instructions (skill.md the
package ships) as the system prompt, gives the LLM the full standard tool
registry (bash/file/glob/grep/todo/agent), and lets it orchestrate the run
end-to-end. Best when graphify needs multi-step thinking (detect → ast →
semantic, with retries / file inspection along the way).

Defaults:
    model:   gemini-2.5-flash   (via OpenAI-compatible endpoint)
    api key: read from $GEMINI_API_KEY, or auto-loaded from <target>/.env

Override to local Ollama:
    OPENHARNESS_BASE_URL=http://localhost:11434/v1 \\
    OPENHARNESS_MODEL=llama3.1:8b \\
    OPENHARNESS_API_KEY_ENV=NOT_SET_OK \\
        python agent.py /path/to/target

Note: per session memory, graphify is a TOOL — the bundled `skill.md` is
just how the graphify package distributes its agent instructions.
"""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

# macOS BashTool patch — OpenHarness's shell wrapper assumes util-linux
# `script -f`, which doesn't exist on BSD. Make the wrapper a no-op on darwin.
if sys.platform == "darwin":
    import openharness.utils.shell as _oh_shell
    _oh_shell._wrap_command_with_script = lambda *a, **kw: None  # noqa: SLF001

from openharness.api.openai_client import OpenAICompatibleClient
from openharness.config.settings import PermissionMode, PermissionSettings
from openharness.engine.query_engine import QueryEngine
from openharness.engine.stream_events import (
    AssistantTextDelta,
    AssistantTurnComplete,
    ErrorEvent,
    StatusEvent,
    ToolExecutionCompleted,
    ToolExecutionStarted,
)
from openharness.permissions.checker import PermissionChecker
from openharness.tools.agent_tool import AgentTool
from openharness.tools.base import ToolRegistry
from openharness.tools.bash_tool import BashTool
from openharness.tools.file_edit_tool import FileEditTool
from openharness.tools.file_read_tool import FileReadTool
from openharness.tools.file_write_tool import FileWriteTool
from openharness.tools.glob_tool import GlobTool
from openharness.tools.grep_tool import GrepTool
from openharness.tools.todo_write_tool import TodoWriteTool

GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/"
GEMINI_MODEL = "gemini-2.5-flash"

OPENHARNESS_BASE_URL = os.environ.get("OPENHARNESS_BASE_URL") or GEMINI_BASE_URL
OPENHARNESS_MODEL = os.environ.get("OPENHARNESS_MODEL") or GEMINI_MODEL
OPENHARNESS_API_KEY_ENV = os.environ.get("OPENHARNESS_API_KEY_ENV", "GEMINI_API_KEY")
MAX_TURNS = int(os.environ.get("MAX_TURNS", "80"))


def find_graphify_instructions() -> Path:
    """Locate graphify's bundled `skill.md` (its agent instruction file).

    Priority:
      1. $GRAPHIFY_INSTRUCTIONS_PATH override
      2. Importable graphify package in the current env
      3. Common pipx install paths
    """
    override = os.environ.get("GRAPHIFY_INSTRUCTIONS_PATH")
    if override:
        return Path(override)
    try:
        from importlib.resources import files  # py3.9+
        candidate = Path(str(files("graphify") / "skill.md"))
        if candidate.is_file():
            return candidate
    except Exception:
        pass
    for p in [
        Path.home() / ".local/pipx/venvs/graphifyy/lib/python3.14/site-packages/graphify/skill.md",
        Path.home() / ".local/pipx/venvs/graphify/lib/python3.14/site-packages/graphify/skill.md",
        Path.home() / ".local/pipx/venvs/graphifyy/lib/python3.13/site-packages/graphify/skill.md",
        Path.home() / ".local/pipx/venvs/graphify/lib/python3.13/site-packages/graphify/skill.md",
    ]:
        if p.is_file():
            return p
    raise FileNotFoundError(
        "graphify instructions not found. Set GRAPHIFY_INSTRUCTIONS_PATH to the path of "
        "graphify's skill.md (e.g. ~/.local/pipx/venvs/graphifyy/lib/.../graphify/skill.md)."
    )


def load_env(target: Path) -> None:
    """Pull GEMINI_API_KEY / GOOGLE_API_KEY from <target>/.env if not set."""
    if os.environ.get("GEMINI_API_KEY"):
        return
    env_path = target / ".env"
    if not env_path.is_file():
        return
    for raw in env_path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        k = k.strip()
        v = v.strip().strip('"').strip("'")
        if k in {"GEMINI_API_KEY", "GOOGLE_API_KEY"} and v and k not in os.environ:
            os.environ[k] = v


def build_registry() -> ToolRegistry:
    reg = ToolRegistry()
    for tool in (
        BashTool(), FileReadTool(), FileWriteTool(), FileEditTool(),
        GlobTool(), GrepTool(), TodoWriteTool(), AgentTool(),
    ):
        reg.register(tool)
    return reg


def build_system_prompt() -> str:
    instructions = find_graphify_instructions().read_text(encoding="utf-8")
    # Bridge tool naming between Claude Code and OpenHarness.
    bridge = (
        "\n\n---\n\n"
        "## Tool naming under OpenHarness\n\n"
        "You are running under OpenHarness, not Claude Code. The tools available "
        "to you are named: `bash`, `read_file`, `write_file`, `edit_file`, `glob`, "
        "`grep`, `todo_write`, `agent`. Wherever the instructions above reference "
        "Bash/Read/Write/Edit/Glob/Grep/TodoWrite/Agent, use the equivalents above.\n"
    )
    return instructions + bridge


async def run(target: str) -> None:
    target_path = Path(target).resolve()
    load_env(target_path)
    api_key = os.environ.get(OPENHARNESS_API_KEY_ENV) or "ollama"

    api = OpenAICompatibleClient(api_key=api_key, base_url=OPENHARNESS_BASE_URL)
    engine = QueryEngine(
        api_client=api,
        tool_registry=build_registry(),
        permission_checker=PermissionChecker(
            PermissionSettings(mode=PermissionMode.FULL_AUTO)
        ),
        cwd=target_path,
        model=OPENHARNESS_MODEL,
        system_prompt=build_system_prompt(),
        max_turns=MAX_TURNS,
        max_tokens=8192,
    )

    user_prompt = f"Run graphify on {target_path}"
    print(
        f"[boot] model={OPENHARNESS_MODEL} base={OPENHARNESS_BASE_URL} cwd={target_path} "
        f"max_turns={MAX_TURNS}",
        flush=True,
    )
    print(f"[boot] user prompt: {user_prompt!r}", flush=True)

    turn = 0
    async for event in engine.submit_message(user_prompt):
        if isinstance(event, AssistantTextDelta):
            print(event.text, end="", flush=True)
        elif isinstance(event, ToolExecutionStarted):
            shown = repr(event.tool_input)
            if len(shown) > 280:
                shown = shown[:277] + "..."
            print(f"\n[tool→ #{turn}] {event.tool_name}({shown})", flush=True)
        elif isinstance(event, ToolExecutionCompleted):
            tail = (event.output or "")[-400:]
            print(f"\n[tool← err={event.is_error}] {tail}", flush=True)
        elif isinstance(event, StatusEvent):
            print(f"\n[status] {event.message}", flush=True)
        elif isinstance(event, ErrorEvent):
            print(f"\n[ENGINE ERROR] {event!r}", flush=True)
            return
        elif isinstance(event, AssistantTurnComplete):
            turn += 1
            print(f"\n[turn {turn} complete]", flush=True)
    print("\n[run finished]", flush=True)


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else os.getcwd()
    asyncio.run(run(target))
