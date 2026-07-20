"""Tool inventory — every tool the harness agent can call.

Two sources:
  * the standard OpenHarness toolbelt (bash / read / write / edit / glob / grep /
    todo_write / agent) — the same tools Claude Code exposes, by different names;
  * every custom tool registered in agentic_harness REGISTERED_TOOLS (graphify
    today; the scan/generate/execute/report tools as spec-09 lands).

Importable (`collect_tools()` powers the REPL's `/tools`) and runnable
(`python tools_list.py` prints the catalogue).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from rich.console import Console
from rich.table import Table


@dataclass
class ToolInfo:
    name: str
    source: str          # "standard" | "registry"
    description: str
    params: list[str]


def _params(tool: Any) -> list[str]:
    im = getattr(tool, "input_model", None)
    if im is not None and hasattr(im, "model_fields"):
        req = getattr(im, "model_fields")
        return [
            n + ("" if f.is_required() else "?")
            for n, f in req.items()
        ]
    return []


def collect_tools() -> list[ToolInfo]:
    """Return the full catalogue: standard toolbelt + registry tools."""
    from agentic_harness.tools.standard_toolbelt import standard_tools
    from agentic_harness import ToolRegistry

    out: list[ToolInfo] = []
    for t in standard_tools():
        out.append(ToolInfo(
            name=t.name,
            source="standard",
            description=(getattr(t, "description", "") or "").split("\n")[0],
            params=_params(t),
        ))

    reg = ToolRegistry()
    for name in reg.list_tools():
        try:
            tool, _args = reg.load(name)
            out.append(ToolInfo(
                name=tool.name,
                source="registry",
                description=(getattr(tool, "description", "") or "").split("\n")[0],
                params=_params(tool),
            ))
        except Exception as exc:  # a broken registry row shouldn't hide the rest
            out.append(ToolInfo(name, "registry", f"(load error: {exc})", []))
    return out


def render_table(console: Console | None = None) -> None:
    console = console or Console()
    tools = collect_tools()
    std = sum(1 for t in tools if t.source == "standard")
    reg = sum(1 for t in tools if t.source == "registry")

    table = Table(title=None, show_edge=False, pad_edge=False, box=None)
    table.add_column("tool", style="bold cyan", no_wrap=True)
    table.add_column("src", style="dim")
    table.add_column("params", style="green")
    table.add_column("what it does", style="white")
    for t in tools:
        table.add_row(t.name, t.source, " ".join(t.params) or "—", t.description)

    console.print(table)
    console.print(
        f"\n[dim]{len(tools)} tools · {std} standard toolbelt · {reg} registry "
        f"(add rows to agentic_harness REGISTERED_TOOLS to grow this)[/]"
    )


if __name__ == "__main__":
    import bootstrap  # noqa: F401 — sets sys.path + loads .env
    render_table()
