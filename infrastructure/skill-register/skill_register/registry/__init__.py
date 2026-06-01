"""Registry — knows where skill source files live + how to load them."""

from .skill_registry import REGISTERED_SKILLS, SkillRegistry

__all__ = ["REGISTERED_SKILLS", "SkillRegistry"]
