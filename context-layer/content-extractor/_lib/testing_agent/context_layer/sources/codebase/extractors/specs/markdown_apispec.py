"""Markdown / RST API specification extractor.

Two encodings recognised:

Encoding 1 — heading style (APISPEC convention):
    ### `GET /api/logs`
    ### `POST /app/v1/login`

Encoding 2 — table style (OPENSPEC convention):
    | Endpoint | Type | Purpose |
    |----------|------|---------|
    | `/webhook` | POST | ... |

Out of scope: extracting request/response schemas from prose. The
extractor's job is "this endpoint exists, with this method and path."
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from pathlib import Path

from ......platform.logging import get_logger
from .....models import APIEndpoint, DiscoveryTier, method_is_idempotent
from ...framework_port import Extractor, ExtractionOutput
from .._shared.provenance import provenance

log = get_logger(__name__)


_VALID_HTTP_METHODS = {"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"}
# WebSocket isn't HTTP but specs often document it; map to GET so the
# path stays in the catalog while satisfying the method regex.
_METHOD_ALIASES = {"WS": "GET", "WEBSOCKET": "GET"}

_HEADING_RE = re.compile(
    r"^#{2,5}\s+`\s*(?P<method>[A-Z]+)\s+(?P<path>/[^\s`]*)\s*`\s*$",
    re.MULTILINE,
)
_TABLE_PATH_RE = re.compile(r"`(/[^\s`]*)`")
_SPEC_KEYWORDS = ("spec", "openspec", "apispec", "endpoint", "endpoints")


class MarkdownAPISpecExtractor:
    """Parses heading-style and table-style endpoint declarations. Tier=spec."""

    name: str = "markdown_apispec"
    discovery_tier: DiscoveryTier = DiscoveryTier.SPEC
    file_globs: tuple[str, ...] = ("*.md", "*.markdown", "*.rst", "*.txt")

    def supports(self, file: Path, content: str) -> bool:
        stem = file.stem.lower()
        if not any(k in stem for k in _SPEC_KEYWORDS):
            return False
        return "`/" in content or any(
            f"`{verb} /" in content for verb in _VALID_HTTP_METHODS
        ) or "`WS /" in content

    def extract(self, file: Path, content: str) -> ExtractionOutput:
        prov = provenance(
            source_file=file,
            content=content,
            discovery_tier=self.discovery_tier,
            extracted_by=self.name,
        )
        seen: dict[tuple[str, str], APIEndpoint] = {}

        for method, path in _parse_headings(content):
            seen.setdefault((method, path), APIEndpoint(
                method=method,
                path=path,
                idempotent_hint=method_is_idempotent(method),
                provenance=prov,
            ))
        for method, path in _parse_tables(content):
            seen.setdefault((method, path), APIEndpoint(
                method=method,
                path=path,
                idempotent_hint=method_is_idempotent(method),
                provenance=prov,
            ))

        log.info("markdown_apispec: %s → %d endpoints", file, len(seen))
        return ExtractionOutput(endpoints=list(seen.values()))


def _parse_headings(content: str) -> Iterable[tuple[str, str]]:
    for match in _HEADING_RE.finditer(content):
        method = _METHOD_ALIASES.get(
            match.group("method").upper(), match.group("method").upper()
        )
        if method not in _VALID_HTTP_METHODS:
            continue
        yield method, match.group("path")


def _parse_tables(content: str) -> Iterable[tuple[str, str]]:
    for block in _iter_table_blocks(content):
        header = block[0]
        cols = [c.strip().lower() for c in header.strip("|").split("|")]
        path_col = _find_col(cols, ("endpoint", "path", "route"))
        method_col = _find_col(cols, ("type", "method", "verb"))
        if path_col is None:
            continue

        for row in block[2:]:
            cells = [c.strip() for c in row.strip("|").split("|")]
            if len(cells) <= path_col:
                continue
            path_match = _TABLE_PATH_RE.search(cells[path_col])
            if path_match is None:
                continue
            path = path_match.group(1)
            method = ""
            if method_col is not None and len(cells) > method_col:
                method = cells[method_col].upper().strip("` ")
            method = _METHOD_ALIASES.get(method, method)
            if method not in _VALID_HTTP_METHODS:
                continue
            yield method, path


def _iter_table_blocks(content: str) -> Iterable[list[str]]:
    block: list[str] = []
    in_table = False
    for line in content.splitlines():
        stripped = line.strip()
        is_row = stripped.startswith("|") and stripped.endswith("|")
        if is_row:
            block.append(line)
            in_table = True
            continue
        if in_table:
            if len(block) >= 3:
                yield block
            block = []
            in_table = False
    if in_table and len(block) >= 3:
        yield block


def _find_col(cols: list[str], names: tuple[str, ...]) -> int | None:
    for i, c in enumerate(cols):
        if c in names:
            return i
    return None
