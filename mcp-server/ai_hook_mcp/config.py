"""Locate the AI testing-hook harness (the pipeline this server drives).

The MCP server does NOT re-implement crawling/extraction — it drives the harness.
Resolution order:
  1. AI_HOOK_ROOT env var (explicit; for installed / non-adjacent layouts)
  2. walk up from this file for the marker `context-layer/content-extractor/run.mjs`
     (works when this repo is nested inside, or a sibling of, the harness checkout)
"""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

_MARKER = Path("context-layer") / "content-extractor" / "run.mjs"


@lru_cache(maxsize=1)
def harness_root() -> Path:
    env = os.environ.get("AI_HOOK_ROOT")
    if env:
        root = Path(env).expanduser().resolve()
        if not (root / _MARKER).is_file():
            raise RuntimeError(f"AI_HOOK_ROOT={root} has no {_MARKER} — not a harness checkout")
        return root

    here = Path(__file__).resolve()
    for p in here.parents:
        if (p / _MARKER).is_file():
            return p
        # also check siblings of each ancestor (repo cloned beside the harness)
        parent = p.parent
        if parent.exists():
            for sib in parent.iterdir():
                if sib.is_dir() and (sib / _MARKER).is_file():
                    return sib.resolve()
    raise RuntimeError(
        "Could not find the AI-hook harness. Set AI_HOOK_ROOT to the checkout that "
        f"contains {_MARKER}."
    )


def output_dir() -> Path:
    return harness_root() / "output"
