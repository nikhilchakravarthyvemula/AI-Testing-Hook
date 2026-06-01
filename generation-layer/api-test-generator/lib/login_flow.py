"""Identify the login API in indexed_output/apis.json and capture a token.

Strategy (no LLM needed for v1 — patterns are strong enough):
  1. Find endpoints whose method=POST and path matches
     /(login|auth/login|sign-?in|token|oauth/token)/i.
  2. Prefer the one with the most observations (most-hit endpoint).
  3. Build a JSON body: {email | username, password} using the
     provided creds.
  4. POST it, parse the JSON response, extract the token using a
     priority list of common field names.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, Optional

import requests


_LOGIN_PATH_RE = re.compile(
    r"/(login|auth/login|sign-?in|signin|token|oauth/token|sessions?)$",
    re.IGNORECASE,
)

# Field names checked in priority order when looking for a token in the response.
_TOKEN_FIELDS = (
    "access_token", "accessToken", "token", "id_token", "idToken",
    "jwt", "auth_token", "authToken", "bearer",
)


@dataclass
class LoginResult:
    """Outcome of the login attempt."""
    ok: bool
    token: Optional[str]
    token_type: Optional[str]
    response_status: Optional[int]
    response_body_preview: Optional[str]
    login_url: Optional[str]
    error: Optional[str]


def find_login_endpoint(apis_items: list[dict]) -> Optional[dict]:
    """Return the best login-shaped POST endpoint, or None.

    Ranking (best first):
      1. Endpoint with a crawler-observed `origin` — proves it's reachable
         and that the frontend actually posts here. (Pure-code paths might
         be ghost duplicates or frontend page routes that 404.)
      2. Endpoint under a versioned API prefix (`/api/`, `/app/v\\d+/`,
         `/v\\d+/`) — these are conventionally the real backend routes,
         not frontend Next.js / Remix / etc. page routes that mirror them.
      3. More observations wins (legacy tiebreaker).
      4. Shorter path wins (legacy tiebreaker).
    """
    import re as _re
    candidates = []
    for item in apis_items:
        prim = item.get("primary") or {}
        if (prim.get("method") or "").upper() != "POST":
            continue
        path = prim.get("path") or ""
        if not _LOGIN_PATH_RE.search(path):
            continue
        candidates.append(item)
    if not candidates:
        return None

    versioned_re = _re.compile(r"(?:^|/)(?:api|v\d+|app/v\d+)(?:/|$)", _re.IGNORECASE)

    def rank(item):
        prim = item.get("primary") or {}
        path = prim.get("path") or ""
        has_origin    = 0 if prim.get("origin") else 1            # 0 = better
        is_versioned  = 0 if versioned_re.search(path) else 1     # 0 = better
        obs_count_neg = -len(item.get("observations") or [])
        return (has_origin, is_versioned, obs_count_neg, len(path))

    candidates.sort(key=rank)
    return candidates[0]


def attempt_login(
    *,
    base_url: str,
    api_item: dict,
    email: str,
    password: str,
    extra_headers: dict[str, str] | None = None,
    timeout_s: float = 10.0,
    mock_data: dict[str, dict] | None = None,
) -> LoginResult:
    """POST credentials to the discovered login endpoint.

    `mock_data` — optional dict keyed by `<METHOD>:<path>` (the mock-data
    bundle index). When the login endpoint has an observed request body
    there, we use that shape directly, substituting only the credentials.
    """
    primary = api_item.get("primary") or {}
    path = primary.get("path") or ""
    method = (primary.get("method") or "POST").upper()
    url = base_url.rstrip("/") + "/" + path.lstrip("/")

    body = _build_login_body(api_item, email, password, mock_data=mock_data, key=f"{method}:{path}")
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if extra_headers:
        headers.update(extra_headers)

    try:
        resp = requests.post(url, json=body, headers=headers, timeout=timeout_s)
    except requests.RequestException as exc:
        return LoginResult(
            ok=False, token=None, token_type=None,
            response_status=None, response_body_preview=None,
            login_url=url, error=f"request failed: {exc}",
        )

    body_preview = _safe_text(resp)
    if not resp.ok:
        return LoginResult(
            ok=False, token=None, token_type=None,
            response_status=resp.status_code,
            response_body_preview=body_preview, login_url=url,
            error=f"HTTP {resp.status_code}",
        )

    token, token_type = _extract_token(resp)
    if not token:
        return LoginResult(
            ok=False, token=None, token_type=None,
            response_status=resp.status_code,
            response_body_preview=body_preview, login_url=url,
            error="response had no recognisable token field",
        )

    return LoginResult(
        ok=True, token=token, token_type=token_type or "Bearer",
        response_status=resp.status_code,
        response_body_preview=body_preview, login_url=url, error=None,
    )


def _build_login_body(
    api_item: dict,
    email: str,
    password: str,
    *,
    mock_data: dict[str, dict] | None = None,
    key: str | None = None,
) -> dict:
    """Pick the right field names by sniffing prior crawler-observed bodies.

    Priority for the body shape:
      1. mock-data bundle (cleanest source, populated by the mock-data
         extractor — request bodies the frontend actually sent)
      2. legacy `exampleRequestBodies` on observations
      3. default `{email, password}` fallback
    """
    sample_bodies: list[Any] = []

    # 1. mock-data — strongest.
    if mock_data and key and key in mock_data:
        for s in (mock_data[key].get("samples") or []):
            body = (s.get("request") or {}).get("body")
            if isinstance(body, dict) and body:
                sample_bodies.append(body)

    # 2. legacy fallback.
    if not sample_bodies:
        for obs in (api_item.get("observations") or []):
            fields = obs.get("fields") or {}
            sample_bodies.extend(fields.get("exampleRequestBodies") or [])

    # 3. Default body shape if no samples exist.
    body: dict[str, Any] = {"email": email, "password": password}

    if sample_bodies:
        sample = sample_bodies[0]
        if isinstance(sample, dict):
            # Mimic the observed shape exactly — pick the first matching field name.
            new_body = {}
            for k in sample.keys():
                kl = k.lower()
                if kl in ("email", "user_email"):       new_body[k] = email
                elif kl in ("username", "user", "login", "user_name"): new_body[k] = email
                elif kl in ("password", "pass", "passwd", "secret"):   new_body[k] = password
                else: new_body[k] = sample[k]   # preserve constants (e.g. grant_type)
            if any(new_body.get(k) == email or new_body.get(k) == password
                   for k in new_body):
                body = new_body
    return body


def _extract_token(resp: requests.Response) -> tuple[Optional[str], Optional[str]]:
    """Look at the JSON body first, then common response headers."""
    try:
        data = resp.json()
    except (ValueError, json.JSONDecodeError):
        data = None

    if isinstance(data, dict):
        for field in _TOKEN_FIELDS:
            v = data.get(field)
            if isinstance(v, str) and v:
                token_type = data.get("token_type") or data.get("tokenType")
                return v, _normalise_token_type(token_type)
        # nested under "data" / "result"
        for envelope in ("data", "result", "auth"):
            nested = data.get(envelope)
            if isinstance(nested, dict):
                for field in _TOKEN_FIELDS:
                    v = nested.get(field)
                    if isinstance(v, str) and v:
                        return v, _normalise_token_type(nested.get("token_type"))

    # Header fallback (Set-Cookie or Authorization).
    cookie = resp.headers.get("set-cookie") or ""
    m = re.search(r"(?:auth(?:_token)?|access_token|session|jwt)=([^;]+)", cookie, re.I)
    if m:
        return m.group(1), "Cookie"

    return None, None


def _normalise_token_type(tt) -> str:
    if not isinstance(tt, str) or not tt: return "Bearer"
    # "bearer" → "Bearer"; "Token" → "Token"; etc.
    return tt.strip().capitalize() if tt.lower() in ("bearer",) else tt.strip()


def _safe_text(resp: requests.Response, max_chars: int = 500) -> str:
    try:
        return resp.text[:max_chars]
    except Exception:  # noqa: BLE001
        return f"<unreadable body, {len(resp.content)} bytes>"


__all__ = ["find_login_endpoint", "attempt_login", "LoginResult"]
