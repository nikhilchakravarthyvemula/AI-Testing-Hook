# framework-detector

Detects which **languages and frameworks** a codebase uses, then tells
the orchestrator which `code-extractors/` to run.

This is the gatekeeper that prevents the orchestrator from wastefully
running the 13 frontend extractors on a Python-only repo.

## Layout

```
framework-detector/
├── framework_extractor/        ← importable package
│   ├── interfaces.py           IFrameworkExtractor (Protocol)
│   ├── models.py               DetectionSignal, DetectedFramework,
│   │                           DetectedLanguage, FrameworkDetectionResult
│   └── detector.py             DeterministicFrameworkDetector (v1)
│
├── extract.py                  CLI entrypoint
└── README.md
```

## What it does

```
python framework-detector/extract.py /path/to/repo
   ↓
output/sources/framework-detection.json
{
  "target": "/path/to/repo",
  "detectorName": "deterministic",
  "languages": [{ name, fileCount, confidence, signals[] }, ...],
  "frameworks": [{ name, language, confidence, signals[] }, ...],
  "recommendedExtractors": ["python-fastapi", "nextjs-app", ...]
}
```

## Signals it consumes (no LLM, no network)

| Signal | Weight | Example |
|---|---|---|
| Manifest dependency | 0.95 | `package.json` declares `"next": "^15"` → `nextjs` |
| Config file present | 0.75 | `next.config.js` → `nextjs` |
| Directory convention | 0.75 | `app/layout.tsx` → `nextjs` |
| Import statement | 0.4–0.85 | sampled file has `from fastapi import` → `fastapi` |
| File-extension count | 0.0–1.0 | 142 `.py` files → `python` language |

Findings below `confidence_floor` (0.30) are dropped to suppress noisy
signals.

## How `recommendedExtractors` is computed

1. Detector emits detected languages + frameworks.
2. `extract.py` intersects the detection with
   `../code-extractors/code_extractors/catalog.py:EXTRACTOR_CATALOG`.
3. Each catalog entry declares the frameworks/languages it handles:
   * Exact match: `python-fastapi` declares `frameworks=("fastapi",)` →
     runs when `fastapi` is detected.
   * Wildcard match: `pyproject` declares `frameworks=("*python",)` →
     runs whenever Python is detected, regardless of framework. Useful
     for per-language manifest extractors.

## Adding a new detector

1. Implement `IFrameworkExtractor`:
   ```python
   class MyDetector:
       name = "llm-driven"
       confidence_floor = 0.3
       def detect(self, target: Path) -> FrameworkDetectionResult: ...
   ```
2. Wire it into `extract.py` (today the detector is hard-picked; flag
   support comes when we have a second one).

## Verification

```bash
./context-layer/content-extractor/_lib/.venv/bin/python \
  context-layer/content-extractor/framework-detector/extract.py \
  /path/to/your/repo

# Then look at:
cat output/sources/framework-detection.json | jq '.recommendedExtractors'
```
