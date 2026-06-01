"""Exception hierarchy for skill-register.

Single root (`SkillRegisterError`) so callers can `except SkillRegisterError`
to catch anything from this package.
"""

from __future__ import annotations


class SkillRegisterError(Exception):
    """Base class for every error raised by the skill-register package."""


class SkillError(SkillRegisterError):
    """A skill couldn't be loaded or didn't behave as expected."""


class UnknownSkillError(SkillError):
    """The registry has no entry under this name."""


class SkillSourceMissingError(SkillError):
    """The file the registry points to doesn't exist on disk."""


class SkillArgumentError(SkillError):
    """Args passed to a skill failed validation (typically pydantic)."""


class NoSkillInvokedError(SkillRegisterError):
    """Agent mode finished without ever calling a skill."""


__all__ = [
    "SkillRegisterError",
    "SkillError", "UnknownSkillError", "SkillSourceMissingError", "SkillArgumentError",
    "NoSkillInvokedError",
]
