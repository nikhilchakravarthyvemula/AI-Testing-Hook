"""Build an `ExtractionOutput` for one route file.

Common between all convention-based frontend extractors: given a route
path, component name, and source content, produce a `UIRoute` plus
its `Interaction`s and `FormField`s — all with shared provenance.

The framework-specific parts (file-to-URL conversion, component naming,
markup pre-processing) stay in each extractor. The shared mechanics
(metadata extraction, selector ladder, form-field walk, provenance) live
here so they evolve in one place.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from .....models import (
    ActionKind,
    DiscoveryTier,
    FormField,
    Interaction,
    UIRoute,
)
from ...framework_port import ExtractionOutput
from .form_fields import extract_form_fields
from .page_metadata import extract_page_metadata, extract_ssg_hint
from .provenance import provenance
from .selectors import extract_selectors


_DYNAMIC_PARAM_RE = re.compile(r"\{(?P<name>[A-Za-z_][A-Za-z0-9_]*)\}")
_ROUTE_GROUP_RE = re.compile(r"\((?P<name>[^)]+)\)")


def build_route_output(
    *,
    file: Path,
    content: str,
    route_path: str,
    component: str,
    extractor_name: str,
    discovery_tier: DiscoveryTier,
    markup: str | None = None,
    route_group: str | None = None,
) -> ExtractionOutput:
    """Construct `ExtractionOutput` for a single route file.

    `markup` defaults to `content`. Frameworks with mixed-content files
    (Svelte's `<script>`, Vue's `<script>` blocks) pass markup-only
    text after stripping non-markup sections.

    `route_group` defaults to auto-detection from `file.parts` (looking
    for `(name)` segments). Frameworks with different group conventions
    pass an explicit value.
    """
    prov = provenance(
        source_file=file,
        content=content,
        discovery_tier=discovery_tier,
        extracted_by=extractor_name,
    )
    markup = markup if markup is not None else content

    meta = extract_page_metadata(content)
    ssg = extract_ssg_hint(content)
    detected_group = route_group if route_group is not None else _detect_route_group(file)

    route = UIRoute(
        path=route_path,
        component=component,
        dynamic_params=_extract_dynamic_params(route_path),
        route_group=detected_group,
        ssg_hint=ssg,
        page_title=meta["page_title"],
        meta_description=meta["meta_description"],
        primary_heading=meta["primary_heading"],
        og_title=meta["og_title"],
        og_description=meta["og_description"],
        og_image=meta["og_image"],
        provenance=prov,
    )

    interactions: list[Interaction] = [
        Interaction(
            route_path=route_path,
            intent=intent,
            action=_infer_action(sel),
            selector_strategy=sel["selector_strategy"],
            selector_value=sel["selector_value"],
            selector_role=sel.get("selector_role"),
            selector_name=sel.get("selector_name"),
            element_tag=sel.get("element_tag"),
            is_destructive=sel.get("is_destructive", False),
            provenance=prov,
        )
        for intent, sel in extract_selectors(markup).items()
    ]

    form_fields: list[FormField] = [
        FormField(
            route_path=route_path,
            provenance=prov,
            **spec,
        )
        for spec in extract_form_fields(markup)
    ]

    return ExtractionOutput(
        routes=[route],
        interactions=interactions,
        form_fields=form_fields,
    )


# ── helpers ────────────────────────────────────────────────────────────────


def _extract_dynamic_params(route_path: str) -> list[str]:
    """`/users/{id}/posts/{slug}` → `["id", "slug"]`."""
    return [m.group("name") for m in _DYNAMIC_PARAM_RE.finditer(route_path)]


def _detect_route_group(file: Path) -> str | None:
    """Find a `(name)` segment in the file path. Returns the first match
    (closest to repo root) so monorepos with nested groups don't mislead.
    """
    for part in file.parts:
        m = _ROUTE_GROUP_RE.fullmatch(part)
        if m:
            return m.group("name")
    return None


def _infer_action(sel: dict[str, Any]) -> ActionKind:
    """Map selector heuristics to a likely `ActionKind`.

    A submit-shaped value → SUBMIT; a non-anchor link-ish element →
    NAVIGATE; otherwise CLICK. Coarse — real action inference is the
    agentic context layer's job.
    """
    value = (sel.get("selector_value") or "").lower()
    tag = (sel.get("element_tag") or "").lower()
    if "submit" in value:
        return ActionKind.SUBMIT
    if tag == "a":
        return ActionKind.NAVIGATE
    return ActionKind.CLICK
