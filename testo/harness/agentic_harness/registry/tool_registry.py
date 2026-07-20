"""ToolRegistry — maps tool names → loaded (tool_instance, args_class).

The catalog lives at module scope as `REGISTERED_TOOLS`; ToolRegistry
just provides a typed API over it. Lazy imports — the source file for
a tool isn't read until that tool is requested.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from typing import Any

from ..exceptions import ToolSourceMissingError, UnknownToolError
from ..interfaces import IBaseTool
from ..models import ToolDefinition


# Resolve the repo root so source_path entries can be repo-relative.
# This file: <repo>/testo/harness/agentic_harness/registry/tool_registry.py
#   parents[0]=registry/  parents[1]=agentic_harness/  parents[2]=harness/
#   parents[3]=testo/  parents[4]=<repo>
_REPO_ROOT = Path(__file__).resolve().parents[4]


# ── catalog — add a row here to expose a new tool ─────────────────────────
#
# Source paths are RELATIVE to the repo root (the testing-harness/ folder).
# The registry resolves them to absolute paths at load time.

REGISTERED_TOOLS: dict[str, ToolDefinition] = {
    "graphify": ToolDefinition(
        name="graphify",
        source_path=Path("testo/harness/agentic_harness/tools/graphify/tool.py"),
        tool_class="GraphifyTool",
        args_class="GraphifyArgs",
        summary="LLM-enriched semantic code graph (AST + relationships). "
                "Produces graph.json + HTML reports.",
    ),
    "scan.crawler": ToolDefinition(
        name="scan.crawler",
        source_path=Path("testo/harness/agentic_harness/tools/stage_tools/crawler_tool.py"),
        tool_class="CrawlerTool",
        args_class="CrawlerArgs",
        summary="Crawl a live web app → output/crawler/bundle.json "
                "(endpoints, pages, click-graph, LLM intents).",
    ),
    "scan.code_extractors": ToolDefinition(
        name="scan.code_extractors",
        source_path=Path("testo/harness/agentic_harness/tools/stage_tools/code_extractors_tool.py"),
        tool_class="CodeExtractorsTool",
        args_class="CodeExtractorsArgs",
        summary="Static per-framework code extraction over a codebase "
                "→ output/code-extractors/*.json (routes, endpoints, forms).",
    ),
    # Add new tools here. The CLI + ask.py auto-discover everything in this dict.
}


class ToolRegistry:
    """Implements `IToolRegistry`. Loads tool classes from source files."""

    def __init__(self, catalog: dict[str, ToolDefinition] | None = None) -> None:
        self._catalog = catalog or REGISTERED_TOOLS

    # ── public ────────────────────────────────────────────────────────────

    def list_tools(self) -> list[str]:
        """Names of every registered tool, sorted."""
        return sorted(self._catalog.keys())

    def get_definition(self, name: str) -> ToolDefinition:
        """Return the ToolDefinition for `name` or raise UnknownToolError."""
        try:
            return self._catalog[name]
        except KeyError as exc:
            raise UnknownToolError(
                f"Unknown tool {name!r}. Registered: {self.list_tools()}"
            ) from exc

    def load(self, name: str) -> tuple[IBaseTool, type]:
        """Return (tool_instance, args_class) for the named tool.

        Raises:
            UnknownToolError: name not in catalog.
            ToolSourceMissingError: source file on disk is missing.
        """
        definition = self.get_definition(name)
        source_path = _REPO_ROOT / definition.source_path
        if not source_path.exists():
            raise ToolSourceMissingError(
                f"Tool {name!r} source missing at {source_path}"
            )

        module = self._import_source_file(name, source_path)
        tool_cls = getattr(module, definition.tool_class)
        args_cls = getattr(module, definition.args_class)
        return tool_cls(), args_cls

    # ── internals ─────────────────────────────────────────────────────────

    @staticmethod
    def _import_source_file(name: str, path: Path) -> Any:
        """Load a Python file at `path` under a synthetic module name.

        Also injects the file's parent directory onto sys.path so
        relative imports inside the tool's source resolve.
        """
        parent = str(path.parent)
        if parent not in sys.path:
            sys.path.insert(0, parent)

        spec = importlib.util.spec_from_file_location(f"_ah_tool_{name}", path)
        if spec is None or spec.loader is None:
            raise ImportError(f"Could not import tool source: {path}")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module


__all__ = ["REGISTERED_TOOLS", "ToolRegistry"]
