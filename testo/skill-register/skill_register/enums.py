"""Enums used across the skill-register service layer.

Mirrors the retired agentic_harness enums (spec-13) — kept so callers share
the direct/agent invocation mental model, so the surface shapes match.
"""

from __future__ import annotations

from enum import StrEnum


class SkillInvocationMode(StrEnum):
    """How a skill is invoked through `SkillService`.

    DIRECT — caller already knows the skill + args, no LLM in the loop.
    AGENT  — LLM picks WHICH registered skill to call from a free-text
             prompt (analogous to ToolService.invoke_via_agent).

    `free-agent` mode from the tool-side doesn't have a direct analog
    here yet — skills are typically chosen explicitly. Add it when a
    real use case shows up.
    """

    DIRECT = "direct"
    AGENT = "agent"


class SkillInvocationStatus(StrEnum):
    """Final status of a skill invocation, normalised across modes."""

    SUCCESS = "success"
    SKILL_ERROR = "skill_error"        # skill ran but reported failure
    NOT_INVOKED = "not_invoked"        # agent mode: LLM never called a skill
    ENGINE_ERROR = "engine_error"      # underlying harness raised
    EXCEPTION = "exception"            # Python exception bubbled out


__all__ = ["SkillInvocationMode", "SkillInvocationStatus"]
