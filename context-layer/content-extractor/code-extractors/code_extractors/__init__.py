"""code_extractors — per-framework AST/regex/manifest extractors.

Each entry under this folder is one framework-aware extractor wrapper.
The wrappers themselves delegate to classes in `../_lib/testing_agent/`
or to hand-rolled extractors (python-ast/).

Public surface:
  * `ICodeExtractor`   — Protocol every extractor wrapper satisfies.
  * `ExtractionBundle` — shared model for "what one extractor produces".
  * `EXTRACTOR_CATALOG`— name → (framework, language, supported_signals) map.
                         The framework-extractor reads this to pick which
                         extractors apply to a detected codebase.
"""

from .catalog import EXTRACTOR_CATALOG, ExtractorMetadata
from .interfaces import ICodeExtractor
from .models import ExtractionBundle, ExtractorTelemetry

__all__ = [
    "ICodeExtractor",
    "ExtractionBundle",
    "ExtractorTelemetry",
    "EXTRACTOR_CATALOG",
    "ExtractorMetadata",
]
