"""Preact Router extractor — `<Router>` from `preact-router`."""

from __future__ import annotations

import re
from pathlib import Path

from .....models import DiscoveryTier, UIRoute
from ...framework_port import Extractor, ExtractionOutput
from .._shared.provenance import provenance
from .._shared.route_output import _extract_dynamic_params


_SOURCE_EXTS = frozenset({".tsx", ".jsx", ".ts", ".js"})
_IMPORT_MARKER_RE = re.compile(r"""from\s+["']preact-router(?:/match)?["']""")
_ROUTER_BLOCK_RE = re.compile(r"<\s*Router\b")

_CHILD_PATH_RE = re.compile(
    r"""<\s*(?P<comp>[A-Z][A-Za-z0-9_]*)
        \b[^>]*?
        \bpath\s*=\s*["'](?P<path>[^"']+)["']
    """,
    re.VERBOSE | re.DOTALL,
)


class PreactRouterExtractor:
    """Preact Router routes only."""

    name: str = "preact_router"
    discovery_tier: DiscoveryTier = DiscoveryTier.CODE_REGEX
    file_globs: tuple[str, ...] = ("*.tsx", "*.jsx", "*.ts", "*.js")

    def supports(self, file: Path, content: str) -> bool:
        if file.suffix not in _SOURCE_EXTS:
            return False
        if not _IMPORT_MARKER_RE.search(content):
            return False
        return bool(_ROUTER_BLOCK_RE.search(content))

    def extract(self, file: Path, content: str) -> ExtractionOutput:
        prov = provenance(
            source_file=file,
            content=content,
            discovery_tier=self.discovery_tier,
            extracted_by=self.name,
        )
        routes: list[UIRoute] = []
        seen: set[str] = set()
        for match in _CHILD_PATH_RE.finditer(content):
            raw = match.group("path")
            normalised = _normalise_path(raw)
            if normalised is None or normalised in seen:
                continue
            seen.add(normalised)
            routes.append(
                UIRoute(
                    path=normalised,
                    component=match.group("comp"),
                    dynamic_params=_extract_dynamic_params(normalised),
                    provenance=prov,
                )
            )
        return ExtractionOutput(routes=routes)


def _normalise_path(raw: str) -> str | None:
    raw = raw.strip()
    if not raw or not raw.startswith("/"):
        return None
    return re.sub(r":([A-Za-z_][A-Za-z0-9_]*)", r"{\1}", raw)
