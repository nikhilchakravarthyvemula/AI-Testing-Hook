"""`CodebaseExtractor` — the codebase source-level extractor.

Implements `SourceExtractor[CodebaseExtractionRequest]`. Walks the
repo at `request.source_root`, dispatches to every registered
framework extractor, aggregates output into a single
`ExtractionResult`.

Per-extractor exceptions are caught and recorded as `ExtractorError`
rows — one bad framework extractor never kills the whole run. Files
that can't be read are recorded as `FailedFile` entries with a reason.
"""

from __future__ import annotations

import time
from collections.abc import Iterable
from datetime import datetime, timezone
from fnmatch import fnmatch
from pathlib import Path
from typing import Sequence

from ....platform.logging import get_logger
from ..base import (
    ExtractionResult,
    ExtractorError,
    FailedFile,
    SourceKind,
)
from .framework_port import Extractor
from .registry import default_framework_extractors
from .types import CodebaseExtractionRequest

log = get_logger(__name__)


SOURCE_VERSION = "1"


# Directories pruned during the walk.
_PRUNE_DIRS = frozenset({
    ".git",
    ".venv", "venv",
    "node_modules",
    "__pycache__",
    ".pytest_cache", ".mypy_cache",
    "dist", "build", "target",
    ".gradle", ".idea", ".vscode",
    ".next", ".turbo", "coverage", ".cache",
    "bin", "obj", "vendor",
})


class CodebaseExtractor:
    """Implements `SourceExtractor[CodebaseExtractionRequest]`."""

    name: str = "codebase"
    source_kind: SourceKind = SourceKind.CODEBASE
    source_version: str = SOURCE_VERSION

    def __init__(
        self,
        framework_extractors: Sequence[Extractor] | None = None,
    ) -> None:
        self._framework_extractors: list[Extractor] = list(
            framework_extractors if framework_extractors is not None
            else default_framework_extractors()
        )

    # ── SourceExtractor protocol ──────────────────────────────────────────

    def can_run_for(self, request: CodebaseExtractionRequest) -> bool:
        """True when `source_root` exists and points at a directory."""
        root = request.source_root
        return root.exists() and root.is_dir()

    def run(self, request: CodebaseExtractionRequest) -> ExtractionResult:
        """Walk the repo, dispatch to framework extractors, aggregate."""
        if not self.can_run_for(request):
            return _empty_result(reason=f"source_root not a directory: {request.source_root}")

        active = self._select_extractors(request)
        if not active:
            log.warning("codebase: no framework extractors active")
            return _empty_result(reason="no framework extractors registered")

        started = time.monotonic()
        started_at = datetime.now(tz=timezone.utc)
        log.info(
            "codebase: walking %s with %d framework extractor(s) [%s]",
            request.source_root,
            len(active),
            ", ".join(e.name for e in active),
        )

        accumulator = _Accumulator()
        max_bytes = request.file_size_limit_kb * 1024

        for file in self._walk(request.source_root, max_bytes, accumulator):
            content = self._read_or_skip(file, max_bytes, accumulator)
            if content is None:
                continue
            self._dispatch(file, content, active, accumulator)

        elapsed_ms = (time.monotonic() - started) * 1000.0
        completed_at = datetime.now(tz=timezone.utc)
        log.info(
            "codebase: done — files_scanned=%d files_skipped=%d failed=%d duration=%.0fms",
            accumulator.files_scanned,
            accumulator.files_skipped,
            len(accumulator.failed),
            elapsed_ms,
        )
        return accumulator.build_result(
            started_at=started_at,
            completed_at=completed_at,
            total_duration_ms=elapsed_ms,
        )

    # ── internals ─────────────────────────────────────────────────────────

    def _select_extractors(
        self, request: CodebaseExtractionRequest
    ) -> list[Extractor]:
        if request.enabled_extractors is None:
            return self._framework_extractors
        wanted = set(request.enabled_extractors)
        return [e for e in self._framework_extractors if e.name in wanted]

    def _walk(
        self, root: Path, max_bytes: int, acc: _Accumulator
    ) -> Iterable[Path]:
        for path in root.rglob("*"):
            if any(part in _PRUNE_DIRS for part in path.parts):
                continue
            if not path.is_file():
                continue
            yield path

    def _read_or_skip(
        self, file: Path, max_bytes: int, acc: _Accumulator
    ) -> str | None:
        try:
            size = file.stat().st_size
        except OSError as exc:
            acc.failed.append(FailedFile(path=file, reason="stat_error", detail=str(exc)))
            return None
        if size > max_bytes:
            acc.files_skipped += 1
            return None
        try:
            return file.read_text(encoding="utf-8", errors="strict")
        except UnicodeDecodeError:
            acc.files_skipped += 1
            return None
        except OSError as exc:
            acc.failed.append(FailedFile(path=file, reason="unreadable", detail=str(exc)))
            return None

    def _dispatch(
        self,
        file: Path,
        content: str,
        extractors: list[Extractor],
        acc: _Accumulator,
    ) -> None:
        anyone_supported = False
        for extractor in extractors:
            if not _file_matches_globs(file, extractor.file_globs):
                continue
            try:
                if not extractor.supports(file, content):
                    continue
            except Exception as exc:  # noqa: BLE001
                acc.errors.append(ExtractorError(
                    extractor_name=extractor.name,
                    source_file=file,
                    error_type=type(exc).__name__,
                    message=f"supports() raised: {exc!r}",
                ))
                continue

            anyone_supported = True
            acc.invocations[extractor.name] = acc.invocations.get(extractor.name, 0) + 1
            try:
                output = extractor.extract(file, content)
            except Exception as exc:  # noqa: BLE001
                acc.errors.append(ExtractorError(
                    extractor_name=extractor.name,
                    source_file=file,
                    error_type=type(exc).__name__,
                    message=f"extract() raised: {exc!r}",
                ))
                continue
            acc.absorb(output)

        if anyone_supported or _file_matches_any(file, extractors):
            acc.files_scanned += 1
        else:
            acc.files_skipped += 1


