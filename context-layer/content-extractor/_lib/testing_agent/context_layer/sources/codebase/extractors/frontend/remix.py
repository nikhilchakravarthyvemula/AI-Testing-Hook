"""Remix extractor — `app/routes/**/*.{tsx,jsx,ts,js}` flat-v2 convention."""

from __future__ import annotations

import re
from pathlib import Path

from .....models import DiscoveryTier
from ...framework_port import Extractor, ExtractionOutput
from .._shared.route_output import build_route_output


_PAGE_EXTS = frozenset({".tsx", ".jsx", ".ts", ".js"})


class RemixExtractor:
    """Remix routes + interactions + form fields."""

    name: str = "remix"
    discovery_tier: DiscoveryTier = DiscoveryTier.CODE_REGEX
    file_globs: tuple[str, ...] = ("*.tsx", "*.jsx", "*.ts", "*.js")

    def supports(self, file: Path, content: str) -> bool:
        if file.suffix not in _PAGE_EXTS:
            return False
        parts = file.parts
        return "routes" in parts and "app" in parts

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

    raw_segments = parts[anchor + 1 :]
    if raw_segments and raw_segments[-1].split(".")[0] == "route":
        raw_segments = raw_segments[:-1]
    else:
        last = raw_segments[-1]
        last = last.rsplit(".", 1)[0]
        raw_segments = list(raw_segments[:-1]) + [last]

    if any(seg == "$" for seg in raw_segments):
        return None

    flat_segments: list[str] = []
    for seg in raw_segments:
        if "." in seg:
            for part in seg.split("."):
                flat_segments.append(part)
        else:
            flat_segments.append(seg)

    cleaned: list[str] = []
    for s in flat_segments:
        if s == "_index":
            continue
        if s.startswith("_"):
            continue
        if s.startswith("$"):
            cleaned.append("{" + s[1:] + "}")
        else:
            cleaned.append(s)

    if not cleaned:
        return "/"
    return "/" + "/".join(cleaned)


def _component_name(file: Path) -> str:
    raw = file.stem
    cleaned = re.sub(r"[\$._]", "_", raw).strip("_")
    words = re.split(r"_+", cleaned)
    if not words or words == [""]:
        return "RootPage"
    return "".join(w.capitalize() for w in words if w) + "Page"
