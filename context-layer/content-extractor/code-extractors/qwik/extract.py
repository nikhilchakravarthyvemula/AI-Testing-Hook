"""Qwik extractor wrapper.

Thin shim: delegates to the bundled `QwikExtractor` from
`_lib/testing_agent/...frontend/qwik.py`. Run via:

    TARGET_CODEBASE=/abs/path/to/repo \
      ../_lib/.venv/bin/python extract.py

Output: `output/sources/qwik.json`.
"""

from __future__ import annotations

import sys
from pathlib import Path

# Make the sibling `_lib/` importable regardless of cwd.
_LIB = Path(__file__).resolve().parents[2] / "_lib"
sys.path.insert(0, str(_LIB))

from run_extractor import run_extractor  # noqa: E402
from testing_agent.context_layer.sources.codebase.extractors.frontend.qwik import (  # noqa: E402
    QwikExtractor,
)


if __name__ == "__main__":
    run_extractor(source_id="qwik", extractor=QwikExtractor())
