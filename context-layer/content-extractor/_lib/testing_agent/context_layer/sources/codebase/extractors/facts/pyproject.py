"""`pyproject.toml` fact extractor.

Reads dependencies + project metadata. Emits:
  * `backend_framework` — fastapi | flask | django | starlette
  * `python_version` — from `requires-python`
  * `package_manager` — heuristic from `[tool.poetry]` / `[tool.hatch]` / `[tool.uv]`
"""

from __future__ import annotations

import re
from pathlib import Path

try:
    import tomllib  # type: ignore[import-not-found]
except ImportError:  # Python 3.10 / 3.9 — pyproject toml on the fallback shelf.
    import tomli as tomllib  # type: ignore[no-redef]

from .....models import DiscoveryTier, FrameworkFact
from ...framework_port import Extractor, ExtractionOutput
from .._shared.provenance import provenance


_BACKEND_PRIORITY: tuple[tuple[str, str], ...] = (
    ("fastapi", "fastapi"),
    ("starlette", "starlette"),
    ("django", "django"),
    ("flask", "flask"),
    ("bottle", "bottle"),
    ("pyramid", "pyramid"),
    ("tornado", "tornado"),
    ("aiohttp", "aiohttp"),
)
_TEST_FRAMEWORKS = ("pytest", "unittest", "nose2", "hypothesis", "playwright")
_DEP_NAME_RE = re.compile(r"^([A-Za-z0-9_.\-]+)")


class PyProjectFactsExtractor:
    """Facts from `pyproject.toml`."""

    name: str = "pyproject_facts"
    discovery_tier: DiscoveryTier = DiscoveryTier.AST
    file_globs: tuple[str, ...] = ("pyproject.toml",)

    def supports(self, file: Path, content: str) -> bool:
        return file.name == "pyproject.toml"

    def extract(self, file: Path, content: str) -> ExtractionOutput:
        try:
            doc = tomllib.loads(content)
        except Exception:  # noqa: BLE001 — malformed toml not fatal
            return ExtractionOutput()

        prov = provenance(
            source_file=file,
            content=content,
            discovery_tier=self.discovery_tier,
            extracted_by=self.name,
        )

        all_deps = _collect_deps(doc)
        facts: list[FrameworkFact] = []

        # Primary backend framework.
        primary: str | None = None
        for dep_name, label in _BACKEND_PRIORITY:
            if dep_name in all_deps:
                if primary is None:
                    primary = label
                    facts.append(FrameworkFact(
                        kind="backend_framework",
                        key=label,
                        value=all_deps[dep_name],
                        provenance=prov,
                    ))
                else:
                    facts.append(FrameworkFact(
                        kind="framework_dep",
                        key=label,
                        value=all_deps[dep_name],
                        provenance=prov,
                    ))

        for tf in _TEST_FRAMEWORKS:
            if tf in all_deps:
                facts.append(FrameworkFact(
                    kind="test_framework", key=tf, value=all_deps[tf], provenance=prov,
                ))

        # Python version.
        requires = doc.get("project", {}).get("requires-python")
        if isinstance(requires, str):
            facts.append(FrameworkFact(
                kind="python_version_constraint",
                key="requires-python",
                value=requires,
                provenance=prov,
            ))

        # Package manager — best-effort by presence of tool tables.
        tool = doc.get("tool", {})
        if isinstance(tool, dict):
            for pm_key in ("poetry", "hatch", "uv", "pdm", "rye"):
                if pm_key in tool:
                    facts.append(FrameworkFact(
                        kind="package_manager", key=pm_key, provenance=prov,
                    ))

        return ExtractionOutput(framework_facts=facts)


def _collect_deps(doc: dict) -> dict[str, str]:
    """Pull deps from `project.dependencies`, `optional-dependencies`,
    Poetry's `tool.poetry.dependencies`. Returns `{name: version_spec}`.
    """
    out: dict[str, str] = {}
    project = doc.get("project")
    if isinstance(project, dict):
        for entry in project.get("dependencies", []) or []:
            if isinstance(entry, str):
                _record_dep(out, entry)
        for group in (project.get("optional-dependencies") or {}).values():
            for entry in group:
                if isinstance(entry, str):
                    _record_dep(out, entry)

    tool_poetry = doc.get("tool", {}).get("poetry", {}).get("dependencies", {})
    if isinstance(tool_poetry, dict):
        for name, spec in tool_poetry.items():
            if name == "python":
                continue
            if isinstance(spec, str):
                out[name] = spec
            elif isinstance(spec, dict) and "version" in spec:
                out[name] = str(spec["version"])

    return out


def _record_dep(out: dict[str, str], raw: str) -> None:
    raw = raw.strip()
    if not raw or raw.startswith("#"):
        return
    m = _DEP_NAME_RE.match(raw)
    if not m:
        return
    name = m.group(1).lower()
    version = raw[m.end():].strip(" ,") or ""
    out[name] = version
