"""Context-layer entity types.

Five entities — `APIEndpoint`, `UIRoute`, `Interaction`, `FormField`,
`FrameworkFact` — plus `ExtractionProvenance`. Every entity carries
provenance.

The schema is enriched specifically to support two downstream concerns:
  * **Test planning** — picking which cases to test (endpoints with
    status codes, routes with auth, tags, deprecated flags).
  * **Test script generation** — emitting executable code (concrete
    selectors, form-field validation, example request/response bodies).

Relationships are expressed by string keys (`Interaction.route_path`
joins to `UIRoute.path`) so the schema persists cleanly to SQL.
Selectors are flat columns on `Interaction` and `FormField`.

`discovery_tier` semantics:
  * `ast`         — real AST parse (Python `ast`, `tomllib`).
  * `code_regex`  — regex over source text.
  * `code_only`   — filesystem layout only.
  * `spec`        — declared in an authoritative spec.
  * `live_observed` — observed during runtime / network capture.
  * `docs_extracted` — pulled from documentation.
  * `diagram_text` / `diagram_image` — extracted from diagrams.
  * `user_answered` — explicitly answered by the user.

Confidence derives from tier; the table lives in `_confidence_for_tier`.
"""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from pathlib import Path
from typing import Any, Literal

from pydantic import Field, NonNegativeInt

from ..domain import FrozenModel


# ── enums ──────────────────────────────────────────────────────────────────


class DiscoveryTier(StrEnum):
    """How an entity was discovered. Drives base confidence.

    Tiers map roughly to source kinds; some sources can produce
    entities at multiple tiers (e.g. codebase produces `ast` for
    Python and `code_regex` for Java).
    """

    AST = "ast"
    CODE_REGEX = "code_regex"
    CODE_ONLY = "code_only"
    SPEC = "spec"
    LIVE_OBSERVED = "live_observed"
    DOCS_EXTRACTED = "docs_extracted"
    DIAGRAM_TEXT = "diagram_text"
    DIAGRAM_IMAGE = "diagram_image"
    USER_ANSWERED = "user_answered"
    GRAPH_EXTRACTED = "graph_extracted"


def _confidence_for_tier(tier: DiscoveryTier) -> float:
    """Base confidence per tier — adjustable for staleness / corroboration."""
    return {
        DiscoveryTier.LIVE_OBSERVED: 0.95,
        DiscoveryTier.SPEC: 0.95,
        DiscoveryTier.AST: 0.90,
        DiscoveryTier.USER_ANSWERED: 0.85,
        DiscoveryTier.CODE_REGEX: 0.70,
        DiscoveryTier.GRAPH_EXTRACTED: 0.65,
        DiscoveryTier.DIAGRAM_TEXT: 0.60,
        DiscoveryTier.DOCS_EXTRACTED: 0.55,
        DiscoveryTier.DIAGRAM_IMAGE: 0.45,
        DiscoveryTier.CODE_ONLY: 0.40,
    }[tier]


class ActionKind(StrEnum):
    """How a user physically interacts with an element on a UI route."""

    CLICK = "click"
    SUBMIT = "submit"
    FILL = "fill"
    SELECT = "select"
    NAVIGATE = "navigate"
    OTHER = "other"


SelectorStrategy = Literal["testid", "role", "label", "text", "css"]
FormFieldType = Literal[
    "text", "password", "email", "number", "tel", "url", "search",
    "select", "checkbox", "radio", "textarea",
    "date", "datetime-local", "time", "month", "week",
    "file", "color", "range", "hidden",
]
ParameterLocation = Literal["query", "path", "header", "cookie", "body"]
SSGHint = Literal["static", "dynamic", "isr", "client"]


# ── provenance ─────────────────────────────────────────────────────────────


