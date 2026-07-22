"""framework-detector entrypoint.

  python extract.py [/abs/path/to/repo]

Walks the target with the `DeterministicFrameworkDetector` (signal-based,
fully deterministic — BYO-LLM architecture: no internal LLM), computes
`recommended_extractors` by intersecting detected frameworks with
`EXTRACTOR_CATALOG`, and writes the result to:

  output/framework-detector/framework-detection.json

This is the FIRST step in the content-extractor pipeline whenever
--codebase is set. The orchestrator reads `recommended_extractors`
and only runs those code-extractors next.

Env vars consumed (mirroring the other extractor wrappers):
  TARGET_CODEBASE             absolute path of the source repo (or argv[1])
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
from pathlib import Path

# Both packages live as importable underscored sub-packages inside their
# hyphenated display folders. Put both folder paths on sys.path so
# `import framework_extractor` and `import code_extractors` both resolve.
_HERE = Path(__file__).resolve().parent
_CE_DIR = _HERE.parent                                  # context-layer/content-extractor/
_CODE_EXTRACTORS_DIR = _CE_DIR / "code-extractors"

sys.path.insert(0, str(_HERE))                          # find framework_extractor/
sys.path.insert(0, str(_CODE_EXTRACTORS_DIR))           # find code_extractors/

from framework_extractor.detector import DeterministicFrameworkDetector            # noqa: E402
from code_extractors.catalog import EXTRACTOR_CATALOG                              # noqa: E402


def _repo_root() -> Path:
    return _CE_DIR.parent.parent  # context-layer/ → repo


def _parse_cli() -> Path | None:
    """Return the target codebase path (argv[1] or $TARGET_CODEBASE)."""
    parser = argparse.ArgumentParser(prog="framework-detector", add_help=True)
    parser.add_argument("target", nargs="?", default=None,
                        help="Codebase path. Falls back to $TARGET_CODEBASE.")
    args = parser.parse_args()

    raw = args.target or os.environ.get("TARGET_CODEBASE")
    target = Path(raw).expanduser().resolve() if raw else None
    if target and not target.is_dir():
        target = None
    return target


def _compute_recommended_extractors(detection) -> list[str]:
    """Intersect detected frameworks/languages with EXTRACTOR_CATALOG.

    Each extractor in the catalog declares the frameworks it handles.
    A `*language` framework prefix (e.g. `*python`) means "always run
    when the language is present, regardless of framework" — used for
    manifest extractors like pyproject and package-json.
    """
    detected_fw_names = detection.framework_names()
    detected_lang_names = detection.language_names()

    recommended: list[str] = []
    for extractor in EXTRACTOR_CATALOG.values():
        for fw in extractor.frameworks:
            if fw.startswith("*"):  # language-wildcard
                tag = fw[1:]
                # `*any` — extractor is universal; runs whenever ANY language was detected.
                # `*python` matches detected python; `*node`/`*maven`/`*dotnet` matches by family.
                if tag == "any" and detected_lang_names:
                    recommended.append(extractor.name)
                    break
                if tag in detected_lang_names or _wildcard_matches_language(tag, detected_lang_names):
                    recommended.append(extractor.name)
                    break
            elif fw in detected_fw_names:
                recommended.append(extractor.name)
                break
            elif fw in detected_lang_names:
                # Framework name happens to equal a language id (rare).
                recommended.append(extractor.name)
                break

    # Deduplicate while preserving order.
    seen: set[str] = set()
    out: list[str] = []
    for n in recommended:
        if n not in seen:
            out.append(n); seen.add(n)
    return out


_LANGUAGE_FAMILY_ALIASES: dict[str, set[str]] = {
    "node":   {"javascript", "typescript"},
    "maven":  {"java"},
    "dotnet": {"csharp"},
}


def _wildcard_matches_language(tag: str, detected_languages: set[str]) -> bool:
    family = _LANGUAGE_FAMILY_ALIASES.get(tag, set())
    return bool(family & detected_languages)


def main() -> int:
    target = _parse_cli()
    out_path = _repo_root() / "output" / "framework-detector" / "framework-detection.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)

    if target is None:
        # Same convention as other extractor wrappers: write a skipped bundle, exit 0.
        skip_reason = (
            "no TARGET_CODEBASE set (or argv path missing) — "
            "skipping. Pass --codebase to testo scan."
        )
        print(f"[framework-detector] {skip_reason}", file=sys.stderr)
        out_path.write_text(json.dumps({
            "skipped": skip_reason,
            "detectorName": "deterministic",
            "languages": [],
            "frameworks": [],
            "recommendedExtractors": [],
        }, indent=2))
        return 0

    detector = DeterministicFrameworkDetector()
    print(
        f"[framework-detector] scanning {target} with detector={detector.name}…",
        flush=True,
    )
    result = detector.detect(target)
    result.recommended_extractors = _compute_recommended_extractors(result)

    bundle = json.loads(result.model_dump_json())
    # camelCase the recommended_extractors field for consistency with the other JS-side bundles.
    bundle["recommendedExtractors"] = bundle.pop("recommended_extractors")
    out_path.write_text(json.dumps(bundle, indent=2, default=str))

    print(
        f"[framework-detector] detected: "
        f"languages={[L['name'] for L in bundle['languages']]} "
        f"frameworks={[F['name'] for F in bundle['frameworks']]}",
        flush=True,
    )
    print(
        f"[framework-detector] recommended extractors ({len(bundle['recommendedExtractors'])}): "
        f"{bundle['recommendedExtractors']}",
        flush=True,
    )
    print(
        f"[framework-detector] wrote {out_path.relative_to(_repo_root())} "
        f"in {result.duration_ms:.0f}ms",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
