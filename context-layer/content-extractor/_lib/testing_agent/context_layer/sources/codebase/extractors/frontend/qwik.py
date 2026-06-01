"""Qwik (City) extractor — `src/routes/**/index.tsx`."""

from __future__ import annotations

import re
from pathlib import Path

from .....models import DiscoveryTier
from ...framework_port import Extractor, ExtractionOutput
from .._shared.route_output import build_route_output


_PAGE_FILENAMES = frozenset({"index.tsx", "index.jsx", "index.ts", "index.js"})


class QwikExtractor:
    """Qwik City routes + interactions + form fields."""

    name: str = "qwik"
    discovery_tier: DiscoveryTier = DiscoveryTier.CODE_REGEX
    file_globs: tuple[str, ...] = ("index.tsx", "index.jsx", "index.ts", "index.js")

    def supports(self, file: Path, content: str) -> bool:
        if file.name not in _PAGE_FILENAMES:
            return False
        return "routes" in file.parts and "src" in file.parts

    def extract(self, file: Path, content: str) -> ExtractionOutput:
        path = _file_to_route(file)
        if path is None:
            return ExtractionOutput()
        return build_route_output(
            file=file,
            content=content,
            route_path=path,
            component=_component_name(file),
            extractor_name=self.name,
            discovery_tier=self.discovery_tier,
        )


def _file_to_route(file: Path) -> str | None:
    parts = list(file.parts)
    anchor: int | None = None
    for i in range(len(parts) - 1, -1, -1):
        if parts[i] == "routes":
            anchor = i
            break
    if anchor is None:
        return None

    segments = parts[anchor + 1 : -1]
    cleaned: list[str] = []
    for seg in segments:
        if seg.startswith("(") and seg.endswith(")"):
            continue
        cleaned.append(_normalise_dynamic_segment(seg))

    if not cleaned:
        return "/"
    return "/" + "/".join(cleaned)


def _normalise_dynamic_segment(seg: str) -> str:
    if seg.startswith("[...") and seg.endswith("]"):
        return "{" + seg[4:-1] + "}"
    if seg.startswith("[") and seg.endswith("]"):
        return "{" + seg[1:-1] + "}"
    return seg


def _component_name(file: Path) -> str:
    parent = file.parent.name
    if parent == "routes":
        return "RootPage"
    cleaned = re.sub(r"[\[\]().]+", "", parent)
    words = re.split(r"[-_]+", cleaned)
    return "".join(w.capitalize() for w in words if w) + "Page"
