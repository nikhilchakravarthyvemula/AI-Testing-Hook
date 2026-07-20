"""Enums used throughout the agentic-harness.

Centralising string constants here prevents drift (one source of truth)
and gives the type checker something to validate against.
"""

from __future__ import annotations

from enum import StrEnum


class BackendKind(StrEnum):
    """LLM backend the harness is allowed to talk to.

    Order in `BACKEND_PRIORITY` (in `backends/catalog.py`) determines
    auto-detection priority when multiple keys are set in `.env`.
    """

    MINIMAX = "minimax"
    OPENAI = "openai"
    KIMI = "kimi"
    OLLAMA = "ollama"
    # Gemini is intentionally absent — user opted out 2026-05-20.
    # Re-add here AND lift the guards in this file's docstring path
    # if you ever want it back.


class InvocationMode(StrEnum):
    """How a tool is invoked through `ToolService`.

    DIRECT      — `tool.execute()` called by us. No LLM. Fastest, most
                  deterministic. Use when caller already knows what to run.
    AGENT       — narrow LLM agent that picks from a small set of tools.
                  Caller passes the candidate tools explicitly.
    FREE_AGENT  — open LLM agent with the full standard toolbelt
                  (bash/file/grep/glob/etc.) plus any custom tools the
                  caller registers. Multi-turn, used for orchestration.
    """

    DIRECT = "direct"
    AGENT = "agent"
    FREE_AGENT = "free-agent"


class InvocationStatus(StrEnum):
    """Final status of a tool invocation, normalised across all modes."""

    SUCCESS = "success"
    TOOL_ERROR = "tool_error"          # tool ran but reported is_error=True
    NOT_INVOKED = "not_invoked"        # agent mode: LLM never called any tool
    ENGINE_ERROR = "engine_error"      # OpenHarness raised before/during a turn
    EXCEPTION = "exception"            # Python exception bubbled out


__all__ = ["BackendKind", "InvocationMode", "InvocationStatus"]
