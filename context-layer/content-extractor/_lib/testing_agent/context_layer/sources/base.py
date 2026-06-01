"""The `SourceExtractor` Protocol and shared result type.

One typed handoff per source: `ExtractionRequest` (per-source subtype)
→ `ExtractionResult` (shared). The seam is strict — sources see only
what's in the request, produce only what's in the result, share no
state with the pipeline or with peer sources.

Design notes (from `placement-design.md`):
  * Pipeline labels the result with run-scoped IDs *after* the seam;
    sources stay anonymous.
  * Per-extractor exceptions are caught inside the source's `run()`
    and recorded as `ExtractorError` rows — they don't propagate.
  * Framework-level crashes (the source itself blows up) propagate;
    the pipeline catches at a higher level.
"""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from pathlib import Path
from typing import Generic, Protocol, TypeVar, runtime_checkable

from pydantic import Field, NonNegativeInt

from ...domain import FrozenModel
from ..models import (
    APIEndpoint,
    ExtractionProvenance,
    FormField,
    FrameworkFact,
    Interaction,
    UIRoute,
)


# ── enums ─────────────────────────────────────────────────────────────────


class SourceKind(StrEnum):
    """Which kind of source produced this result.

    Stamped on every `ExtractionProvenance.source_kind` *after* the
    pipeline receives the result — not by the source extractor itself.
    """

    CODEBASE = "codebase"
    LIVE = "live"
    DOCS = "docs"
    DIAGRAMS = "diagrams"
    USER = "user"
    EXISTING_TESTS = "existing_tests"
    GRAPHIFY = "graphify"
    DB = "db"


# ── per-extractor error capture ───────────────────────────────────────────


class ExtractorError(FrozenModel):
    """A framework-extractor failure captured inside a source's `run()`.

    Sources catch per-file / per-extractor exceptions and record them
    here so one bad extractor never kills a run.
    """

    extractor_name: str
    source_file: Path
    error_type: str
    message: str


class ExtractionWarning(FrozenModel):
    """A non-fatal anomaly worth surfacing.

    Examples: a file parsed but produced no entities; a deprecated
    framework version detected; a complex auth expression that the
    extractor couldn't decode. These don't change correctness;
    consumers may use them to decide whether to re-extract.
    """

    extractor_name: str
    source_file: Path
    code: str
    message: str


class FailedFile(FrozenModel):
    """A file the source tried to read but couldn't.

    `reason` is enum-shaped — `"binary"`, `"too_large"`, `"unreadable"`,
    `"parse_error"`. Distinct from `ExtractorError`, which is per-
    extractor; this is per-file.
    """

    path: Path
    reason: str
    detail: str = ""


# ── request / result ──────────────────────────────────────────────────────


class SourceExtractionRequest(FrozenModel):
    """Base for per-source request types.

    Each source kind has its own subtype carrying source-specific
    config: codebase needs a repo path; live needs URL + creds; docs
    needs a directory or URL. The shared interface narrows the request
    type via a generic.
    """

    # Common knobs every source can honour.
    enabled_extractors: list[str] | None = Field(
        default=None,
        description="Names of internal framework extractors to run. "
        "None means 'all registered'. Useful for debugging.",
    )


class ExtractionResult(FrozenModel):
    """What every `SourceExtractor.run()` returns.

    Shared across source kinds. Step-3-onwards reads this without
    caring which source produced it; per-entity provenance answers
    'where did this come from'.
    """

    endpoints: list[APIEndpoint] = Field(default_factory=list)
    routes: list[UIRoute] = Field(default_factory=list)
    interactions: list[Interaction] = Field(default_factory=list)
    form_fields: list[FormField] = Field(default_factory=list)
    framework_facts: list[FrameworkFact] = Field(default_factory=list)

    # Telemetry — pipeline uses these for audit / quality gating
    files_scanned: NonNegativeInt = 0
    files_skipped: NonNegativeInt = 0
    files_failed: list[FailedFile] = Field(default_factory=list)
    extractor_invocations: dict[str, NonNegativeInt] = Field(default_factory=dict)
    total_duration_ms: float = 0.0
    extractor_errors: list[ExtractorError] = Field(default_factory=list)
    extraction_warnings: list[ExtractionWarning] = Field(default_factory=list)

    # Filled by the source extractor itself.
    started_at: datetime | None = None
    completed_at: datetime | None = None


# ── the Protocol ──────────────────────────────────────────────────────────


ReqT = TypeVar("ReqT", bound=SourceExtractionRequest)


@runtime_checkable
class SourceExtractor(Protocol, Generic[ReqT]):
    """Top-level source-extractor interface.

    Each source kind implements this with its own request type. The
    pipeline talks to this interface; concrete sources stay encapsulated.

    Attributes:
        name           — unique identifier across all sources. Per-instance,
                         not per-kind — multiple codebase extractor flavours
                         can coexist (`"codebase_default"`, `"codebase_strict"`).
        source_kind    — category. Used by pipeline to route gap-fill requests
                         to the right source.
        source_version — semantic version of the source extractor itself
                         (rewrites bump this). Distinct from per-framework
                         `extractor_version` in `ExtractionProvenance`.

    Methods:
        can_run_for    — True when this source's required inputs are present
                         in the request. Pipeline uses for foundation
                         selection.
        run            — produce an `ExtractionResult`. Sync. The whole
                         seam.
    """

    name: str
    source_kind: SourceKind
    source_version: str

    def can_run_for(self, request: ReqT) -> bool: ...

    def run(self, request: ReqT) -> ExtractionResult: ...
