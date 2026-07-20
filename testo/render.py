"""Claude-CLI-style renderer for OpenHarness stream events.

Turns the raw QueryEngine event stream (AssistantTextDelta / ToolExecutionStarted
/ ToolExecutionCompleted / AssistantTurnComplete / ErrorEvent) into the familiar
`⏺ Read(file)` / `  ⎿ 42 lines` terminal output you get from Claude Code.

Kept deliberately dependency-light: rich for colour, nothing else.
"""

from __future__ import annotations

import json
from typing import Any

from rich.console import Console
from rich.text import Text

# tool_name → (display label, primary-arg field, accent colour)
_TOOL_META: dict[str, tuple[str, str | None, str]] = {
    "bash":        ("Bash",         "command",     "yellow"),
    "read_file":   ("Read",         "path",        "cyan"),
    "write_file":  ("Write",        "path",        "green"),
    "edit_file":   ("Edit",         "path",        "green"),
    "glob":        ("Glob",         "pattern",     "cyan"),
    "grep":        ("Grep",         "pattern",     "cyan"),
    "todo_write":  ("Update Todos", "item",        "magenta"),
    "agent":       ("Task",         "description", "magenta"),
    "graphify":    ("Graphify",     "target",      "blue"),
}


def _primary_arg(tool_name: str, tool_input: Any) -> str:
    """A short, human-readable rendering of the tool's key argument."""
    if not isinstance(tool_input, dict):
        return str(tool_input)[:120]
    _, field, _ = _TOOL_META.get(tool_name, (tool_name, None, "white"))
    val = None
    if field and field in tool_input:
        val = tool_input[field]
    else:  # fall back to the first stringy value
        for v in tool_input.values():
            if isinstance(v, (str, int, float)):
                val = v
                break
    if val is None:
        val = json.dumps(tool_input)[:120]
    s = str(val).replace("\n", " ⏎ ")
    return s if len(s) <= 100 else s[:99] + "…"


def _summarize(tool_name: str, output: str | None, is_error: bool) -> str:
    """One-line result summary, Claude-CLI `⎿` style."""
    out = output or ""
    lines = [ln for ln in out.splitlines()]
    n = len(lines)
    if is_error:
        first = next((ln.strip() for ln in lines if ln.strip()), "error")
        return f"Error: {first[:140]}"
    if tool_name == "read_file":
        return f"Read {n} line{'s' if n != 1 else ''}"
    if tool_name == "glob":
        return f"{n} file{'s' if n != 1 else ''}"
    if tool_name == "grep":
        return f"{n} match{'es' if n != 1 else ''}"
    if tool_name in ("write_file", "edit_file"):
        return "Done"
    if tool_name == "todo_write":
        return "Updated"
    first = next((ln.strip() for ln in lines if ln.strip()), "(no output)")
    extra = f"  (+{n - 1} lines)" if n > 1 else ""
    return (first[:140] + ("…" if len(first) > 140 else "")) + extra


class Renderer:
    """Streams events to the terminal. One instance per REPL session."""

    def __init__(self, console: Console | None = None) -> None:
        self.console = console or Console()
        self._in_text = False  # currently streaming assistant prose?
        self.turn_tool_calls = 0

    # ── per-event entry point ──────────────────────────────────────────────
    def handle(self, event: Any) -> None:
        name = type(event).__name__
        if name == "AssistantTextDelta":
            self._text(event.text)
        elif name == "ToolExecutionStarted":
            self._tool_start(event.tool_name, event.tool_input)
        elif name == "ToolExecutionCompleted":
            self._tool_done(event.tool_name, event.output, event.is_error)
        elif name == "ErrorEvent":
            self._break_text()
            self.console.print(f"[bold red]✗ engine error[/]  {event.message}")
        elif name == "AssistantTurnComplete":
            self._break_text()

    # ── renderers ───────────────────────────────────────────────────────────
    def _text(self, text: str) -> None:
        if not text:
            return
        if not self._in_text:
            self.console.print()  # blank line before a fresh assistant block
            self._in_text = True
        # stream raw so it feels live; rich would re-wrap/parse markup mid-stream
        self.console.file.write(text)
        self.console.file.flush()

    def _break_text(self) -> None:
        if self._in_text:
            self.console.file.write("\n")
            self.console.file.flush()
            self._in_text = False

    def _tool_start(self, tool_name: str, tool_input: Any) -> None:
        self._break_text()
        self.turn_tool_calls += 1
        label, _, colour = _TOOL_META.get(tool_name, (tool_name, None, "white"))
        arg = _primary_arg(tool_name, tool_input)
        line = Text()
        line.append("⏺ ", style=f"bold {colour}")
        line.append(label, style="bold")
        line.append(f"({arg})", style=colour)
        self.console.print(line)

    def _tool_done(self, tool_name: str, output: str | None, is_error: bool) -> None:
        summary = _summarize(tool_name, output, is_error)
        style = "red" if is_error else "dim"
        self.console.print(Text("  ⎿ ", style="dim") + Text(summary, style=style))

    # ── turn lifecycle ────────────────────────────────────────────────────
    def start_turn(self) -> None:
        self.turn_tool_calls = 0

    def end_turn(self) -> None:
        self._break_text()
