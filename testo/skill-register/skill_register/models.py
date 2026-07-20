"""Typed data models for skill-register.

Pydantic — same choice as agentic-harness for the same reasons
(validation at construction, JSON-friendly).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field

from .enums import SkillInvocationMode, SkillInvocationStatus


class SkillDefinition(BaseModel):
    """How a skill is described in the registry catalog.

    Source-file based — skills can live anywhere; the registry doesn't
    impose a layout. Same pattern as agentic_harness's ToolDefinition.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    name: str = Field(..., description="LLM-callable id, e.g. 'api-test-generator'.")
    source_path: Path = Field(..., description="Path to the file that declares the skill class.")
    skill_class: str = Field(..., description="Class name of the ISkill implementation.")
    args_class: str = Field(..., description="Class name of the pydantic args model.")
    summary: str = Field(default="", description="One-line description shown in CLI help.")
    layer: str = Field(default="", description="Architecture layer ('generation', 'context', 'execution', ...).")


class SkillInvocationResult(BaseModel):
    """Outcome of one SkillService.invoke_* call.

    Same shape regardless of mode — callers branch on `.ok` / `.status`,
    never on which mode was used.
    """

    model_config = ConfigDict(extra="forbid")

    ok: bool
    mode: SkillInvocationMode
    status: SkillInvocationStatus
    output: Optional[str] = None
    metadata: dict[str, Any] = Field(default_factory=dict)

    def __bool__(self) -> bool:
        return self.ok


__all__ = ["SkillDefinition", "SkillInvocationResult"]
