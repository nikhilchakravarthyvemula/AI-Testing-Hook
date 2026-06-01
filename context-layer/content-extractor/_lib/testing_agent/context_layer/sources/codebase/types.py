"""Per-source request type for the codebase source.

`CodebaseExtractionRequest` carries codebase-specific configuration
(repo path, ignore patterns, file size cap, testid attribute name).
Other source kinds have their own request types — `LiveExtractionRequest`,
`DocsExtractionRequest`, etc.

The shared `SourceExtractor` Protocol narrows on this generic type.
"""

from __future__ import annotations

from pathlib import Path

from pydantic import Field

from ..base import SourceExtractionRequest


class CodebaseExtractionRequest(SourceExtractionRequest):
    """Request shape consumed by `CodebaseExtractor.run`."""

    source_root: Path = Field(
        description="Path to the repo root. The extractor reads files "
        "beneath this directory and nothing else.",
    )
    ignore_patterns: list[str] = Field(
        default_factory=list,
        description="Gitignore-style patterns. Match against any path "
        "segment to skip files / directories.",
    )
    file_size_limit_kb: int = Field(
        default=1000,
        ge=0,
        description="Skip files larger than this. Default 1MB — covers "
        "all real source files, excludes generated bundles.",
    )
    respect_gitignore: bool = Field(
        default=True,
        description="If True and .gitignore is present, honour it.",
    )
    follow_symlinks: bool = Field(default=False)
    testid_attr: str = Field(
        default="data-testid",
        description="Attribute name for the test-id selector strategy. "
        "Some projects use 'data-test' or 'data-cy' instead.",
    )
    detect_conventions: bool = Field(
        default=True,
        description="Run the convention-detection facts extractor.",
    )
