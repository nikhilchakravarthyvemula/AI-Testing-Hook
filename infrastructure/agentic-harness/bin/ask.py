#!/usr/bin/env python
"""User-facing entrypoint to the agentic-harness.

Takes a plain-English prompt. Tool calling is internal — the LLM picks
from the full toolbelt + every tool in `registry.py`.

Usage:
    python ask.py "<prompt>" [--max-turns N] [--register TOOL ...]

Exit codes:
    0 — agent ran at least one tool, last tool succeeded
    1 — agent ran tools but ended in failure
    2 — agent never invoked any tool (talked through the task without acting)
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path

_BIN_DIR = Path(__file__).resolve().parent
_PKG_PARENT = _BIN_DIR.parent
_REPO_ROOT = _PKG_PARENT.parent.parent
sys.path.insert(0, str(_PKG_PARENT))


def _load_repo_env() -> None:
    env = _REPO_ROOT / ".env"
    if not env.is_file():
        return
    for raw in env.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        k = k.strip()
        v = v.strip().strip('"').strip("'")
        if k and v and not os.environ.get(k):
            os.environ[k] = v


_load_repo_env()

from agentic_harness import (  # noqa: E402 — needs env + sys.path set up first
    InvocationStatus,
    ToolRegistry,
    ToolService,
    UnknownToolError,
)


def main() -> int:
    parser = argparse.ArgumentParser(prog="ask.py", description=__doc__)
    parser.add_argument(
        "prompt",
        help="Plain-language description of what you want done.",
    )
    parser.add_argument(
        "--max-turns", type=int, default=80,
        help="Max LLM turns for the agent loop (default: 80).",
    )
    parser.add_argument(
        "--register", action="append", default=None, metavar="TOOL_NAME",
        help="Restrict the registered custom tools to this list. "
             "Default: register ALL tools from the registry. Repeatable.",
    )
    args = parser.parse_args()

    registry = ToolRegistry()
    try:
        custom_tools = _resolve_custom_tools(registry, args.register)
    except UnknownToolError as exc:
        print(f"ask: {exc}", file=sys.stderr)
        return 2

    service = ToolService()
    result = asyncio.run(service.invoke_via_free_agent(
        args.prompt,
        custom_tools=custom_tools,
        max_turns=args.max_turns,
    ))

    print(
        f"\n[ask] ok={result.ok} status={result.status.value} "
        f"tool_calls={result.tool_calls}",
        flush=True,
    )
    if result.status is InvocationStatus.NOT_INVOKED:
        return 2
    return 0 if result.ok else 1


def _resolve_custom_tools(registry: ToolRegistry, requested: list[str] | None) -> list:
    """Load tools to register with the agent. None ⇒ load everything."""
    names = requested if requested else registry.list_tools()
    tools = []
    for name in names:
        tool, _args_cls = registry.load(name)
        tools.append(tool)
    return tools


if __name__ == "__main__":
    sys.exit(main())
