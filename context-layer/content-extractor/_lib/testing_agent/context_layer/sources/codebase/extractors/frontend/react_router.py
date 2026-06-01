"""React Router (v6+) extractor — declaration-based, routes only.

JSX `<Route path="...">` + object `createBrowserRouter([{ path: ... }])`.
Components live in other files; selectors and form fields aren't
populated here. Cross-file resolution is the agentic context layer.
"""

from __future__ import annotations

import re
from pathlib import Path

from .....models import DiscoveryTier, UIRoute
from ...framework_port import Extractor, ExtractionOutput
from .._shared.provenance import provenance
from .._shared.route_output import _extract_dynamic_params


_SOURCE_EXTS = frozenset({".tsx", ".jsx", ".ts", ".js"})

_IMPORT_MARKER_RE = re.compile(r"""from\s+["']react-router(?:-dom)?["']""")
_ROUTES_BLOCK_MARKER_RE = re.compile(
    r"<\s*Routes\b|createBrowserRouter\s*\(|createHashRouter\s*\(|createMemoryRouter\s*\("
)

_JSX_ROUTE_PATH_RE = re.compile(
    r"""<\s*Route\b[^>]*?\bpath\s*=\s*["']([^"'{}]+)["']""", re.DOTALL
)
_OBJECT_ROUTE_PATH_RE = re.compile(r"""\bpath\s*:\s*["']([^"'{}]+)["']""")
_SPLAT_RE = re.compile(r"\*$")


class ReactRouterExtractor:
    """React Router routes only — declaration-based."""

    name: str = "react_router"
    discovery_tier: DiscoveryTier = DiscoveryTier.CODE_REGEX
    file_globs: tuple[str, ...] = ("*.tsx", "*.jsx", "*.ts", "*.js")

    def supports(self, file: Path, content: str) -> bool:
        if file.suffix not in _SOURCE_EXTS:
            return False
        if not _IMPORT_MARKER_RE.search(content):
            return False
        return bool(_ROUTES_BLOCK_MARKER_RE.search(content))

    def extract(self, file: Path, content: str) -> ExtractionOutput:
        prov = provenance(
            source_file=file,
            content=content,
            discovery_tier=self.discovery_tier,
            extracted_by=self.name,
        )
        raw_paths: list[str] = []
        raw_paths.extend(_JSX_ROUTE_PATH_RE.findall(content))
        raw_paths.extend(_OBJECT_ROUTE_PATH_RE.findall(content))

        routes: list[UIRoute] = []
        seen: set[str] = set()
        for raw in raw_paths:
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
    if not raw or _SPLAT_RE.search(raw) or not raw.startswith("/"):
        return None
    return re.sub(r":([A-Za-z_][A-Za-z0-9_]*)", r"{\1}", raw)


_COMPONENT_CLEAN_RE = re.compile(r"[{}/\-]+")


def _path_to_component(path: str) -> str:
    if path == "/":
        return "RootPage"
    cleaned = _COMPONENT_CLEAN_RE.sub("_", path).strip("_")
    words = re.split(r"_+", cleaned)
    return "".join(w.capitalize() for w in words if w) + "Page"
