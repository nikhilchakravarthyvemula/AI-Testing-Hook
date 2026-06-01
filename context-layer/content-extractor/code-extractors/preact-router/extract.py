"""Preact Router extractor wrapper.

Thin shim: delegates to the bundled `PreactRouterExtractor` from
`_lib/testing_agent/...frontend/preact_router.py`. Run via:

    TARGET_CODEBASE=/abs/path/to/repo \
      ../_lib/.venv/bin/python extract.py

Output: `output/sources/preact-router.json`.
"""

from __future__ import annotations

import sys
from pathlib import Path

# Make the sibling `_lib/` importable regardless of cwd.
_LIB = Path(__file__).resolve().parents[2] / "_lib"
sys.path.insert(0, str(_LIB))

from run_extractor import run_extractor  # noqa: E402
from testing_agent.context_layer.sources.codebase.extractors.frontend.preact_router import (  # noqa: E402
    PreactRouterExtractor,
)


if __name__ == "__main__":
    run_extractor(source_id="preact-router", extractor=PreactRouterExtractor())
