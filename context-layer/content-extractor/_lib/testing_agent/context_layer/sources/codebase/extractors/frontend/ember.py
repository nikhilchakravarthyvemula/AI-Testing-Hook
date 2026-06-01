"""Ember Router extractor — `Router.map(function() { ... })`."""

from __future__ import annotations

import re
from pathlib import Path

from .....models import DiscoveryTier, UIRoute
from ...framework_port import Extractor, ExtractionOutput
from .._shared.provenance import provenance
from .._shared.route_output import _extract_dynamic_params


_MAP_MARKER_RE = re.compile(r"\bRouter\.map\s*\(\s*function")

_ROUTE_CALL_RE = re.compile(
    r"""this\.route\s*\(
        \s*['"](?P<name>[^'"]+)['"]
        (?:\s*,\s*\{\s*[^}]*?
            \bpath\s*:\s*['"](?P<path>[^'"]+)['"]
            [^}]*\})?
    """,
    re.VERBOSE | re.DOTALL,
)


class EmberExtractor:
    """Ember Router routes only."""

    name: str = "ember"
    discovery_tier: DiscoveryTier = DiscoveryTier.CODE_REGEX
    file_globs: tuple[str, ...] = ("router.js", "router.ts")

    def supports(self, file: Path, content: str) -> bool:
        if file.name not in ("router.js", "router.ts"):
            return False
        return bool(_MAP_MARKER_RE.search(content))

    def extract(self, file: Path, content: str) -> ExtractionOutput:
        prov = provenance(
            source_file=file,
            content=content,
            discovery_tier=self.discovery_tier,
            extracted_by=self.name,
        )
        routes: list[UIRoute] = []
        seen: set[str] = set()
        for match in _ROUTE_CALL_RE.finditer(content):
            name = match.group("name")
            explicit_path = match.group("path")
            raw_path = explicit_path if explicit_path else "/" + name
            normalised = _normalise_path(raw_path)
            if normalised is None or normalised in seen:
                continue
            seen.add(normalised)
            routes.append(
                UIRoute(
                    path=normalised,
                    component=_name_to_component(name),
                    dynamic_params=_extract_dynamic_params(normalised),
                    provenance=prov,
                )
            )
        return ExtractionOutput(routes=routes)


def _normalise_path(raw: str) -> str | None:
    raw = raw.strip()
    if not raw:
        return None
    if not raw.startswith("/"):
        raw = "/" + raw
    return re.sub(r":([A-Za-z_][A-Za-z0-9_]*)", r"{\1}", raw)


def _name_to_component(name: str) -> str:
    words = re.split(r"[-_./]+", name)
    return "".join(w.capitalize() for w in words if w) + "Route"
