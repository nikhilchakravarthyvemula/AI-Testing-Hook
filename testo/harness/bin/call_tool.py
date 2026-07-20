#!/usr/bin/env python
"""Internal plumbing CLI — invoke a registered tool through ToolService.

This is for INTERNAL callers (testo scan, smoke tests) that know exactly
which tool + which arguments they want. End-users should prefer
`testo ask "..."`, which routes through `ask.py` and never asks for a
tool name.

Usage:
    python call_tool.py <TOOL> [--mode {direct,agent,free-agent}] [--<arg> <value>] ...
    python call_tool.py --free --mode free-agent --prompt "..."

Modes:
    direct      — call tool.execute() ourselves (default). Fastest, deterministic.
    agent       — LLM picks the (one) tool from --prompt.
    free-agent  — LLM with full toolbelt + multi-turn reasoning.

Exit codes:
    0 — tool ran and reported success
    1 — tool ran and reported error
    2 — tool failed to start (unknown tool, bad args, etc.)
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path

# Make `testo/harness/` importable so `agentic_harness` resolves.
_BIN_DIR = Path(__file__).resolve().parent
_PKG_PARENT = _BIN_DIR.parent  # testo/harness/
_REPO_ROOT = _PKG_PARENT.parent.parent
sys.path.insert(0, str(_PKG_PARENT))


def _load_repo_env() -> None:
    """Auto-load <repo>/.env so MINIMAX_API_KEY etc. are in process env."""
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
    AgenticHarness,
    InvocationMode,
    ToolArgumentError,
    ToolRegistry,
    ToolService,
    ToolSourceMissingError,
    UnknownToolError,
)


# ── argparse setup ────────────────────────────────────────────────────────


def _build_parser(registry: ToolRegistry) -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="call_tool.py", description=__doc__)
    parser.add_argument(
        "tool",
        nargs="?",
        default=None,
        help=f"Registered tool name (one of: {', '.join(registry.list_tools())}). "
             f"Omit + use --free for free-agent mode with no custom tools.",
    )
    parser.add_argument(
        "--free", action="store_true",
        help="Free-agent mode with no preregistered custom tools. "
             "Use instead of a tool name when you just want bash/file/grep.",
    )
    parser.add_argument(
        "--mode",
        choices=tuple(m.value for m in InvocationMode),
        default=InvocationMode.DIRECT.value,
        help="direct (default) | agent | free-agent",
    )
    parser.add_argument(
        "--prompt", default=None,
        help="(agent / free-agent mode only) free-text instruction for the LLM.",
    )
    parser.add_argument(
        "--max-turns", type=int, default=80,
        help="(free-agent mode only) max LLM turns. Default 80.",
    )
    return parser


def _validate_args(known: argparse.Namespace, registry: ToolRegistry) -> tuple[bool, str | None]:
    """Return (ok, error_message) for the parsed args + chosen mode."""
    if not known.tool and not known.free:
        return False, "provide a tool name OR --free"
    if known.tool and known.tool not in registry.list_tools():
        return False, f"unknown tool '{known.tool}'. Registered: {registry.list_tools()}"
    mode = InvocationMode(known.mode)
    if mode is InvocationMode.DIRECT and not known.tool:
        return False, "--mode direct requires a tool name (no LLM to pick one)"
    if mode in (InvocationMode.AGENT, InvocationMode.FREE_AGENT) and not known.prompt:
        return False, f"--mode {mode.value} requires --prompt"
    return True, None


def _parse_tool_args(extras: list[str]) -> dict:
    """Parse forwarded `--key value` pairs from argv tail into a dict."""
    out: dict = {}
    i = 0
    while i < len(extras):
        token = extras[i]
        if not token.startswith("--"):
            raise SystemExit(f"call_tool: unexpected positional arg: {token!r}")
        key = token[2:]
        if i + 1 >= len(extras) or extras[i + 1].startswith("--"):
            out[key] = True
            i += 1
        else:
            out[key] = extras[i + 1]
            i += 2
    return out


# ── dispatch ──────────────────────────────────────────────────────────────


def main() -> int:
    registry = ToolRegistry()
    parser = _build_parser(registry)
    known, extras = parser.parse_known_args()

    ok, err = _validate_args(known, registry)
    if not ok:
        print(f"call_tool: {err}", file=sys.stderr)
        return 2

    tool_args = _parse_tool_args(extras)

    # Load the named tool if any (free-agent --free doesn't require one).
    tool = args_cls = None
    if known.tool:
        try:
            tool, args_cls = registry.load(known.tool)
        except (UnknownToolError, ToolSourceMissingError) as exc:
            print(f"call_tool: {exc}", file=sys.stderr)
            return 2

    mode = InvocationMode(known.mode)

    if mode is InvocationMode.DIRECT:
        try:
            args_obj = args_cls(**tool_args)
        except Exception as exc:  # noqa: BLE001 — pydantic ValidationError, etc.
            print(f"call_tool: bad args for {known.tool}: {exc}", file=sys.stderr)
            raise ToolArgumentError(str(exc)) from None  # type: ignore[unreachable]
        service = ToolService()
        result = asyncio.run(service.invoke_direct(tool, args_obj))

    elif mode is InvocationMode.AGENT:
        harness = AgenticHarness()
        service = ToolService(harness=harness)
        result = asyncio.run(service.invoke_via_agent(known.prompt, tools=[tool]))

    else:  # FREE_AGENT
        service = ToolService()
        custom = [tool] if tool else []
        result = asyncio.run(service.invoke_via_free_agent(
            known.prompt, custom_tools=custom, max_turns=known.max_turns,
        ))

    print(
        f"\n[call_tool] mode={result.mode.value} ok={result.ok} "
        f"status={result.status.value} tool_calls={result.tool_calls}",
        flush=True,
    )
    return 0 if result.ok else 1


if __name__ == "__main__":
    sys.exit(main())
