"""Runtime bootstrap for the testo REPL.

Importing this module (before any `agentic_harness` import) does two things,
mirroring bin/ask.py so behaviour is identical:
  1. put <repo>/testo/harness on sys.path so `agentic_harness`
     imports without installing it;
  2. load <repo>/.env into os.environ (only keys not already set) so
     MINIMAX_API_KEY etc. are available.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

# testo/ lives at the repo root, so the repo is this file's parent's parent.
REPO_ROOT = Path(__file__).resolve().parents[1]
_AGENTIC = REPO_ROOT / "testo" / "harness"

if str(_AGENTIC) not in sys.path:
    sys.path.insert(0, str(_AGENTIC))


def _load_repo_env() -> None:
    env = REPO_ROOT / ".env"
    if not env.is_file():
        return
    for raw in env.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        k = k.strip()
        v = v.strip().strip('"').strip("'")
        if k and v and not os.environ.get(k):
            os.environ[k] = v


_load_repo_env()
