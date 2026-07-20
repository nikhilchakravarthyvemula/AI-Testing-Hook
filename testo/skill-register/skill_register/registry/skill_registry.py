"""SkillRegistry — maps skill names → loaded (skill_instance, args_class).

Pattern mirrors agentic_harness.registry.tool_registry. Add a row to
REGISTERED_SKILLS to expose a new skill.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from typing import Any

from ..exceptions import SkillSourceMissingError, UnknownSkillError
from ..interfaces import ISkill
from ..models import SkillDefinition


# Resolve repo root so source_path entries can be repo-relative.
# This file: <repo>/testo/skill-register/skill_register/registry/skill_registry.py
#   parents: [0]=registry/ [1]=skill_register/ [2]=skill-register/ [3]=testo/ [4]=<repo>
_REPO_ROOT = Path(__file__).resolve().parents[4]


# ── catalog — add a row here to expose a new skill ────────────────────────

REGISTERED_SKILLS: dict[str, SkillDefinition] = {
    "api-test-generator": SkillDefinition(
        name="api-test-generator",
        source_path=Path("generation-layer/api-test-generator/skill.py"),
        skill_class="ApiTestGeneratorSkill",
        args_class="ApiTestGeneratorArgs",
        summary="Build + run curl-based API tests from indexed_output/apis.json. "
                "Logs in first, captures token, runs remaining APIs with auth.",
        layer="generation",
    ),
}


class SkillRegistry:
    """Implements `ISkillRegistry`. Loads skill classes from source files."""

    def __init__(self, catalog: dict[str, SkillDefinition] | None = None) -> None:
        self._catalog = catalog or REGISTERED_SKILLS

    # ── public ────────────────────────────────────────────────────────────

    def list_skills(self) -> list[str]:
        """Names of every registered skill, sorted."""
        return sorted(self._catalog.keys())

    def get_definition(self, name: str) -> SkillDefinition:
        try:
            return self._catalog[name]
        except KeyError as exc:
            raise UnknownSkillError(
                f"Unknown skill {name!r}. Registered: {self.list_skills()}"
            ) from exc

    def load(self, name: str) -> tuple[ISkill, type]:
        """Return (skill_instance, args_class). Raises on unknown or missing source."""
        definition = self.get_definition(name)
        source_path = _REPO_ROOT / definition.source_path
        if not source_path.exists():
            raise SkillSourceMissingError(
                f"Skill {name!r} source missing at {source_path}"
            )

        module = self._import_source_file(name, source_path)
        skill_cls = getattr(module, definition.skill_class)
        args_cls = getattr(module, definition.args_class)
        return skill_cls(), args_cls

    # ── internals ─────────────────────────────────────────────────────────

    @staticmethod
    def _import_source_file(name: str, path: Path) -> Any:
        """Load a Python file at `path` under a synthetic module name."""
        parent = str(path.parent)
        if parent not in sys.path:
            sys.path.insert(0, parent)

        spec = importlib.util.spec_from_file_location(f"_sr_skill_{name}", path)
        if spec is None or spec.loader is None:
            raise ImportError(f"Could not import skill source: {path}")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module


__all__ = ["REGISTERED_SKILLS", "SkillRegistry"]
