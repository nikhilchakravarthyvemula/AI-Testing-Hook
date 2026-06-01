"""Execute generated curl commands and collect structured results."""

from __future__ import annotations

import json
import re
import subprocess
import time
from dataclasses import dataclass, field
from typing import Any, Optional


_HTTP_STATUS_RE = re.compile(r"__HTTP_STATUS__=(\d{3})")
_TIMING_RE      = re.compile(r"__TIMING__=([\d.]+)")
_CONTENT_TYPE_RE = re.compile(r"__CONTENT_TYPE__=([^\n]+)")

# Cap body capture at 1 MB. Larger responses (typically log dumps) get
# truncated with a flag so results.json + per-test artifacts stay readable.
_MAX_BODY_BYTES = 1_000_000


@dataclass
class TestResult:
    """One curl execution.

    Carries everything needed to inspect or replay this single test:
      * The full request that went out (headers / body, with the bearer
        token redacted by the caller before it lands here).
      * The full response that came back (status / headers / body),
        capped at a sane size so a single huge response can't bloat
        results.json. Truncated payloads set `response_body_truncated`.

    `response_body_preview` is a short string for the human-facing report;
    `response_body` is the actual payload (parsed as JSON when applicable).
    """
    api_id: str
    method: str
    url: str
    ok: bool
    http_status: Optional[int]
    timing_s: Optional[float]
    response_body_preview: Optional[str]
    error: Optional[str]
    request_body: Optional[Any] = None
    request_headers: dict[str, str] = field(default_factory=dict)
    response_body: Optional[Any] = None
    response_body_truncated: bool = False
    response_headers: dict[str, str] = field(default_factory=dict)
    response_content_type: Optional[str] = None


def execute_curl(
    *,
    argv: list[str],
    api_id: str,
    method: str,
    url: str,
    request_body: Any = None,
    request_headers: dict[str, str] | None = None,
    timeout_s: int = 35,
) -> TestResult:
    """Run a single curl + parse status/timing/body."""
    t0 = time.monotonic()
    try:
        completed = subprocess.run(   # noqa: S603 — argv is fully constructed
            argv, capture_output=True, text=True, timeout=timeout_s,
        )
    except subprocess.TimeoutExpired:
        return TestResult(
            api_id=api_id, method=method, url=url, ok=False,
            http_status=None, timing_s=time.monotonic() - t0,
            response_body_preview=None,
            error=f"timeout after {timeout_s}s",
            request_body=request_body, request_headers=request_headers or {},
        )
    except FileNotFoundError as exc:
        return TestResult(
            api_id=api_id, method=method, url=url, ok=False,
            http_status=None, timing_s=None,
            response_body_preview=None,
            error=f"curl not found: {exc}",
            request_body=request_body, request_headers=request_headers or {},
        )

    raw_stdout = completed.stdout or ""
    raw_stderr = completed.stderr or ""

    # curl -D /dev/stderr dumps the response status line + headers to stderr,
    # so we read them from there (cleanly separated from body in stdout).
    response_headers = _parse_response_headers(raw_stderr)
    status = _extract_first(_HTTP_STATUS_RE, raw_stdout)
    timing = _extract_first(_TIMING_RE, raw_stdout)
    content_type = _extract_first(_CONTENT_TYPE_RE, raw_stdout) or response_headers.get("content-type")
    body_text = _strip_metadata(raw_stdout)
    body_preview = body_text[:600]
    body_truncated = len(body_text) > _MAX_BODY_BYTES
    if body_truncated:
        body_text = body_text[:_MAX_BODY_BYTES]
    # Parse body as JSON when the response says so (or when it looks like
    # JSON anyway). Falls back to the raw string.
    response_body: Any = _maybe_parse_json(body_text, content_type)

    if status is None:
        # Curl itself failed (exit≠0, no HTTP response).
        return TestResult(
            api_id=api_id, method=method, url=url, ok=False,
            http_status=None, timing_s=time.monotonic() - t0,
            response_body_preview=body_preview or raw_stderr[:600],
            error=raw_stderr.strip()[:240] or f"curl exit {completed.returncode}",
            request_body=request_body, request_headers=request_headers or {},
            response_body=response_body or raw_stderr[:_MAX_BODY_BYTES] or None,
            response_headers=response_headers,
            response_content_type=content_type,
        )

    http_status = int(status)
    timing_s = float(timing) if timing else None
    ok = 200 <= http_status < 400

    return TestResult(
        api_id=api_id, method=method, url=url, ok=ok,
        http_status=http_status, timing_s=timing_s,
        response_body_preview=body_preview,
        error=None if ok else f"HTTP {http_status}",
        request_body=request_body, request_headers=request_headers or {},
        response_body=response_body,
        response_body_truncated=body_truncated,
        response_headers=response_headers,
        response_content_type=content_type,
    )


def _extract_first(pattern: re.Pattern, text: str):
    m = pattern.search(text or "")
    return m.group(1).strip() if m else None


def _strip_metadata(text: str) -> str:
    """Remove our injected -w trailers from the body output."""
    if not text:
        return ""
    out = _TIMING_RE.sub("", text)
    out = _HTTP_STATUS_RE.sub("", out)
    out = _CONTENT_TYPE_RE.sub("", out)
    return out.strip()


def _parse_response_headers(stderr_text: str) -> dict[str, str]:
    """Pull `name: value` pairs from the raw HTTP header block in stderr.

    curl `-D /dev/stderr` writes the response status line + each header
    on its own line, terminated by a blank line. We accept the whole block
    (including the trailing blank) and split by line.
    """
    if not stderr_text:
        return {}
    out: dict[str, str] = {}
    for raw_line in stderr_text.splitlines():
        line = raw_line.strip()
        if not line or ":" not in line:
            continue
        # Skip the HTTP/1.1 200 OK status line + any "curl: …" diagnostics.
        if line.startswith("HTTP/") or line.startswith("curl:"):
            continue
        name, _, value = line.partition(":")
        out[name.strip().lower()] = value.strip()
    return out


def _maybe_parse_json(text: str, content_type: Optional[str]):
    """JSON-decode when content-type suggests it OR body looks like JSON."""
    if not text:
        return None
    looks_json = (content_type or "").lower().find("json") != -1
    s = text.strip()
    if not looks_json and not s:
        return text
    if not looks_json and not (s.startswith("{") or s.startswith("[")):
        return text
    try:
        return json.loads(s)
    except (ValueError, json.JSONDecodeError):
        return text


__all__ = ["execute_curl", "TestResult"]
