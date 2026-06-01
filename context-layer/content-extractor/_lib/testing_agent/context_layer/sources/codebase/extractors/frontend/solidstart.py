"""SolidStart extractor — `src/routes/**/*.{tsx,jsx,ts,js}`."""

from __future__ import annotations

import re
from pathlib import Path

from .....models import DiscoveryTier
from ...framework_port import Extractor, ExtractionOutput
from .._shared.route_output import build_route_output


_PAGE_EXTS = frozenset({".tsx", ".jsx", ".ts", ".js"})


class SolidStartExtractor:
    """SolidStart routes + interactions + form fields."""

    name: str = "solidstart"
    discovery_tier: DiscoveryTier = DiscoveryTier.CODE_REGEX
    file_globs: tuple[str, ...] = ("*.tsx", "*.jsx", "*.ts", "*.js")

    def supports(self, file: Path, content: str) -> bool:
        if file.suffix not in _PAGE_EXTS:
            return False
        parts = file.parts
        if "routes" not in parts or "src" not in parts:
            return False
        if any(file.stem.endswith(suffix) for suffix in (".test", ".spec", ".d")):
            return False
        return True

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
    segments = [_normalise_dynamic_segment(s) for s in parts[anchor + 1 : -1]]
    stem = file.stem
    if stem != "index":
        segments.append(_normalise_dynamic_segment(stem))
    segments = [s for s in segments if not (s.startswith("(") and s.endswith(")"))]
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
    if parent and parent != "routes":
        parent_cleaned = re.sub(r"[\[\]().]+", "", parent)
        base = f"{parent_cleaned}_{cleaned}"
    else:
        base = cleaned
    words = re.split(r"[-_]+", base)
    return "".join(w.capitalize() for w in words if w) + "Page"
