"""Angular Router extractor wrapper.

Thin shim: delegates to the bundled `AngularRouterExtractor` from
`_lib/testing_agent/...frontend/angular_router.py`. Run via:

    TARGET_CODEBASE=/abs/path/to/repo \
      ../_lib/.venv/bin/python extract.py

Output: `output/sources/angular-router.json`.
"""

from __future__ import annotations

import sys
from pathlib import Path

# Make the sibling `_lib/` importable regardless of cwd.
_LIB = Path(__file__).resolve().parents[2] / "_lib"
sys.path.insert(0, str(_LIB))

from run_extractor import run_extractor  # noqa: E402
from testing_agent.context_layer.sources.codebase.extractors.frontend.angular_router import (  # noqa: E402
    AngularRouterExtractor,
)


if __name__ == "__main__":
    run_extractor(source_id="angular-router", extractor=AngularRouterExtractor())
