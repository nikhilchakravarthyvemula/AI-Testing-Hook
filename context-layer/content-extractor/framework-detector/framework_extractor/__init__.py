"""framework_extractor — detect a codebase's languages/frameworks.

Runs FIRST in the content-extractor pipeline when --codebase is set.
Its output drives which code-extractors run next: a Python-only repo
shouldn't waste time running the 13 frontend extractors.

Public surface:
  * `IFrameworkExtractor`              — Protocol for detectors.
  * `FrameworkDetectionResult`         — output shape.
  * `DeterministicFrameworkDetector`   — fast, free, signal-based detection.
  * `LLMFrameworkDetector`             — agentic detection (catches edge cases).
  * `CompositeFrameworkDetector`       — runs deterministic, then LLM if thin.
  * `LLMTrigger`                       — ALWAYS / AUTO / NEVER for the LLM pass.

Default in `extract.py` is the composite with AUTO trigger.
"""

from .composite import CompositeFrameworkDetector, LLMTrigger
from .detector import DeterministicFrameworkDetector
from .interfaces import IFrameworkExtractor
from .llm_detector import LLMFrameworkDetector
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
    "LLMFrameworkDetector",
    "CompositeFrameworkDetector",
    "LLMTrigger",
]
