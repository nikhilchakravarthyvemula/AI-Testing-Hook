"""Next.js App Router extractor — `app/**/page.{tsx,jsx,ts,js}`.

Conventions (Next.js 13+):
  * `app/page.tsx`                   → `/`
  * `app/dashboard/page.tsx`         → `/dashboard`
  * `app/users/[id]/page.tsx`        → `/users/{id}`
  * `app/users/[...slug]/page.tsx`   → `/users/{slug}`        (catch-all)
  * `app/users/[[...slug]]/page.tsx` → `/users/{slug}`        (optional)
  * `app/(marketing)/page.tsx`       → `/`                     (route group)
  * `app/_components/...`            → skipped (private dir)
"""

from __future__ import annotations

import re
from pathlib import Path

from .....models import DiscoveryTier
from ...framework_port import Extractor, ExtractionOutput
from .._shared.route_output import build_route_output


_APP_PAGE_NAMES = frozenset({"page.tsx", "page.jsx", "page.ts", "page.js"})


class NextJSAppExtractor:
    """Next.js App Router routes + interactions + form fields."""

    name: str = "nextjs_app"
    discovery_tier: DiscoveryTier = DiscoveryTier.CODE_REGEX
    file_globs: tuple[str, ...] = ("page.tsx", "page.jsx", "page.ts", "page.js")

    def supports(self, file: Path, content: str) -> bool:
        if file.name not in _APP_PAGE_NAMES:
            return False
        return "app" in file.parts

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


# ── helpers ────────────────────────────────────────────────────────────────


def _file_to_route(file: Path) -> str | None:
    """Convert `app/foo/[id]/page.tsx` → `/foo/{id}`. None if no `app/` anchor."""
    parts = list(file.parts)
    anchor: int | None = None
    for i in range(len(parts) - 1, -1, -1):
        if parts[i] == "app":
            anchor = i
            break
    if anchor is None:
        return None

    segments = parts[anchor + 1 : -1]
    cleaned: list[str] = []
    for seg in segments:
        if seg.startswith("_"):
            return None  # private dir → not a route
        if seg.startswith("(") and seg.endswith(")"):
            continue  # route group — silent in URL
        cleaned.append(_normalise_dynamic_segment(seg))

    if not cleaned:
        return "/"
    return "/" + "/".join(cleaned)


def _normalise_dynamic_segment(seg: str) -> str:
    if seg.startswith("[[...") and seg.endswith("]]"):
        return "{" + seg[5:-2] + "}"
    if seg.startswith("[...") and seg.endswith("]"):
        return "{" + seg[4:-1] + "}"
    if seg.startswith("[") and seg.endswith("]"):
        return "{" + seg[1:-1] + "}"
    return seg


def _component_name(file: Path) -> str:
    parent = file.parent.name
    if parent == "app":
        return "RootPage"
    cleaned = re.sub(r"[\[\].]+", "", parent)
    words = re.split(r"[-_]+", cleaned)
    return "".join(w.capitalize() for w in words if w) + "Page"
