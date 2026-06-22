"""Shared LLM backend resolver for content-extractor sources.

Single source of truth for "which LLM + key + endpoint" the doc/text
extractors use — so kg-gen (and the direct-call fallback) hit the SAME
backend the agentic-harness/graphify already use, with one set of keys.

Mirrors infrastructure/agentic-harness/agentic_harness/backends/catalog.py
(MiniMax → OpenAI → Kimi → Ollama; first whose api-key env is set wins;
Ollama is the no-key fallback). All providers expose an OpenAI-compatible
`/v1` endpoint, so we return a `litellm_model` of the form `openai/<model>`
plus `base_url` + `api_key` — which is exactly what kg-gen's LiteLLM layer
and a plain `openai` client both accept.

Override the auto-pick with TEXT_KG_BACKEND (or GRAPHIFY_BACKEND):
  minimax | openai | kimi | ollama
"""
from __future__ import annotations

import os
from pathlib import Path


def _minimax_base_url() -> str:
    # Region → host, matching scripts/graphify/with_minimax.py.
    region = os.environ.get("MINIMAX_REGION", "global").lower()
    return {
        "global": "https://api.minimaxi.chat/v1",
        "cn": "https://api.minimax.chat/v1",
    }.get(region, "https://api.minimaxi.chat/v1")


# kind → (base_url, default_model, api_key_env)
def _catalog() -> dict:
    return {
        "minimax": (
            _minimax_base_url(),
            os.environ.get("MINIMAX_MODEL")
            or os.environ.get("GRAPHIFY_MINIMAX_MODEL")
            or "MiniMax-M2.7",
            "MINIMAX_API_KEY",
        ),
        "openai": ("https://api.openai.com/v1", os.environ.get("OPENAI_MODEL") or "gpt-4o-mini", "OPENAI_API_KEY"),
        "kimi": ("https://api.moonshot.ai/v1", os.environ.get("KIMI_MODEL") or "moonshot-v1-32k", "KIMI_API_KEY"),
        "ollama": (os.environ.get("OPENHARNESS_BASE_URL") or "http://localhost:11434/v1",
                   os.environ.get("OLLAMA_MODEL") or "llama3.1:8b", None),
    }


_PRIORITY = ["minimax", "openai", "kimi", "ollama"]


def _maybe_load_dotenv() -> None:
    """Best-effort: load <repo>/.env so MINIMAX_API_KEY etc. are present
    (mirrors agentic-harness/bin/call_tool.py). No dependency on python-dotenv."""
    here = Path(__file__).resolve()
    repo = here.parents[3]  # _lib → content-extractor → context-layer → repo
    env = repo / ".env"
    if not env.exists():
        return
    for line in env.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        k, v = k.strip(), v.strip().strip('"').strip("'")
        if k and k not in os.environ:
            os.environ[k] = v


def resolve_backend() -> dict:
    """Return {backend, model, litellm_model, api_key, base_url}.

    Raises RuntimeError if the chosen/auto backend has no usable key (callers
    should fail loudly — mirror the harness's honesty rule)."""
    _maybe_load_dotenv()
    catalog = _catalog()

    override = (os.environ.get("TEXT_KG_BACKEND") or os.environ.get("GRAPHIFY_BACKEND") or "").lower()
    if override in ("local",):
        override = "ollama"

    chosen = None
    if override in catalog:
        chosen = override
    else:
        for kind in _PRIORITY:
            _, _, key_env = catalog[kind]
            if key_env is None or os.environ.get(key_env):
                chosen = kind
                break
    if chosen is None:
        chosen = "ollama"

    base_url, model, key_env = catalog[chosen]
    api_key = os.environ.get(key_env) if key_env else "ollama"
    if key_env and not api_key:
        raise RuntimeError(
            f"LLM backend '{chosen}' selected but {key_env} is not set. "
            f"Set {key_env} or pick another via TEXT_KG_BACKEND."
        )
    return {
        "backend": chosen,
        "model": model,
        "litellm_model": f"openai/{model}",   # all four expose OpenAI-compatible /v1
        "api_key": api_key,
        "base_url": base_url,
    }


if __name__ == "__main__":
    import json
    b = resolve_backend()
    safe = {**b, "api_key": ("<set>" if b["api_key"] else "<missing>")}
    print(json.dumps(safe, indent=2))
