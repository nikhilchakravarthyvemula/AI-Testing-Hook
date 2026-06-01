"""File-walking helpers used by individual extractors.

The runner already walks the repo; these helpers are for extractors
that need additional context from neighbouring files (e.g.
`FrameworkFact` extractors that read `package.json` to derive related
info, or convention detectors that scan multiple files at once).

These helpers DO touch the filesystem, but only within the directory
the runner is processing — they don't escape the repo path.
"""

from __future__ import annotations

import hashlib
from pathlib import Path


def sha256_of(text: str) -> str:
    """Stable hex digest. Used for `ExtractionProvenance.content_hash`."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def find_first_ancestor_with(
    file: Path, marker_name: str, *, stop_at: Path | None = None
) -> Path | None:
    """Walk up from `file.parent` looking for a sibling named `marker_name`.

    Returns the directory containing the marker, or None. Useful for
    "where's the project root relative to this file?" questions.
    """
    current = file.parent.resolve()
    boundary = stop_at.resolve() if stop_at else None

    while True:
        candidate = current / marker_name
        if candidate.exists():
            return current
        if boundary and current == boundary:
            return None
        if current == current.parent:
            return None
        current = current.parent
