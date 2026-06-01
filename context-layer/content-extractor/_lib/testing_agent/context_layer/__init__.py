"""Context layer — sources, extraction, refinement, catalog assembly.

A pipeline that learns about a target from multiple sources (codebase,
live observation, docs, diagrams, user input) and assembles a catalog
that downstream phases (planning, generation, execution) consume.

This package owns:
  * the entity types (`models.py`) — `APIEndpoint`, `UIRoute`,
    `Interaction`, `FormField`, `FrameworkFact` with `ExtractionProvenance`
  * the source extractor interface (`sources/base.py`) — one
    `SourceExtractor` Protocol for every source kind
  * concrete source extractors (`sources/<kind>/`) — codebase is the
    primary one today; live / docs / diagrams / user / existing_tests
    are placeholders

Sources don't know about each other. They produce facts; the pipeline
labels, reconciles, and assembles. Step-3-onwards (analysis, gaps,
fillers, catalog) is downstream of this package.
"""

from .models import (
    APIEndpoint,
    ActionKind,
    DiscoveryTier,
    EndpointParameter,
    ExtractionProvenance,
    FormField,
    FrameworkFact,
    Interaction,
    UIRoute,
    method_is_idempotent,
)
from .sources.base import (
    ExtractionResult,
    ExtractorError,
    SourceExtractionRequest,
    SourceExtractor,
    SourceKind,
)

__all__ = [
    "APIEndpoint",
    "ActionKind",
    "DiscoveryTier",
    "EndpointParameter",
    "ExtractionProvenance",
    "ExtractionResult",
    "ExtractorError",
    "FormField",
    "FrameworkFact",
    "Interaction",
    "SourceExtractionRequest",
    "SourceExtractor",
    "SourceKind",
    "UIRoute",
    "method_is_idempotent",
]