class ExtractionProvenance(FrozenModel):
    """Where an entity came from. Carried on every entity.

    `source_kind` and `source_name` identify which source extractor
    produced this. `extracted_by` is the *framework* extractor inside
    the source (e.g. `java_spring` inside the codebase source). Both
    matter — sources can have many internal extractors.
    """

    source_file: Path
    source_line_start: int | None = None
    source_line_end: int | None = None
    content_hash: str = Field(
        default="",
        description="SHA-256 hex of source_file bytes at extraction time.",
    )
    discovery_tier: DiscoveryTier
    confidence: float = Field(ge=0.0, le=1.0)
    extracted_at: datetime
    extracted_by: str = Field(
        description="Framework extractor name — e.g. 'java_spring', 'nextjs_app'.",
    )
    extractor_version: str = Field(
        default="0",
        description="Increment when an extractor's logic changes meaningfully.",
    )
    # Filled by the pipeline after the seam, not by the extractor itself.
    source_kind: str | None = Field(
        default=None,
        description="Set by the pipeline once it labels the result. "
        "Empty inside the source extractor.",
    )


# ── API entities ───────────────────────────────────────────────────────────


class EndpointParameter(FrozenModel):
    """One parameter on an `APIEndpoint`.

    `examples` is plural to match OpenAPI 3.x — multiple realistic
    values support combinatorial parameter coverage in test generation.
    """

    name: str
    location: ParameterLocation
    type: str | None = Field(
        default=None,
        description="JSON Schema type ('string', 'integer', etc.) or "
        "language-native type name when inferred from code.",
    )
    is_required: bool = False
    default: Any | None = None
    description: str | None = None
    examples: list[Any] = Field(
        default_factory=list,
        description="Concrete example values for test data generation.",
    )
    validation: dict[str, Any] = Field(
        default_factory=dict,
        description="Constraints when known: {pattern, minimum, maximum, "
        "minLength, maxLength, enum, ...}.",
    )


class APIEndpoint(FrozenModel):
    """One declared HTTP endpoint.

    Test planning consumes: method, path, parameters, response_schemas
    (drives negative tests), tags, auth_required, required_roles,
    is_deprecated, idempotent_hint.

    Test script generation consumes: request_schema, request_examples,
    response_schemas, response_examples, request_content_type,
    security_scheme, path parameters with examples + validation.
    """

    # Core identity
    method: str = Field(pattern=r"^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)$")
    path: str
    operation_id: str | None = None
    summary: str | None = None
    description: str | None = None
    tags: list[str] = Field(default_factory=list)

    # Parameters
    parameters: list[EndpointParameter] = Field(default_factory=list)

    # Request / response schemas
    request_schema: dict[str, Any] | None = None
    request_content_type: str | None = None
    request_examples: list[dict[str, Any]] = Field(
        default_factory=list,
        description="Concrete example request bodies for test replay. "
        "Pulled from OpenAPI 'examples' or 'example' on requestBody.",
    )
    response_schemas: dict[str, dict[str, Any]] | None = None
    response_content_types: dict[str, str] = Field(default_factory=dict)
    response_examples: dict[str, list[dict[str, Any]]] = Field(
        default_factory=dict,
        description="Example response bodies keyed by status code. "
        "Drives assertion templates in generated test scripts.",
    )
    schema_ref: str | None = Field(
        default=None,
        description="Type-name reference when schemas couldn't be resolved "
        "across files. Honest about partial coverage.",
    )

    # Auth
    auth_required: bool = False
    required_roles: list[str] = Field(default_factory=list)
    security_scheme: str | None = None

    # Status flags
    is_deprecated: bool = False
    not_in_spec: bool = Field(
        default=False,
        description="Set by consumers when endpoint appears in code but "
        "not in any declared spec. Extractors leave it False.",
    )

    # Behaviour hints — drive test ordering / safety
    idempotent_hint: bool | None = None

    provenance: ExtractionProvenance


# ── UI entities ────────────────────────────────────────────────────────────


