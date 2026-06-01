"""Launcher that adds a `minimax` backend to graphify and then runs graphify's CLI.

Graphify ships with `gemini|kimi|claude|openai|ollama|bedrock` backends —
no `minimax`. But MiniMax exposes an OpenAI-compatible endpoint at
`<base>/chat/completions`, and graphify's openai-compat code path is
generic — it just takes (base_url, api_key, model). So we can register
a new `minimax` entry in `graphify.llm.BACKENDS` at import time, then
forward all CLI args to graphify's normal entrypoint.

Why a launcher and not a runtime monkey-patch in `tool.py`?
`tool.py` invokes graphify as a subprocess, so process-level patches
don't reach graphify. This file IS the subprocess — patch lands first,
then `graphify.__main__.main()` runs.

Usage from tool.py:
  python scripts/graphify/with_minimax.py extract <path> --backend minimax …

Env vars consulted:
  MINIMAX_API_KEY    required
  MINIMAX_MODEL      default model (else "MiniMax-Text-01")
  MINIMAX_REGION     "global" (default) → api.minimaxi.chat
                     "cn"               → api.minimax.chat
"""
from __future__ import annotations

import os
import re
import sys

import openai as _openai_module
from graphify import llm as _graphify_llm
from openai import OpenAI as _RealOpenAI


# ── <think> block stripper ────────────────────────────────────────────────
#
# MiniMax-M2.7 (the Token Plan's only supported model) is a REASONING model
# — every response is wrapped in `<think>...lots of reasoning...</think>`
# before the actual content. Graphify calls `json.loads(content)` on the
# raw string, so it fails immediately on the leading `<` character.
#
# We solve it without forking graphify by monkey-patching the OpenAI
# Python SDK: a thin wrapper around `OpenAI` returns response objects
# whose `.choices[i].message.content` has had `<think>...</think>` blocks
# stripped out. Graphify then sees clean JSON.

# Greedy match, dot includes newlines. Strip trailing whitespace too so
# the JSON parser sees a clean opening brace as char 0.
_THINK_BLOCK_RE = re.compile(r"<think>.*?</think>\s*", re.DOTALL)
# Also handle the unclosed-think case (model hits max_tokens mid-think):
# strip from `<think>` to end-of-string so we at least don't crash.
_OPEN_THINK_RE = re.compile(r"<think>.*\Z", re.DOTALL)


def _strip_think(content: str | None) -> str | None:
    if not content:
        return content
    out = _THINK_BLOCK_RE.sub("", content)
    out = _OPEN_THINK_RE.sub("", out)
    return out.strip()


class _ThinkStrippingCompletions:
    """Wraps `openai.OpenAI().chat.completions` so its create() output has
    `<think>` blocks removed. Everything else forwards unchanged."""

    def __init__(self, real):
        self._real = real

    def create(self, *args, **kwargs):
        response = self._real.create(*args, **kwargs)
        try:
            for choice in response.choices:
                # response.choices[i].message.content is a regular str field
                # on the OpenAI Pydantic model — direct assignment works.
                if getattr(choice, "message", None) and getattr(choice.message, "content", None):
                    choice.message.content = _strip_think(choice.message.content)
        except Exception:  # noqa: BLE001
            # Never let our shim break the underlying response. If the SDK
            # ever changes shape, fall through with the original object.
            pass
        return response

    def __getattr__(self, name):
        return getattr(self._real, name)


class _ThinkStrippingChat:
    def __init__(self, real):
        self._real = real
        self.completions = _ThinkStrippingCompletions(real.completions)

    def __getattr__(self, name):
        return getattr(self._real, name)


class _ThinkStrippingOpenAI:
    """Drop-in replacement for `openai.OpenAI` that auto-strips `<think>`
    blocks from chat completion responses."""

    def __init__(self, *args, **kwargs):
        self._real = _RealOpenAI(*args, **kwargs)
        self.chat = _ThinkStrippingChat(self._real.chat)

    def __getattr__(self, name):
        return getattr(self._real, name)


# Install the shim at module scope so all subsequent `from openai import OpenAI`
# inside graphify (it imports lazily, per-call) pick up the patched class.
_openai_module.OpenAI = _ThinkStrippingOpenAI

_REGION_BASE_URLS = {
    "global": "https://api.minimaxi.chat/v1",
    "cn":     "https://api.minimax.chat/v1",
}

_region = os.environ.get("MINIMAX_REGION", "global")
_base_url = _REGION_BASE_URLS.get(_region, _REGION_BASE_URLS["global"])

# Register `minimax` exactly the way graphify registers `openai` — both
# go through `_call_openai_compat`. The only differences are:
#   * base_url      → MiniMax's OpenAI-compat endpoint
#   * default_model → MiniMax-Text-01 (or whatever the user sets)
#   * env_key       → MINIMAX_API_KEY
#   * pricing       → MiniMax's actual rates so graphify's cost preview
#                     stays honest if it ever surfaces one
_graphify_llm.BACKENDS["minimax"] = {
    "base_url":       _base_url,
    "default_model":  os.environ.get("MINIMAX_MODEL", "MiniMax-Text-01"),
    "env_key":        "MINIMAX_API_KEY",
    "model_env_key":  "MINIMAX_MODEL",
    "pricing":        {"input": 0.20, "output": 1.10},  # USD per 1M tokens, approx
    "temperature":    0,
}

# Now hand off to graphify's CLI. We strip our own program name so
# graphify sees the same argv it'd see if the user typed
# `graphify <subcommand> …` directly.
sys.argv = ["graphify", *sys.argv[1:]]
from graphify.__main__ import main as _graphify_main  # noqa: E402

if __name__ == "__main__":
    _graphify_main()
