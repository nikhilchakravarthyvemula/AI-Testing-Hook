"""Helper to construct `ExtractionProvenance` consistently across extractors.

Centralising this means every extractor produces provenance the same
way — same hash algorithm, same `extracted_at` clock, same tier-to-
confidence mapping.
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from .....models import DiscoveryTier, ExtractionProvenance, _confidence_for_tier
from .file_walking import sha256_of


def provenance(
    *,
    source_file: Path,
    content: str,
    discovery_tier: DiscoveryTier,
    extracted_by: str,
    extractor_version: str = "0",
    source_line_start: int | None = None,
    source_line_end: int | None = None,
) -> ExtractionProvenance:
    """Build a provenance record. Use this — don't construct manually."""
    return ExtractionProvenance(
        source_file=source_file,
        source_line_start=source_line_start,
        source_line_end=source_line_end,
        content_hash=sha256_of(content),
        discovery_tier=discovery_tier,
        confidence=_confidence_for_tier(discovery_tier),
        extracted_at=datetime.now(tz=timezone.utc),
        extracted_by=extracted_by,
        extractor_version=extractor_version,
    )
