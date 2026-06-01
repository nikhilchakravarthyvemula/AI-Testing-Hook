"""Single-extractor dispatcher.

Each per-folder `extract.py` wrapper imports `run_extractor()` and calls
it with the framework extractor class to run. The dispatcher:

  1. Resolves the target codebase from `TARGET_CODEBASE` env or argv.
  2. Walks the repo (reusing `CodebaseExtractor`'s walk/skip logic),
     but with only ONE framework extractor active.
  3. Aggregates the per-file `ExtractionOutput`s.
  4. Serialises everything to `output/code-extractors/<source_id>.json`
     with provenance + telemetry.

The reason for "one extractor per source file" instead of letting the
big `CodebaseExtractor` produce a monolithic blob: it mirrors the
content-extractor's per-folder layout (one folder = one source = one
JSON file). Downstream consumers can opt-in per source without
ingesting unrelated facts.

Usage from a per-folder wrapper:

    from _lib.run_extractor import run_extractor
    from testing_agent.context_layer.sources.codebase.extractors.backend.python_fastapi import (
        PythonFastAPIExtractor,
    )

    if __name__ == "__main__":
        run_extractor(
            source_id="python-fastapi",
            extractor=PythonFastAPIExtractor(),
        )
"""

from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime, timezone
from fnmatch import fnmatch
from pathlib import Path
from typing import Any

# Make the bundled testing_agent package importable when this file runs
# from any of the per-folder wrappers.
_LIB_DIR = Path(__file__).resolve().parent
if str(_LIB_DIR) not in sys.path:
    sys.path.insert(0, str(_LIB_DIR))

from testing_agent.context_layer.sources.codebase.framework_port import (  # noqa: E402
    Extractor,
    ExtractionOutput,
)


# Directories pruned during the walk — same set as CodebaseExtractor.
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
    "out", "output",
})


def _repo_root() -> Path:
    """Walk up from this file until we hit the testing-harness repo root."""
    return _LIB_DIR.parent.parent.parent  # _lib/ → content-extractor/ → context-layer/ → repo


def _resolve_target() -> Path | None:
    """Resolve the target codebase from env or argv. None when missing."""
    target = os.environ.get("TARGET_CODEBASE") or (sys.argv[1] if len(sys.argv) > 1 else None)
    if not target:
        return None
    path = Path(target).expanduser().resolve()
    return path if path.is_dir() else None


def _iter_files(root: Path) -> list[Path]:
    """All files under `root` minus the prune set. Sorted for determinism."""
    out: list[Path] = []
    for path in root.rglob("*"):
        if any(part in _PRUNE_DIRS for part in path.parts):
            continue
        if not path.is_file():
            continue
        out.append(path)
    out.sort()
    return out


def _matches_globs(file: Path, globs: tuple[str, ...]) -> bool:
    return any(fnmatch(file.name, g) for g in globs)


def _read_text(path: Path, max_bytes: int) -> str | None:
    try:
        if path.stat().st_size > max_bytes:
            return None
        return path.read_text(encoding="utf-8", errors="strict")
    except (OSError, UnicodeDecodeError):
        return None


def _output_path(source_id: str) -> Path:
    out_dir = _repo_root() / "output" / "code-extractors"
    out_dir.mkdir(parents=True, exist_ok=True)
    return out_dir / f"{source_id}.json"


def _model_dump(value: Any) -> Any:
    """Pydantic-aware JSON-safe dump."""
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json")
    if isinstance(value, list):
        return [_model_dump(v) for v in value]
    return value


