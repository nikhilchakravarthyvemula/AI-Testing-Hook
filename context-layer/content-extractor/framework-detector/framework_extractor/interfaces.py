"""IFrameworkExtractor — contract for "scan a codebase, tell me what it uses".

Two implementations are planned:
  * DeterministicFrameworkDetector  — file extensions + manifest files (today)
  * LLMFrameworkDetector            — agentic-harness asks an LLM (future)

Both produce a FrameworkDetectionResult. Downstream consumers (the
orchestrator) don't care which detector ran — they just read the result
and pick code-extractors that match.
"""

from __future__ import annotations

from pathlib import Path
from typing import Protocol, runtime_checkable

from .models import FrameworkDetectionResult


@runtime_checkable
class IFrameworkExtractor(Protocol):
    """Anything that can answer 'what frameworks does this codebase use?'.

    Attributes:
        name         Stable id, e.g. "deterministic".
        confidence_floor
                     Detectors should suppress findings below this score
                     so noisy signals don't trigger spurious extractors.

    Methods:
        detect(target)   Walk the target and emit a FrameworkDetectionResult.
                         May be slow on huge repos; callers run in subprocess.
    """

    name: str
    confidence_floor: float

    def detect(self, target: Path) -> FrameworkDetectionResult: ...
