"""Build a curl command (as a list[str]) from an indexed API item.

Output is structured (list of argv) — easier than string-building when
quoting matters. We pass these to test_runner.execute(), which uses
subprocess directly. A pretty-printed shell version is rendered too,
for writing into the per-test .sh files.
"""

from __future__ import annotations

import json
import shlex
from typing import Any, Optional


# Headers we never inject from the captured samples — they're either
# specific to a prior request (cookie/auth tokens) or browser-specific
# noise (origin/referer/user-agent) that we set ourselves.
_DROP_HEADER_NAMES = frozenset({
    "host", "content-length", "connection",
    "user-agent", "accept-encoding",
    "cookie", "authorization",          # auth handled separately by caller
    "origin", "referer",
    "x-forwarded-for", "x-forwarded-proto", "x-real-ip",
})


def build_curl(
    *,
    base_url: str,
    api_item: dict,
    body: Optional[dict],
    auth_token: Optional[str] = None,
    auth_scheme: str = "Bearer",
    extra_headers: Optional[dict[str, str]] = None,
    timeout_s: int = 30,
    path_params: Optional[dict[str, Any]] = None,
) -> tuple[list[str], str]:
    """Return (argv, pretty_shell_string).

    `argv` carries the LITERAL token — used by the runner right now.
    `pretty_shell_string` swaps in `${AUTH_TOKEN}` so the saved .sh files
    are re-runnable later (token can be refreshed via _login.sh)."""
    primary = api_item.get("primary") or {}
    method = (primary.get("method") or "GET").upper()
    path = primary.get("path") or "/"

    # Substitute {param} / :param placeholders with values from path_params
    # (we use synthesized realistic-looking ints; caller may override).
    resolved_path = _resolve_path_params(path, path_params or {})
    url = base_url.rstrip("/") + "/" + resolved_path.lstrip("/")

    # Collect headers from prior observations (sample headers we captured).
    headers = _collect_headers(api_item)
    if extra_headers:
        headers.update(extra_headers)
    if auth_token:
        headers["Authorization"] = f"{auth_scheme} {auth_token}"

    # If we're sending a JSON body, force content-type.
    if body is not None and method != "GET":
        headers.setdefault("Content-Type", "application/json")
    headers.setdefault("Accept", "application/json")

    argv: list[str] = [
        "curl", "-sS",                                # silent but show errors
        "-X", method,
        "--max-time", str(timeout_s),
        "-o", "-",                                    # body to stdout
        # -D - dumps the response status line + headers to stdout, framed so
        # test_runner.py can pull them back out cleanly.
        "-D", "/dev/stderr",
        "-w", (
            "\\n__HTTP_STATUS__=%{http_code}"
            "\\n__TIMING__=%{time_total}"
            "\\n__CONTENT_TYPE__=%{content_type}\\n"
        ),
    ]
    for k, v in headers.items():
        argv += ["-H", f"{k}: {v}"]
    if body is not None and method != "GET":
        argv += ["--data", json.dumps(body)]
    argv.append(url)

    # Render two views:
    #   * argv     — runs NOW with the literal JWT (subprocess.execute)
    #   * pretty   — saved to disk with `${AUTH_TOKEN}` placeholder so the
    #                file is re-runnable later after _login.sh refreshes
    pretty_argv = [*argv]
    if auth_token:
        # Swap "Bearer <literal>" → "Bearer ${AUTH_TOKEN}" in the pretty copy.
        needle = f"{auth_scheme} {auth_token}"
        for i, tok in enumerate(pretty_argv):
            if isinstance(tok, str) and needle in tok:
                pretty_argv[i] = tok.replace(needle, f"{auth_scheme} ${{AUTH_TOKEN}}")
    pretty = _render_shell(pretty_argv)
    return argv, pretty


def _collect_headers(api_item: dict) -> dict[str, str]:
    """Merge per-observation sampleRequestHeaders, dropping noise + auth."""
    result: dict[str, str] = {}
    for obs in (api_item.get("observations") or []):
        samples = (obs.get("fields") or {}).get("sampleRequestHeaders") or {}
        for name, values in samples.items():
            if not isinstance(values, list) or not values:
                continue
            name_l = name.lower()
            if name_l in _DROP_HEADER_NAMES:
                continue
            # Header names are stored lowercase; we pick the first sample.
            first_val = values[0]
            if not isinstance(first_val, str) or "<redacted>" in first_val:
                continue
            # Title-case canonical name (Content-Type vs content-type).
            canonical = "-".join(w.capitalize() for w in name.split("-"))
            result.setdefault(canonical, first_val)
    return result


def _resolve_path_params(path: str, params: dict[str, Any]) -> str:
    """Substitute {name} / :name placeholders. Unmapped placeholders → '1'."""
    import re
    def sub(match):
        name = match.group(1) or match.group(2)
        if name in params:
            return str(params[name])
        return "1"
    return re.sub(r"\{(\w+)\}|:(\w+)", sub, path)


def _render_shell(argv: list[str]) -> str:
    """Render as a multi-line shell command suitable for a .sh file."""
    lines = [shlex.quote(argv[0])]
    i = 1
    while i < len(argv):
        token = argv[i]
        if token in ("-X", "--max-time", "-o", "-w", "-H", "--data") and i + 1 < len(argv):
            lines.append(f"  {shlex.quote(token)} {shlex.quote(argv[i + 1])}")
            i += 2
        elif token in ("-sS",):
            lines.append(f"  {shlex.quote(token)}")
            i += 1
        else:
            lines.append(f"  {shlex.quote(token)}")
            i += 1
    return " \\\n".join(lines)


__all__ = ["build_curl"]