def run_extractor(
    *,
    source_id: str,
    extractor: Extractor,
    target: Path | None = None,
    file_size_limit_kb: int = 1000,
) -> dict[str, Any]:
    """Run one framework extractor against the target. Returns the JSON blob written."""
    target = target or _resolve_target()
    if target is None:
        # No target → write an empty-but-valid bundle so consumers can still
        # observe that the source ran. Don't raise: this matches `gateEnv`
        # behaviour in run.mjs.
        msg = (
            f"[{source_id}] no TARGET_CODEBASE set (or argv path missing) — "
            "skipping. Set TARGET_CODEBASE=/abs/path/to/repo to extract."
        )
        print(msg, file=sys.stderr)
        bundle = _empty_bundle(source_id, extractor, reason=msg)
        out = _output_path(source_id)
        out.write_text(json.dumps(bundle, indent=2))
        print(f"[{source_id}] wrote (empty) {out}")
        return bundle

    started = time.monotonic()
    started_at = datetime.now(tz=timezone.utc)

    accumulator = ExtractionOutput()
    files_scanned = 0
    files_skipped = 0
    invocations = 0
    errors: list[dict[str, Any]] = []
    max_bytes = file_size_limit_kb * 1024

    for path in _iter_files(target):
        if not _matches_globs(path, extractor.file_globs):
            continue
        content = _read_text(path, max_bytes)
        if content is None:
            files_skipped += 1
            continue
        try:
            if not extractor.supports(path, content):
                files_skipped += 1
                continue
        except Exception as exc:  # noqa: BLE001
            errors.append({
                "phase": "supports",
                "file": str(path),
                "type": type(exc).__name__,
                "message": str(exc),
            })
            continue

        invocations += 1
        files_scanned += 1
        try:
            output = extractor.extract(path, content)
        except Exception as exc:  # noqa: BLE001
            errors.append({
                "phase": "extract",
                "file": str(path),
                "type": type(exc).__name__,
                "message": str(exc),
            })
            continue
        accumulator = _absorb(accumulator, output)

    elapsed_ms = (time.monotonic() - started) * 1000.0
    completed_at = datetime.now(tz=timezone.utc)

    bundle = {
        "sourceId": source_id,
        "extractor": {
            "name": getattr(extractor, "name", source_id),
            "discoveryTier": str(getattr(extractor, "discovery_tier", "code_regex")),
            "fileGlobs": list(extractor.file_globs),
        },
        "target": str(target),
        "startedAt": started_at.isoformat(),
        "completedAt": completed_at.isoformat(),
        "durationMs": round(elapsed_ms, 1),
        "telemetry": {
            "filesScanned": files_scanned,
            "filesSkipped": files_skipped,
            "invocations": invocations,
            "errorCount": len(errors),
        },
        "endpoints": _model_dump(list(accumulator.endpoints)),
        "routes": _model_dump(list(accumulator.routes)),
        "interactions": _model_dump(list(accumulator.interactions)),
        "formFields": _model_dump(list(accumulator.form_fields)),
        "frameworkFacts": _model_dump(list(accumulator.framework_facts)),
        "errors": errors,
    }

    out = _output_path(source_id)
    out.write_text(json.dumps(bundle, indent=2))

    counts = (
        f"endpoints={len(bundle['endpoints'])} "
        f"routes={len(bundle['routes'])} "
        f"interactions={len(bundle['interactions'])} "
        f"formFields={len(bundle['formFields'])} "
        f"facts={len(bundle['frameworkFacts'])}"
    )
    print(
        f"[{source_id}] {counts} "
        f"(files: scanned={files_scanned} skipped={files_skipped} errors={len(errors)}) "
        f"→ {out.relative_to(_repo_root())}"
    )
    return bundle


def _absorb(acc: ExtractionOutput, output: ExtractionOutput) -> ExtractionOutput:
    """Merge two frozen ExtractionOutputs into a new one."""
    return ExtractionOutput(
        endpoints=[*acc.endpoints, *output.endpoints],
        routes=[*acc.routes, *output.routes],
        interactions=[*acc.interactions, *output.interactions],
        form_fields=[*acc.form_fields, *output.form_fields],
        framework_facts=[*acc.framework_facts, *output.framework_facts],
    )


def _empty_bundle(source_id: str, extractor: Extractor, reason: str) -> dict[str, Any]:
    return {
        "sourceId": source_id,
        "extractor": {
            "name": getattr(extractor, "name", source_id),
            "discoveryTier": str(getattr(extractor, "discovery_tier", "code_regex")),
            "fileGlobs": list(extractor.file_globs),
        },
        "target": None,
        "skipped": reason,
        "telemetry": {
            "filesScanned": 0,
            "filesSkipped": 0,
            "invocations": 0,
            "errorCount": 0,
        },
        "endpoints": [],
        "routes": [],
        "interactions": [],
        "formFields": [],
        "frameworkFacts": [],
        "errors": [],
    }
