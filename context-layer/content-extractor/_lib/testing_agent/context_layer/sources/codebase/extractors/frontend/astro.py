"""Astro extractor — `src/pages/**/*.astro`."""

from __future__ import annotations

import re
from pathlib import Path

from .....models import DiscoveryTier
from ...framework_port import Extractor, ExtractionOutput
from .._shared.route_output import build_route_output


_FRONTMATTER_RE = re.compile(r"^---\s*\n.*?\n---\s*\n", re.DOTALL)


class AstroExtractor:
    """Astro routes + interactions + form fields."""

    name: str = "astro"
    discovery_tier: DiscoveryTier = DiscoveryTier.CODE_REGEX
    file_globs: tuple[str, ...] = ("*.astro",)

    def supports(self, file: Path, content: str) -> bool:
        if file.suffix != ".astro":
            return False
        return "pages" in file.parts and "src" in file.parts

    def extract(self, file: Path, content: str) -> ExtractionOutput:
        path = _file_to_route(file)
        if path is None:
            return ExtractionOutput()
        body = _FRONTMATTER_RE.sub("", content, count=1)
        return build_route_output(
            file=file,
            content=content,
            markup=body,
            route_path=path,
            component=_component_name(file),
            extractor_name=self.name,
            discovery_tier=self.discovery_tier,
        )


def _file_to_route(file: Path) -> str | None:
    parts = list(file.parts)
    anchor: int | None = None
    for i in range(len(parts) - 1, -1, -1):
        if parts[i] == "pages":
            anchor = i
            break
    if anchor is None:
        return None
    segments = [_normalise_dynamic_segment(s) for s in parts[anchor + 1 : -1]]
    stem = file.stem
    if stem != "index":
        segments.append(_normalise_dynamic_segment(stem))
    if not segments:
        return "/"
    return "/" + "/".join(segments)


def _normalise_dynamic_segment(seg: str) -> str:
    if seg.startswith("[...") and seg.endswith("]"):
        return "{" + seg[4:-1] + "}"
    if seg.startswith("[") and seg.endswith("]"):
        return "{" + seg[1:-1] + "}"
    return seg


def _component_name(file: Path) -> str:
    stem = file.stem
    cleaned = re.sub(r"[\[\].]+", "", stem)
    parent = file.parent.name
    if parent and parent != "pages":
        parent_cleaned = re.sub(r"[\[\].]+", "", parent)
        base = f"{parent_cleaned}_{cleaned}"
    else:
        base = cleaned
    words = re.split(r"[-_]+", base)
    return "".join(w.capitalize() for w in words if w) + "Page"