class UIRoute(FrozenModel):
    """One UI route.

    Test planning consumes: path, auth_required, required_roles, tags,
    page_title (identification), dynamic_params (parameter coverage).

    Test script generation consumes: component (Page Object name),
    page_title (waiting on for load), ssg_hint (drives wait strategy
    in tests).
    """

    path: str
    component: str

    # Auth
    auth_required: bool = False
    required_roles: list[str] = Field(default_factory=list)

    # HTML / framework metadata
    page_title: str | None = None
    meta_description: str | None = None
    primary_heading: str | None = None
    og_title: str | None = None
    og_description: str | None = None
    og_image: str | None = None

    # Routing structure
    dynamic_params: list[str] = Field(
        default_factory=list,
        description='Names of `{param}` segments. Drives URL-builder test code.',
    )
    route_group: str | None = None
    layout_chain: list[Path] = Field(default_factory=list)
    ssg_hint: SSGHint | None = None

    provenance: ExtractionProvenance


class Interaction(FrozenModel):
    """One interactive element on a route.

    Selector is flat (4 columns) — test-gen code reads them directly
    rather than unpacking a nested object. `navigates_to_path` /
    `api_call_hint` drive expected-side-effect assertions in scripts.
    """

    # Identity
    route_path: str
    intent: str
    action: ActionKind

    # Selector — flat
    selector_strategy: SelectorStrategy
    selector_value: str
    selector_role: str | None = None
    selector_name: str | None = None

    # Element classification
    element_tag: str | None = None
    is_destructive: bool = Field(
        default=False,
        description="Heuristic match on /delete|remove|cancel|destroy/i. "
        "Test runners may skip destructive flows in safety-aware modes.",
    )

    # Behaviour hints
    navigates_to_path: str | None = None
    api_call_hint: str | None = Field(
        default=None,
        description='When extractor saw a literal fetch("/x") in the same '
        'file as the element. METHOD-prefixed (e.g. "POST /api/users").',
    )

    provenance: ExtractionProvenance


class FormField(FrozenModel):
    """One form input.

    Test planning consumes: route_path, form_intent (groups fields by
    submit button), is_required (decides positive vs negative paths).

    Test script generation consumes: name, field_type, selector_*,
    placeholder, default_value, label_text, validation columns, options.
    """

    route_path: str
    form_intent: str | None = None
    name: str
    field_type: FormFieldType = "text"

    # Selector — flat
    selector_strategy: SelectorStrategy
    selector_value: str
    selector_role: str | None = None
    selector_name: str | None = None

    # Metadata
    label_text: str | None = None
    placeholder: str | None = None
    default_value: str | None = None
    is_required: bool = False
    is_disabled: bool = False
    is_readonly: bool = False
    autocomplete: str | None = None

    # Validation
    min_value: str | None = None
    max_value: str | None = None
    min_length: int | None = None
    max_length: int | None = None
    pattern: str | None = None
    step: str | None = None
    accept: str | None = None

    # Options for select / radio
    options: list[dict[str, str]] = Field(
        default_factory=list,
        description='Each item: {value, label}. Empty for non-select fields.',
    )

    provenance: ExtractionProvenance


# ── facts ─────────────────────────────────────────────────────────────────


class FrameworkFact(FrozenModel):
    """One fact about the codebase's framework / stack / conventions.

    Test planning consumes `kind` to pick the right test runner template
    (`test_framework=pytest` → pytest tests; `frontend_framework=nextjs`
    → Playwright with App Router-aware selectors).
    """

    kind: str
    key: str
    value: str | None = None
    display: str | None = None
    related_files: list[Path] = Field(default_factory=list)

    provenance: ExtractionProvenance


# ── method idempotence helper ──────────────────────────────────────────────


_IDEMPOTENT_METHODS = frozenset({"GET", "HEAD", "PUT", "DELETE", "OPTIONS"})


def method_is_idempotent(method: str) -> bool:
    """HTTP spec idempotence: GET/HEAD/PUT/DELETE/OPTIONS yes; POST/PATCH no."""
    return method.upper() in _IDEMPOTENT_METHODS
