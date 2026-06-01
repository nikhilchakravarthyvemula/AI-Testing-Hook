"""Vue Router extractor — declaration-based, routes only."""

from __future__ import annotations

import re
from pathlib import Path

from .....models import DiscoveryTier, UIRoute
from ...framework_port import Extractor, ExtractionOutput
from .._shared.provenance import provenance
from .._shared.route_output import _extract_dynamic_params


_SOURCE_EXTS = frozenset({".ts", ".js", ".mjs", ".vue"})
_IMPORT_MARKER_RE = re.compile(r"""from\s+["']vue-router["']""")
_FACTORY_MARKER_RE = re.compile(r"""\bcreateRouter\s*\(|new\s+VueRouter\s*\(""")
_OBJECT_PATH_RE = re.compile(r"""\bpath\s*:\s*["']([^"'{}]+)["']""")
_CATCHALL_RE = re.compile(r"\([^)]*\)\*?$|\*$")


class VueRouterExtractor:
    """Vue Router routes only."""

    name: str = "vue_router"
    discovery_tier: DiscoveryTier = DiscoveryTier.CODE_REGEX
    file_globs: tuple[str, ...] = ("*.ts", "*.js", "*.mjs", "*.vue")

    def supports(self, file: Path, content: str) -> bool:
        if file.suffix not in _SOURCE_EXTS:
            return False
        if not _IMPORT_MARKER_RE.search(content):
            return False
        return bool(_FACTORY_MARKER_RE.search(content))

    def extract(self, file: Path, content: str) -> ExtractionOutput:
        prov = provenance(
            source_file=file,
            content=content,
            discovery_tier=self.discovery_tier,
            extracted_by=self.name,
        )
        routes: list[UIRoute] = []
        seen: set[str] = set()
        for raw in _OBJECT_PATH_RE.findall(content):
            normalised = _normalise_path(raw)
            if normalised is None or normalised in seen:
                continue
            seen.add(normalised)
            routes.append(
                UIRoute(
                    path=normalised,
                    component=_path_to_component(normalised),
                    dynamic_params=_extract_dynamic_params(normalised),
                    provenance=prov,
                )
            )
        return ExtractionOutput(routes=routes)


def _normalise_path(raw: str) -> str | None:
    raw = raw.strip()
    if not raw or _CATCHALL_RE.search(raw) or not raw.startswith("/"):
        return None
    return re.sub(r":([A-Za-z_][A-Za-z0-9_]*)", r"{\1}", raw)


_COMPONENT_CLEAN_RE = re.compile(r"[{}/\-]+")


def _path_to_component(path: str) -> str:
    if path == "/":
        return "RootPage"
    cleaned = _COMPONENT_CLEAN_RE.sub("_", path).strip("_")
    words = re.split(r"_+", cleaned)
    return "".join(w.capitalize() for w in words if w) + "Page"
