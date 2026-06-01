"""The standard set of OpenHarness tools every free-agent gets.

Separated from any specific service so an alternate harness or test
can swap a different toolbelt in without touching the service layer.

The macOS BashTool patch (needed because OpenHarness's shell wrapper
assumes util-linux `script -f`) lives here too — applied lazily on
first call so importing this module is cheap on non-Darwin platforms.
"""

from __future__ import annotations

import sys
from typing import Sequence

from openharness.tools.agent_tool import AgentTool
from openharness.tools.base import ToolRegistry
from openharness.tools.bash_tool import BashTool
from openharness.tools.file_edit_tool import FileEditTool
from openharness.tools.file_read_tool import FileReadTool
from openharness.tools.file_write_tool import FileWriteTool
from openharness.tools.glob_tool import GlobTool
from openharness.tools.grep_tool import GrepTool
from openharness.tools.todo_write_tool import TodoWriteTool

from ..interfaces import IBaseTool


_DARWIN_PATCH_APPLIED = False


def _apply_darwin_bash_patch_once() -> None:
    """No-op the script(1) wrapper on macOS — BSD `script` has no `-f` flag."""
    global _DARWIN_PATCH_APPLIED
    if _DARWIN_PATCH_APPLIED or sys.platform != "darwin":
        return
    import openharness.utils.shell as _oh_shell

    _oh_shell._wrap_command_with_script = lambda *a, **kw: None  # noqa: SLF001
    _DARWIN_PATCH_APPLIED = True


def standard_tools() -> list[IBaseTool]:
    """Return fresh instances of every standard tool, in stable order."""
    _apply_darwin_bash_patch_once()
    return [
        BashTool(),
        FileReadTool(),
        FileWriteTool(),
        FileEditTool(),
        GlobTool(),
        GrepTool(),
        TodoWriteTool(),
        AgentTool(),
    ]


def build_toolbelt(custom_tools: Sequence[IBaseTool] = ()) -> ToolRegistry:
    """Return a `ToolRegistry` containing the standard tools + any custom ones."""
    registry = ToolRegistry()
    for tool in standard_tools():
        registry.register(tool)
    for tool in custom_tools:
        registry.register(tool)
    return registry


DEFAULT_SYSTEM_PROMPT = (
    "You are an automation agent running inside the testing-harness "
    "project. You have a toolbelt of standard utilities (bash, "
    "read_file, write_file, edit_file, glob, grep, todo_write, agent) "
    "plus any custom tools registered for this session. When the user "
    "asks you to do something, pick the right tools and run them; "
    "don't ask for confirmation. If a tool returns an error, read it "
    "and adapt — try smaller chunks, different paths, retry, etc. "
    "When the task is done, summarise what you produced in one short "
    "paragraph.\n\n"
    "## Tool naming\n"
    "If older instructions reference Bash/Read/Write/Edit/Glob/Grep/"
    "TodoWrite/Agent (Claude Code names), use the equivalents above."
)


__all__ = ["build_toolbelt", "standard_tools", "DEFAULT_SYSTEM_PROMPT"]
