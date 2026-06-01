"""Framework extractor port — internal to the codebase source.

Each framework extractor (`java_spring`, `python_fastapi`, `nextjs_app`,
…) implements this Protocol. The `CodebaseExtractor` (source-level)
dispatches to all registered framework extractors.

This is NOT the top-level `SourceExtractor` interface — it's the
per-framework internal contract. The two operate at different layers:

  SourceExtractor       → runs a whole source (walks the repo, etc.)
  FrameworkExtractor    → handles one file's worth of one framework's syntax

Sources can have many framework extractors; pipelines see only the
source.
"""

from __future__ import annotations

from pathlib import Path
from typing import Protocol, runtime_checkable

from pydantic import Field

from ....domain import FrozenModel
from ...models import (
    APIEndpoint,
    DiscoveryTier,
    FormField,
    FrameworkFact,
    Interaction,
    UIRoute,
)


class ExtractionOutput(FrozenModel):
    """What one framework extractor returns from one `extract()` call.

    Empty lists by default so an extractor only populates the entity
    types it actually produces.
    """

    endpoints: list[APIEndpoint] = Field(default_factory=list)
    routes: list[UIRoute] = Field(default_factory=list)
    interactions: list[Interaction] = Field(default_factory=list)
    form_fields: list[FormField] = Field(default_factory=list)
    framework_facts: list[FrameworkFact] = Field(default_factory=list)


@runtime_checkable
class Extractor(Protocol):
    """One framework's understanding of source files. Internal to codebase source.

    `name`            Stable id; appears in `provenance.extracted_by`.
    `discovery_tier`  Honest tier label. Regex over text → CODE_REGEX.
    `file_globs`      Cheap pre-filter — only matching files are read.
    `supports`        Cheap content / path check.
    `extract`         Produces zero or more entities of any type.
    """

    name: str
    discovery_tier: DiscoveryTier
    file_globs: tuple[str, ...]

    def supports(self, file: Path, content: str) -> bool: ...

    def extract(self, file: Path, content: str) -> ExtractionOutput: ...