# ── helpers ────────────────────────────────────────────────────────────────


class _Accumulator:
    """Mutable scratch space; folded into `ExtractionResult` at the end."""

    def __init__(self) -> None:
        self.endpoints: list = []
        self.routes: list = []
        self.interactions: list = []
        self.form_fields: list = []
        self.framework_facts: list = []
        self.files_scanned: int = 0
        self.files_skipped: int = 0
        self.failed: list[FailedFile] = []
        self.invocations: dict[str, int] = {}
        self.errors: list[ExtractorError] = []

    def absorb(self, output) -> None:
        self.endpoints.extend(output.endpoints)
        self.routes.extend(output.routes)
        self.interactions.extend(output.interactions)
        self.form_fields.extend(output.form_fields)
        self.framework_facts.extend(output.framework_facts)

    def build_result(
        self,
        started_at: datetime,
        completed_at: datetime,
        total_duration_ms: float,
    ) -> ExtractionResult:
        return ExtractionResult(
            endpoints=self.endpoints,
            routes=self.routes,
            interactions=self.interactions,
            form_fields=self.form_fields,
            framework_facts=self.framework_facts,
            files_scanned=self.files_scanned,
            files_skipped=self.files_skipped,
            files_failed=self.failed,
            extractor_invocations=self.invocations,
            extractor_errors=self.errors,
            total_duration_ms=total_duration_ms,
            started_at=started_at,
            completed_at=completed_at,
        )


def _file_matches_globs(file: Path, globs: tuple[str, ...]) -> bool:
    return any(fnmatch(file.name, g) for g in globs)


def _file_matches_any(file: Path, extractors: Sequence[Extractor]) -> bool:
    return any(_file_matches_globs(file, e.file_globs) for e in extractors)


def _empty_result(reason: str) -> ExtractionResult:
    log.info("codebase: empty result — %s", reason)
    return ExtractionResult()
