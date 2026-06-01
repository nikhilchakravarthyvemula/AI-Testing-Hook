"""Models produced by the framework-extractor."""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from pathlib import Path
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field, NonNegativeInt


# ── enums ─────────────────────────────────────────────────────────────────


class SignalKind(StrEnum):
    """How a framework signal was observed.

    FILE_EXTENSION   — counted N files with extension .py / .vue / etc.
    MANIFEST_FILE    — found pyproject.toml / package.json / pom.xml / etc.
    MANIFEST_DEP     — manifest declares dependency on the framework.
    IMPORT_STATEMENT — sampled source files contain `import fastapi`, etc.
    CONFIG_FILE      — framework-specific config (next.config.js, etc.).
    DIRECTORY_LAYOUT — convention-based (app/ for nextjs, src/main/java/ for spring).
    """

    FILE_EXTENSION = "file_extension"
    MANIFEST_FILE = "manifest_file"
    MANIFEST_DEP = "manifest_dep"
    IMPORT_STATEMENT = "import_statement"
    CONFIG_FILE = "config_file"
    DIRECTORY_LAYOUT = "directory_layout"


# ── per-finding models ────────────────────────────────────────────────────


class DetectionSignal(BaseModel):
    """One piece of evidence pointing to a framework/language."""

    model_config = ConfigDict(extra="forbid")

    kind: SignalKind
    value: str = Field(description="Human-readable evidence, e.g. '142 .py files' or 'pyproject.toml'.")
    weight: float = Field(ge=0.0, le=1.0, description="0..1 — how strongly this signal indicates the target.")
    source_file: Optional[str] = Field(default=None, description="Path of the file that produced this signal.")


class DetectedLanguage(BaseModel):
    """A programming language found in the codebase."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(description="Language id: 'python', 'typescript', 'java', etc.")
    file_count: NonNegativeInt = 0
    signals: list[DetectionSignal] = Field(default_factory=list)
    confidence: float = Field(ge=0.0, le=1.0)


class DetectedFramework(BaseModel):
    """A framework found in the codebase."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(description="Framework id matching ExtractorMetadata.frameworks (e.g. 'fastapi').")
    language: str = Field(description="Which language this framework is for.")
    signals: list[DetectionSignal] = Field(default_factory=list)
    confidence: float = Field(ge=0.0, le=1.0)


# ── top-level result ──────────────────────────────────────────────────────


class FrameworkDetectionResult(BaseModel):
    """What the framework-extractor writes to output/sources/framework-detection.json."""

    model_config = ConfigDict(extra="forbid")

    target: str
    detector_name: str
    detected_at: datetime = Field(default_factory=datetime.utcnow)
    duration_ms: float = 0.0

    languages: list[DetectedLanguage] = Field(default_factory=list)
    frameworks: list[DetectedFramework] = Field(default_factory=list)

    # Convenience derived field — the set of extractor names that
    # should run, given what we detected. Computed by the orchestrator
    # using EXTRACTOR_CATALOG; written here as a stable list.
    recommended_extractors: list[str] = Field(
        default_factory=list,
        description="Extractor names (matching code-extractors/<name>/) the orchestrator should run.",
    )

    def language_names(self) -> set[str]:
        return {lang.name for lang in self.languages}

    def framework_names(self) -> set[str]:
        return {fw.name for fw in self.frameworks}


__all__ = [
    "SignalKind",
    "DetectionSignal",
    "DetectedLanguage",
    "DetectedFramework",
    "FrameworkDetectionResult",
]
