"""Structural interfaces (Protocols) the skill-register components implement.

A skill is anything with `name`, `execute(args)`. The args are a
pydantic model the skill itself defines (via SkillDefinition.args_class).

Skills should be SELF-CONTAINED — they may call out to other services
(agentic-harness, indexed_output, …) but the interface contract is
just "give me args, I'll give you a result".
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Protocol, runtime_checkable

from .models import SkillDefinition, SkillInvocationResult


@runtime_checkable
class ISkill(Protocol):
    """The minimum a skill needs to be invokable by SkillService."""

    name: str

    async def execute(self, args: Any) -> Any:
        """Run the skill. Returns a per-skill result object (typically a
        pydantic model). SkillService normalises into SkillInvocationResult."""
        ...


@runtime_checkable
class ISkillRegistry(Protocol):
    """Knows where skill source files live and how to instantiate them."""

    def list_skills(self) -> list[str]: ...
    def get_definition(self, name: str) -> SkillDefinition: ...
    def load(self, name: str) -> tuple[ISkill, type]: ...


@runtime_checkable
class ISkillService(Protocol):
    """The seam every consumer should use to call a skill."""

    async def invoke_direct(self, skill: ISkill, args: Any) -> SkillInvocationResult: ...


__all__ = ["ISkill", "ISkillRegistry", "ISkillService"]
