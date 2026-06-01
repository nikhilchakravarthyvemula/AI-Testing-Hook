"""SvelteKit extractor — `**/routes/**/+page.svelte`."""

from __future__ import annotations

import re
from pathlib import Path

from .....models import DiscoveryTier
from ...framework_port import Extractor, ExtractionOutput
from .._shared.route_output import build_route_output


_PAGE_FILENAME = "+page.svelte"
_SCRIPT_BLOCK_RE = re.compile(r"<script\b[^>]*>.*?</script>", re.DOTALL)


class SvelteKitExtractor:
    """SvelteKit routes + interactions + form fields."""

    name: str = "sveltekit"
    discovery_tier: DiscoveryTier = DiscoveryTier.CODE_REGEX
    file_globs: tuple[str, ...] = ("+page.svelte",)

    def supports(self, file: Path, content: str) -> bool:
        return file.name == _PAGE_FILENAME and "routes" in file.parts

    def extract(self, file: Path, content: str) -> ExtractionOutput:
        path = _file_to_route(file)
        if path is None:
            return ExtractionOutput()
        markup = _SCRIPT_BLOCK_RE.sub("", content)
        return build_route_output(
            file=file,
            content=content,
            markup=markup,
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
    if seg.startswith("[[") and seg.endswith("]]"):
        inner = seg[2:-2]
        return "{" + inner.split("=", 1)[0] + "}"
    if seg.startswith("[...") and seg.endswith("]"):
        return "{" + seg[4:-1] + "}"
    if seg.startswith("[") and seg.endswith("]"):
        inner = seg[1:-1]
        return "{" + inner.split("=", 1)[0] + "}"
    return seg


def _component_name(file: Path) -> str:
    parent = file.parent.name
    if parent == "routes":
        return "RootPage"
    cleaned = re.sub(r"[\[\]().=]+", "", parent)
    words = re.split(r"[-_]+", cleaned)
    return "".join(w.capitalize() for w in words if w) + "Page"
