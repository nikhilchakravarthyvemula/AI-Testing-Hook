"""S4 bridge — the Python side of the Node connector (p0-02 §3.4, OQ-5).

graphify's semantic enrichment is Python and cannot ``import`` the Node
``complete()`` connector. Instead it shells to ``bin/complete.mjs`` through this
tiny, dependency-free (stdlib only) client, so an S4 call inherits the run's
content cache, ledger line, and budget cap — one connector, audited once,
regardless of the caller's language.

Usage (the QueryEngine replacement the spec calls ``single_call("S4", …)``)::

    from s4_bridge import s4_complete, BridgeError

    try:
        res = s4_complete(prompt=PROMPT, workspace=RUN_DIR, schema=SCHEMA)
    except BridgeError:
        res = {"ok": False}            # bridge misinvoked → treat as unavailable

    if res.get("ok"):
        enrich_graph(res["json"])      # use the engine's answer
    else:
        # engine down / budget spent — graphify's raw-AST graph is the fallback
        keep_raw_ast_graph()

Design mirrors the bridge's exit-code contract: a structured ``{"ok": False}``
result (engine unavailable / budget spent) is a NORMAL outcome the caller falls
back on; only a malformed invocation or a failure to launch Node raises
``BridgeError``.
"""

from __future__ import annotations

import json
import os
import subprocess

_HERE = os.path.dirname(os.path.abspath(__file__))
# graphify -> content-extractor -> context-layer -> <repo root>
_REPO_ROOT = os.path.abspath(os.path.join(_HERE, "..", "..", ".."))
_DEFAULT_BRIDGE = os.path.join(
    _REPO_ROOT, "infrastructure", "model-api-connector", "bin", "complete.mjs"
)


class BridgeError(Exception):
    """The bridge was called wrong or Node could not be launched.

    This is a bug on the caller's side (or a broken environment), NOT an engine
    outcome — engine problems come back as ``{"ok": False, "error": ...}``.
    """


def s4_complete(
    prompt,
    workspace,
    *,
    use_case="S4",
    schema=None,
    system=None,
    provider=None,
    model=None,
    max_requests=None,
    cache_key=None,
    node_bin=None,
    bridge_path=None,
    timeout=180,
):
    """Make one single-shot call through the Node connector.

    Returns the parsed result dict — ``{"ok": True, "json"|"text": ..., ...}`` or
    ``{"ok": False, "error": ..., "detail": ...}``. Raises :class:`BridgeError`
    only on a malformed invocation (bridge exit 2) or a launch/timeout failure.
    """
    payload = {"useCase": use_case, "prompt": prompt, "workspace": workspace}
    if schema is not None:
        payload["schema"] = schema
    if system is not None:
        payload["system"] = system
    if provider is not None:
        payload["provider"] = provider
    if model is not None:
        payload["model"] = model
    if max_requests is not None:
        payload["maxRequests"] = max_requests
    if cache_key is not None:
        payload["cacheKey"] = cache_key

    argv = [node_bin or os.environ.get("NODE_BIN", "node"), bridge_path or _DEFAULT_BRIDGE]

    try:
        proc = subprocess.run(
            argv,
            input=json.dumps(payload),
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except FileNotFoundError as e:
        raise BridgeError(f"could not launch Node bridge: {e}") from e
    except subprocess.TimeoutExpired as e:
        raise BridgeError(f"bridge timed out after {timeout}s") from e

    stdout = (proc.stdout or "").strip()
    try:
        result = json.loads(stdout.splitlines()[-1]) if stdout else None
    except (ValueError, IndexError) as e:
        raise BridgeError(
            f"bridge returned no parseable JSON (exit {proc.returncode}): "
            f"{stdout!r} / stderr={proc.stderr!r}"
        ) from e

    if result is None:
        raise BridgeError(f"bridge produced no output (exit {proc.returncode})")

    # exit 2 == bad-request: a caller bug, surfaced as an exception, not a result.
    if proc.returncode == 2 or result.get("error") == "bad-request":
        raise BridgeError(f"bad request to bridge: {result.get('detail')}")

    return result
