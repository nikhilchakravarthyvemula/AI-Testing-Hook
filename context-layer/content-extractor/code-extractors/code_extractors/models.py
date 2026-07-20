"""Shared data models for code-extractors.

`ExtractionBundle` is what every extractor wrapper produces from one
target. It's a thin pydantic mirror of the testing-agent
`ExtractionOutput` plus run telemetry, normalised so the orchestrator
can write a uniform JSON bundle per source.

If you add a new entity type (e.g. `database_table`), do it here and
the wrappers + JSON consumers update in lockstep.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field, NonNegativeInt


# ── per-run telemetry ─────────────────────────────────────────────────────


class ExtractorError(BaseModel):
    """A non-fatal error from one file. The run continues."""

    model_config = ConfigDict(extra="forbid")

    phase: str = Field(description="'supports' | 'extract'.")
    file: str
    type: str
    message: str


class ExtractorTelemetry(BaseModel):
    """How much work the extractor did, irrespective of what it found."""

    model_config = ConfigDict(extra="forbid")

    files_scanned: NonNegativeInt = 0
    files_skipped: NonNegativeInt = 0
    invocations: NonNegativeInt = 0
    error_count: NonNegativeInt = 0


# ── extraction bundle (what gets written to output/sources/<name>.json) ───


class ExtractionBundle(BaseModel):
    """Uniform output shape across every code-extractor.

    The fields are deliberately permissive (`list[Any]`) at this layer
    so each framework can carry richer detail in its own facts without
    forcing every other extractor to know about it. Downstream
    consumers (indexer/synthesizer) re-type as needed.
    """

    model_config = ConfigDict(extra="forbid")

    source_id: str = Field(description="Stable extractor id (e.g. 'python-fastapi').")
    extractor: dict[str, Any] = Field(
        description="Static metadata: {name, discoveryTier, fileGlobs, supportedFrameworks}",
    )
    target: Optional[str] = Field(
        default=None,
        description="Absolute path of the codebase that was scanned. None if extractor was skipped.",
    )
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    duration_ms: float = 0.0

    telemetry: ExtractorTelemetry = Field(default_factory=ExtractorTelemetry)

    # Entity lists — pydantic stays permissive here; testing-agent ports
    # serialise richer shapes via .model_dump(mode='json').
    endpoints: list[Any] = Field(default_factory=list)
    routes: list[Any] = Field(default_factory=list)
    interactions: list[Any] = Field(default_factory=list)
    form_fields: list[Any] = Field(default_factory=list)
    framework_facts: list[Any] = Field(default_factory=list)
    errors: list[ExtractorError] = Field(default_factory=list)

    # Set when the extractor was registered but no target was available
    # (e.g. TARGET_CODEBASE missing in env). Lets the orchestrator
    # surface "skipped, here's why" without lying with empty facts.
    skipped: Optional[str] = None
