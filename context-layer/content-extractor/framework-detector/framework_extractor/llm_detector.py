"""LLMFrameworkDetector — agentic detection via the agentic-harness.

Implements `IFrameworkExtractor`. Designed to catch what
`DeterministicFrameworkDetector` misses:
  * niche / new frameworks (Litestar, Robyn, Hono, ...)
  * custom company wrappers around standard frameworks
  * polyglot monorepos where the structure tells more than the manifests
  * ambiguous cases where two frameworks could fit

How it works:
  1. Spawn `testo/harness/bin/ask.py` as a subprocess.
  2. The prompt instructs the LLM to inspect the target using its
     toolbelt (bash, grep, glob, read_file) and then write a JSON file
     with detected languages + frameworks.
  3. We read that file, validate, and convert into FrameworkDetectionResult.

Strict honesty: if the LLM never writes the file, we report no findings
rather than fabricate any. The hybrid composite handles the fallback.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from .interfaces import IFrameworkExtractor
from .models import (
    DetectedFramework,
    DetectedLanguage,
    DetectionSignal,
    FrameworkDetectionResult,
    SignalKind,
)


# Where the LLM is asked to write its findings. Inside output/ so it's
# gitignored and easy to inspect later.
_LLM_OUTPUT_FILENAME = "framework-detection-llm-raw.json"

# Subprocess paths — both must exist for the LLM detector to run.
# This file: <repo>/context-layer/content-extractor/framework-detector/framework_extractor/llm_detector.py
#   parents[0]=framework_extractor/  parents[1]=framework-detector/
#   parents[2]=content-extractor/    parents[3]=context-layer/
#   parents[4]=<repo>
_REPO_ROOT = Path(__file__).resolve().parents[4]
_ASK_PY = _REPO_ROOT / "testo" / "harness" / "bin" / "ask.py"
_AGENTIC_PYTHON = _REPO_ROOT / "context-layer" / "content-extractor" / "_lib" / ".venv" / "bin" / "python"

_DEFAULT_TIMEOUT_S = 600   # 10 min cap; LLM detection on a normal repo takes ~1-3 min
_DEFAULT_MAX_TURNS = 30    # plenty for "scan + write JSON"


class LLMFrameworkDetector:
    """Implements IFrameworkExtractor by delegating to a free-agent LLM."""

    name = "llm-driven"
    confidence_floor = 0.40   # higher than deterministic — only trust strong LLM signals

    def __init__(
        self,
        *,
        ask_py: Path = _ASK_PY,
        python_bin: Path = _AGENTIC_PYTHON,
        timeout_s: int = _DEFAULT_TIMEOUT_S,
        max_turns: int = _DEFAULT_MAX_TURNS,
        allowed_frameworks: Optional[set[str]] = None,
        allowed_languages: Optional[set[str]] = None,
    ) -> None:
        self._ask_py = ask_py
        self._python_bin = python_bin
        self._timeout_s = timeout_s
        self._max_turns = max_turns
        # Optional allowlists keep the LLM honest — it has to use names
        # we actually have extractors for. If None, no constraint.
        self._allowed_frameworks = allowed_frameworks
        self._allowed_languages = allowed_languages

    # ── public ────────────────────────────────────────────────────────────

    def detect(self, target: Path) -> FrameworkDetectionResult:
        """Run the LLM agent against `target`; parse what it wrote.

        Raises:
            RuntimeError: ask.py is missing or its python interpreter isn't found.
                          (Caller decides whether to fall back to deterministic-only.)
        """
        target = target.resolve()
        if not target.is_dir():
            raise ValueError(f"target is not a directory: {target}")
        self._assert_subprocess_available()

        out_path = _REPO_ROOT / "output" / "code-extractors" / _LLM_OUTPUT_FILENAME
        out_path.parent.mkdir(parents=True, exist_ok=True)
        # Delete any stale output so we don't accidentally read it as fresh.
        if out_path.exists():
            out_path.unlink()

        prompt = self._build_prompt(target=target, out_path=out_path)

        started = time.monotonic()
        started_at = datetime.now(tz=timezone.utc)
        completed_pid = self._invoke_agent(prompt)
        elapsed_ms = (time.monotonic() - started) * 1000

        return self._parse_output(
            target=target,
            out_path=out_path,
            agent_exit_code=completed_pid,
            duration_ms=elapsed_ms,
            started_at=started_at,
        )

    # ── internals ─────────────────────────────────────────────────────────

    def _assert_subprocess_available(self) -> None:
        if not self._ask_py.is_file():
            raise RuntimeError(
                f"LLMFrameworkDetector: ask.py missing at {self._ask_py}"
            )
        if not self._python_bin.is_file():
            raise RuntimeError(
                f"LLMFrameworkDetector: python interpreter missing at "
                f"{self._python_bin} (expected context-layer/content-extractor/_lib/.venv with openharness installed)"
            )

    def _build_prompt(self, *, target: Path, out_path: Path) -> str:
        # Allowlists are emitted inline so the LLM is constrained to
        # names we have extractors for. Keep this short — every token
        # costs us either time or money.
        fw_list = (
            ", ".join(sorted(self._allowed_frameworks))
            if self._allowed_frameworks else "(any)"
        )
        lang_list = (
            ", ".join(sorted(self._allowed_languages))
            if self._allowed_languages else "(any)"
        )

        return (
            f"You are a codebase framework detector. Inspect this repo:\n"
            f"  {target}\n\n"
            f"Use your toolbelt (bash, grep, glob, read_file) — read manifests "
            f"(package.json, pyproject.toml, pom.xml, Cargo.toml, etc.), look at "
            f"directory layout, and sample a few source files for imports. "
            f"Do NOT call graphify; this is just a quick detection task.\n\n"
            f"When you have enough evidence, call write_file with this exact path:\n"
            f"  {out_path}\n\n"
            f"Write valid JSON matching this schema:\n"
            f"{{\n"
            f'  "languages": [\n'
            f'    {{ "name": "<lang>", "confidence": <0..1>, "evidence": "<short reason>" }}\n'
            f"  ],\n"
            f'  "frameworks": [\n'
            f'    {{ "name": "<framework>", "language": "<lang>", '
            f'"confidence": <0..1>, "evidence": "<short reason>" }}\n'
            f"  ]\n"
            f"}}\n\n"
            f"Constraints:\n"
            f"  * Language names allowed: {lang_list}\n"
            f"  * Framework names allowed: {fw_list}\n"
            f"  * Confidence is 0.0 - 1.0; only include findings >= 0.5\n"
            f"  * Be terse — short evidence strings, no commentary\n"
            f"  * Do not write any other files\n\n"
            f"After writing the JSON, reply with a one-line summary."
        )

    def _invoke_agent(self, prompt: str) -> int:
        """Spawn ask.py with the prompt. Return its exit code."""
        cmd = [
            str(self._python_bin),
            str(self._ask_py),
            prompt,
            "--max-turns", str(self._max_turns),
        ]
        print(
            f"[llm-detector] invoking ask.py (max_turns={self._max_turns}, "
            f"timeout={self._timeout_s}s)…",
            flush=True,
        )
        # `inherit` stdout/stderr so the user sees the agent stream live.
        # Caller can capture via shell redirect if they want a transcript.
        env = os.environ.copy()
        try:
            completed = subprocess.run(  # noqa: S603 — args are absolute, no shell
                cmd, env=env, check=False, timeout=self._timeout_s,
            )
        except subprocess.TimeoutExpired:
            print(
                f"[llm-detector] TIMEOUT after {self._timeout_s}s — "
                f"treating as no findings",
                file=sys.stderr, flush=True,
            )
            return 124
        return completed.returncode

    def _parse_output(
        self,
        *,
        target: Path,
        out_path: Path,
        agent_exit_code: int,
        duration_ms: float,
        started_at: datetime,
    ) -> FrameworkDetectionResult:
        """Read the JSON the LLM wrote; convert to a FrameworkDetectionResult.

        Returns an EMPTY (no-findings) result if the agent didn't produce
        a file or wrote unparseable data. Honesty over fabrication.
        """
        result = FrameworkDetectionResult(
            target=str(target),
            detector_name=self.name,
            detected_at=started_at,
            duration_ms=duration_ms,
        )

        if not out_path.is_file():
            print(
                f"[llm-detector] no output file at {out_path} "
                f"(agent exit={agent_exit_code}) — returning empty result",
                file=sys.stderr, flush=True,
            )
            return result

        try:
            raw = json.loads(out_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as exc:
            print(
                f"[llm-detector] unparseable output ({exc}) — empty result",
                file=sys.stderr, flush=True,
            )
            return result

        result.languages = self._parse_languages(raw.get("languages") or [])
        result.frameworks = self._parse_frameworks(raw.get("frameworks") or [])
        return result

    def _parse_languages(self, items: list) -> list[DetectedLanguage]:
        out: list[DetectedLanguage] = []
        for it in items:
            if not isinstance(it, dict):
                continue
            name = (it.get("name") or "").strip().lower()
            confidence = _clamp_confidence(it.get("confidence"))
            if not name or confidence < self.confidence_floor:
                continue
            if self._allowed_languages and name not in self._allowed_languages:
                continue
            out.append(DetectedLanguage(
                name=name,
                file_count=0,  # LLM doesn't count files; deterministic fills this in on merge.
                signals=[DetectionSignal(
                    kind=SignalKind.IMPORT_STATEMENT,
                    value=str(it.get("evidence") or "(LLM-detected)"),
                    weight=confidence,
                )],
                confidence=confidence,
            ))
        return out

    def _parse_frameworks(self, items: list) -> list[DetectedFramework]:
        out: list[DetectedFramework] = []
        for it in items:
            if not isinstance(it, dict):
                continue
            name = (it.get("name") or "").strip().lower()
            lang = (it.get("language") or "").strip().lower()
            confidence = _clamp_confidence(it.get("confidence"))
            if not name or confidence < self.confidence_floor:
                continue
            if self._allowed_frameworks and name not in self._allowed_frameworks:
                continue
            out.append(DetectedFramework(
                name=name,
                language=lang or "unknown",
                signals=[DetectionSignal(
                    kind=SignalKind.IMPORT_STATEMENT,
                    value=str(it.get("evidence") or "(LLM-detected)"),
                    weight=confidence,
                )],
                confidence=confidence,
            ))
        return out


def _clamp_confidence(value) -> float:
    """Coerce arbitrary JSON value to a 0..1 float; out-of-range → 0.0."""
    try:
        c = float(value)
    except (TypeError, ValueError):
        return 0.0
    if c != c:  # NaN
        return 0.0
    return max(0.0, min(1.0, c))


__all__ = ["LLMFrameworkDetector"]
