"""CompositeFrameworkDetector — hybrid detection: deterministic first, LLM second.

Decision policy (`LLMTrigger`):
  ALWAYS   — always run the LLM pass (slow + costs API calls)
  AUTO     — run LLM only when deterministic findings look thin:
               * detected languages but zero frameworks, OR
               * max framework confidence < AUTO_THRESHOLD
  NEVER    — skip LLM entirely

Merge policy:
  * Union of language + framework findings
  * When the same name appears in both detectors:
      - keep the one with higher confidence
      - merge their signals lists (preserve evidence from each)
  * Result.detector_name = "composite" so callers can tell what ran
"""

from __future__ import annotations

import sys
import time
from datetime import datetime, timezone
from enum import StrEnum
from pathlib import Path
from typing import Optional

from .detector import DeterministicFrameworkDetector
from .interfaces import IFrameworkExtractor
from .llm_detector import LLMFrameworkDetector
from .models import (
    DetectedFramework,
    DetectedLanguage,
    FrameworkDetectionResult,
)


class LLMTrigger(StrEnum):
    """When the composite detector should run the LLM pass."""

    ALWAYS = "always"
    AUTO = "auto"
    NEVER = "never"


# Heuristic thresholds used by AUTO trigger.
_AUTO_LOW_CONFIDENCE = 0.65


class CompositeFrameworkDetector:
    """Implements `IFrameworkExtractor` — runs both detectors and merges."""

    name = "composite"
    confidence_floor = 0.30   # mirrors deterministic; LLM has its own internal floor

    def __init__(
        self,
        *,
        deterministic: Optional[IFrameworkExtractor] = None,
        llm: Optional[IFrameworkExtractor] = None,
        trigger: LLMTrigger = LLMTrigger.AUTO,
    ) -> None:
        self._deterministic = deterministic or DeterministicFrameworkDetector()
        self._llm = llm                    # lazy — instantiate only if trigger requires
        self._trigger = trigger

    # ── public ────────────────────────────────────────────────────────────

    def detect(self, target: Path) -> FrameworkDetectionResult:
        target = target.resolve()
        if not target.is_dir():
            raise ValueError(f"target is not a directory: {target}")

        started = time.monotonic()
        started_at = datetime.now(tz=timezone.utc)

        det_result = self._deterministic.detect(target)
        print(
            f"[composite] deterministic: "
            f"{len(det_result.languages)} languages, "
            f"{len(det_result.frameworks)} frameworks "
            f"({det_result.duration_ms:.0f}ms)",
            flush=True,
        )

        if not self._should_run_llm(det_result):
            print(
                f"[composite] LLM pass skipped (trigger={self._trigger.value}, "
                f"max_fw_confidence={_max_framework_confidence(det_result):.2f})",
                flush=True,
            )
            return self._tag_as_composite(det_result, started_at, started)

        llm_result = self._safe_llm_detect(target)
        if llm_result is None:
            return self._tag_as_composite(det_result, started_at, started)

        print(
            f"[composite] llm:           "
            f"{len(llm_result.languages)} languages, "
            f"{len(llm_result.frameworks)} frameworks "
            f"({llm_result.duration_ms:.0f}ms)",
            flush=True,
        )

        merged = self._merge(det_result, llm_result, started_at=started_at)
        merged.duration_ms = (time.monotonic() - started) * 1000
        return merged

    # ── internals ─────────────────────────────────────────────────────────

    def _should_run_llm(self, det_result: FrameworkDetectionResult) -> bool:
        if self._trigger is LLMTrigger.ALWAYS:
            return True
        if self._trigger is LLMTrigger.NEVER:
            return False
        # AUTO: run LLM when deterministic is thin.
        if det_result.languages and not det_result.frameworks:
            return True
        return _max_framework_confidence(det_result) < _AUTO_LOW_CONFIDENCE

    def _safe_llm_detect(self, target: Path) -> Optional[FrameworkDetectionResult]:
        """Run the LLM detector with full error containment.

        The composite never fails because the LLM pass failed — it just
        returns the deterministic result. That keeps the pipeline robust
        when the API is down, the key is expired, etc.
        """
        try:
            llm = self._llm or LLMFrameworkDetector()
            return llm.detect(target)
        except Exception as exc:  # noqa: BLE001 — boundary; anything goes back to deterministic
            print(
                f"[composite] LLM pass failed ({type(exc).__name__}: {exc}) — "
                f"falling back to deterministic-only.",
                file=sys.stderr, flush=True,
            )
            return None

    def _tag_as_composite(
        self,
        result: FrameworkDetectionResult,
        started_at: datetime,
        started_monotonic: float,
    ) -> FrameworkDetectionResult:
        """Return `result` with composite metadata even if no LLM ran."""
        result.detector_name = self.name
        result.detected_at = started_at
        result.duration_ms = (time.monotonic() - started_monotonic) * 1000
        return result

    def _merge(
        self,
        det: FrameworkDetectionResult,
        llm: FrameworkDetectionResult,
        *,
        started_at: datetime,
    ) -> FrameworkDetectionResult:
        # Languages — keyed by name, take the higher confidence, union signals.
        lang_index: dict[str, DetectedLanguage] = {L.name: L for L in det.languages}
        for L in llm.languages:
            existing = lang_index.get(L.name)
            if existing is None:
                lang_index[L.name] = L
                continue
            lang_index[L.name] = DetectedLanguage(
                name=L.name,
                file_count=max(existing.file_count, L.file_count),
                signals=[*existing.signals, *L.signals],
                confidence=max(existing.confidence, L.confidence),
            )

        # Frameworks — same merge strategy, keyed by name.
        fw_index: dict[str, DetectedFramework] = {F.name: F for F in det.frameworks}
        for F in llm.frameworks:
            existing = fw_index.get(F.name)
            if existing is None:
                fw_index[F.name] = F
                continue
            fw_index[F.name] = DetectedFramework(
                name=F.name,
                language=existing.language or F.language,
                signals=[*existing.signals, *F.signals],
                confidence=max(existing.confidence, F.confidence),
            )

        return FrameworkDetectionResult(
            target=det.target,
            detector_name=self.name,
            detected_at=started_at,
            duration_ms=0.0,   # set by caller
            languages=sorted(lang_index.values(), key=lambda L: -L.confidence),
            frameworks=sorted(fw_index.values(), key=lambda F: -F.confidence),
        )


def _max_framework_confidence(result: FrameworkDetectionResult) -> float:
    if not result.frameworks:
        return 0.0
    return max(F.confidence for F in result.frameworks)


__all__ = ["CompositeFrameworkDetector", "LLMTrigger"]
