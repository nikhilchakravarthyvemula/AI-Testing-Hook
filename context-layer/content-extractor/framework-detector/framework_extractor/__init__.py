"""framework_extractor — detect a codebase's languages/frameworks.

Runs FIRST in the content-extractor pipeline when --codebase is set.
Its output drives which code-extractors run next: a Python-only repo
shouldn't waste time running the 13 frontend extractors.

Public surface:
  * `IFrameworkExtractor`              — Protocol for detectors.
  * `FrameworkDetectionResult`         — output shape.
  * `DeterministicFrameworkDetector`   — fast, free, signal-based detection.

Detection is fully deterministic (BYO-LLM architecture: no internal LLM).
"""

from .detector import DeterministicFrameworkDetector
from .interfaces import IFrameworkExtractor
from .models import (
    DetectedFramework,
    DetectedLanguage,
    DetectionSignal,
    FrameworkDetectionResult,
    SignalKind,
)

__all__ = [
    "IFrameworkExtractor",
    "FrameworkDetectionResult",
    "DetectedFramework",
    "DetectedLanguage",
    "DetectionSignal",
    "SignalKind",
    "DeterministicFrameworkDetector",
]
