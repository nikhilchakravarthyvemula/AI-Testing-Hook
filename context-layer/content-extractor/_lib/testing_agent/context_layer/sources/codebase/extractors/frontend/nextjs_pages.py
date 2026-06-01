"""Next.js Pages Router extractor — `pages/**/*.{tsx,jsx,ts,js}`."""

from __future__ import annotations

import re
from pathlib import Path

from .....models import DiscoveryTier
from ...framework_port import Extractor, ExtractionOutput
from .._shared.route_output import build_route_output


_PAGE_EXTS = frozenset({".tsx", ".jsx", ".ts", ".js"})
_FRAMEWORK_HOOKS = frozenset({"_app", "_document", "_error", "404", "500"})


class NextJSPagesExtractor:
    """Next.js Pages Router routes + interactions + form fields."""

    name: str = "nextjs_pages"
    discovery_tier: DiscoveryTier = DiscoveryTier.CODE_REGEX
    file_globs: tuple[str, ...] = ("*.tsx", "*.jsx", "*.ts", "*.js")

    def supports(self, file: Path, content: str) -> bool:
        if file.suffix not in _PAGE_EXTS:
            return False
        parts = file.parts
        if "pages" not in parts:
            return False
        anchor = max(i for i, p in enumerate(parts) if p == "pages")
        rel = parts[anchor + 1 : -1]
        if rel and rel[0] == "api":
            return False
        if file.stem in _FRAMEWORK_HOOKS:
            return False
        if file.name.startswith("_"):
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
    anchor = max((i for i, p in enumerate(parts) if p == "pages"), default=None)
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
    if seg.startswith("[[...") and seg.endswith("]]"):
        return "{" + seg[5:-2] + "}"
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
