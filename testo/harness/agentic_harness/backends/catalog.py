"""Backend catalog — the single source of truth for which LLM providers exist.

Adding a backend means:
  1. Add a `BackendKind` member to `enums.py`.
  2. Add a row here in `BACKEND_CATALOG` AND `BACKEND_PRIORITY`.
  3. Add a row to `DEFAULT_CONCURRENCY` if it differs from the default.

Nothing else changes — `BackendResolver` reads from this catalog,
`AgenticHarness` reads from the resolved `BackendConfig`, callers
never look at the catalog directly.
"""

from __future__ import annotations

import os

from ..enums import BackendKind
from ..models import BackendConfig


# ── catalog ────────────────────────────────────────────────────────────────


def _ollama_base_url() -> str:
    """Read Ollama's base URL at import time so OPENHARNESS_BASE_URL still works."""
    return os.environ.get("OPENHARNESS_BASE_URL") or "http://localhost:11434/v1"


BACKEND_CATALOG: dict[BackendKind, BackendConfig] = {
    BackendKind.MINIMAX: BackendConfig(
        kind=BackendKind.MINIMAX,
        base_url="https://api.minimaxi.chat/v1",
        default_model="MiniMax-M2.7",
        api_key_env="MINIMAX_API_KEY",
    ),
    BackendKind.OPENAI: BackendConfig(
        kind=BackendKind.OPENAI,
        base_url="https://api.openai.com/v1",
        default_model="gpt-4o-mini",
        api_key_env="OPENAI_API_KEY",
    ),
    BackendKind.KIMI: BackendConfig(
        kind=BackendKind.KIMI,
        base_url="https://api.moonshot.ai/v1",
        default_model="moonshot-v1-32k",
        api_key_env="KIMI_API_KEY",
    ),
    BackendKind.OLLAMA: BackendConfig(
        kind=BackendKind.OLLAMA,
        base_url=_ollama_base_url(),
        default_model="llama3.1:8b",
        api_key_env=None,
    ),
}


# Priority for auto-detection — first backend whose api_key_env is set
# in process env wins. Ollama always sits at the end as the no-key fallback.
BACKEND_PRIORITY: list[BackendKind] = [
    BackendKind.MINIMAX,
    BackendKind.OPENAI,
    BackendKind.KIMI,
    BackendKind.OLLAMA,
]


# How many semantic chunks the harness can run in parallel.
# Local LLMs serialise cleanly at 1; hosted backends shine with 4+.
DEFAULT_CONCURRENCY: dict[BackendKind, int] = {
    BackendKind.MINIMAX: 4,
    BackendKind.OPENAI: 4,
    BackendKind.KIMI: 4,
    BackendKind.OLLAMA: 1,
}


__all__ = ["BACKEND_CATALOG", "BACKEND_PRIORITY", "DEFAULT_CONCURRENCY"]
