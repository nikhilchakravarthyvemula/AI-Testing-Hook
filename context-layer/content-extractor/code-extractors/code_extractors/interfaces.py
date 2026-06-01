"""ICodeExtractor — contract every per-framework extractor wrapper satisfies.

Structural (Protocol) rather than nominal (ABC) so existing extractor
classes in `_lib/testing_agent/` qualify without subclassing — they
already expose the same shape.

Each wrapper under `code-extractors/<name>/extract.py` is a thin
script (not a class) that delegates to a class meeting this Protocol.
The Protocol lives here because:
  * the orchestrator's discovery code wants a single import to
    type-check against
  * future Python callers (`testo ask`) can register these directly
    without going through the per-folder shim
"""

from __future__ import annotations

from pathlib import Path
from typing import Protocol, runtime_checkable

from .models import ExtractionBundle


@runtime_checkable
class ICodeExtractor(Protocol):
    """One framework's understanding of a codebase.

    Attributes:
        name             Stable id, e.g. "python-fastapi". Matches the
                         folder name under code-extractors/.
        discovery_tier   Honest tier label — "ast", "code_regex",
                         "code_only", etc. Drives confidence scoring
                         in the knowledge base.
        file_globs       Cheap filename pre-filter. Only matching files
                         are even opened.
        supported_frameworks
                         Framework ids this extractor produces facts
                         for. The framework-extractor uses this set to
                         decide whether to run the extractor. e.g.
                         ["fastapi"] for python_fastapi, ["nextjs"] for
                         nextjs_app.

    Methods:
        supports(file, content) -> bool
                         Cheap content check. Returning False short-
                         circuits before extract() runs.
        extract(file, content) -> ExtractionBundle
                         Pull entities out of one file's worth of text.
                         Empty bundles are fine; the orchestrator
                         aggregates many per-file bundles into one.
    """

    name: str
    discovery_tier: str
    file_globs: tuple[str, ...]
    supported_frameworks: tuple[str, ...]

    def supports(self, file: Path, content: str) -> bool: ...

    def extract(self, file: Path, content: str) -> ExtractionBundle: ...
