"""skill_register — public API for the higher-level skill-calling layer.

Mirrors agentic_harness in structure. Use:

    from skill_register import SkillService, SkillRegistry
    registry = SkillRegistry()
    skill, args_cls = registry.load("api-test-generator")
    service = SkillService()
    result = await service.invoke_direct(skill, args_cls(...))
"""

from __future__ import annotations

from .enums import SkillInvocationMode, SkillInvocationStatus
from .exceptions import (
    NoSkillInvokedError,
    SkillArgumentError,
    SkillError,
    SkillRegisterError,
    SkillSourceMissingError,
    UnknownSkillError,
)
from .interfaces import ISkill, ISkillRegistry, ISkillService
from .models import SkillDefinition, SkillInvocationResult
from .registry.skill_registry import REGISTERED_SKILLS, SkillRegistry
from .services.skill_service import SkillService

__all__ = [
    "SkillService", "SkillRegistry",
    "SkillDefinition", "SkillInvocationResult",
    "SkillInvocationMode", "SkillInvocationStatus",
    "ISkill", "ISkillRegistry", "ISkillService",
    "SkillRegisterError",
    "SkillError", "UnknownSkillError", "SkillSourceMissingError", "SkillArgumentError",
    "NoSkillInvokedError",
    "REGISTERED_SKILLS",
]
