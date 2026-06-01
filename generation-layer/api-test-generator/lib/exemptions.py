"""exemptions — endpoints that must NOT be executed during a test run.

Some endpoints mutate the *authenticated session itself*. Executing them
mid-run breaks every subsequent authenticated test, because the credentials
we logged in with stop working:

  * password reset / forgot / change  → rotates the password we logged in with
  * logout / token revoke              → invalidates the bearer token
  * delete / deactivate the acting user → the account we're acting as vanishes

The last one is subtle and is what actually broke logtrim: path params like
`{user_id}` are resolved from crawler-observed values, and the crawler browsed
*as the admin*, so the observed id is the admin's own id. A generated
`DELETE /users/1` or `PUT /users/1` therefore soft-deletes / renames the very
account the test suite authenticates with.

This module decides — generically, framework-agnostically — which discovered
endpoints to skip. It matches on path shape + HTTP method, not on any single
app's routing, so it works across the hundreds of apps the harness targets.

Defaults can be extended per-target without code changes via:
  * an exemption file: `api-test-exemptions.json` at the repo root, or the
    path in $API_TEST_EXEMPTIONS
  * the skill's `exempt_patterns` argument

Exemption file shape (either key works), entries are strings or objects::

    {
      "exempt": [
        "/password",                              // regex on path, any method
        {"method": "DELETE", "path": "/users/"},  // method + path regex
        {"method": "PUT",    "path": "/me$"}
      ]
    }
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Optional


# Default rules. Each rule = {"path": <regex>, "method": <METHOD or None>}.
# `path` is a case-insensitive regex searched against the endpoint path;
# `method` (optional) must match exactly when present. An endpoint is exempt
# when ANY rule matches.
DEFAULT_EXEMPT: list[dict] = [
    # ── Password lifecycle: resetting/changing rotates our login creds ──
    {"path": r"/password(?:[/_\-]|$)",                         "method": None},
    {"path": r"(?:forgot|reset|change|update)[-_]?password",   "method": None},
    {"path": r"password[-_]?(?:forgot|reset|change|update)",   "method": None},
    # ── Session teardown: revokes the bearer token we authenticated with ──
    {"path": r"/logout(?:[/_\-]|$)",                           "method": None},
    {"path": r"/sign[-_]?out(?:[/_\-]|$)",                     "method": None},
    {"path": r"/(?:token|session)[-_/]?revoke",                "method": None},
    # ── Account teardown: deletes/deactivates the acting user ──
    {"path": r"/deactivate(?:[/_\-]|$)",                       "method": None},
    {"path": r"/(?:me|account|profile)(?:[/_\-]|$)",           "method": "DELETE"},
]


def load_exemptions(
    repo_root: Path,
    *,
    extra_patterns: Optional[list] = None,
    exempt_file: Optional[Path] = None,
) -> list[dict]:
    """Build the active rule list: DEFAULT_EXEMPT + file rules + arg rules."""
    rules: list[dict] = [dict(r) for r in DEFAULT_EXEMPT]

    path = exempt_file or os.environ.get("API_TEST_EXEMPTIONS")
    if not path:
        candidate = repo_root / "api-test-exemptions.json"
        if candidate.is_file():
            path = candidate
    if path and Path(path).is_file():
        try:
            data = json.loads(Path(path).read_text(encoding="utf-8"))
            for entry in (data.get("exempt") or data.get("exemptions") or []):
                rule = _coerce_rule(entry)
                if rule:
                    rules.append(rule)
        except (json.JSONDecodeError, OSError):
            pass  # bad config shouldn't crash a test run; defaults still apply

    for entry in (extra_patterns or []):
        rule = _coerce_rule(entry)
        if rule:
            rules.append(rule)

    return rules


def is_exempt(method: Optional[str], path: Optional[str], rules: list[dict]) -> Optional[str]:
    """Return the matched rule's path (truthy) if the endpoint is exempt, else None."""
    m = (method or "").upper()
    p = path or ""
    for r in rules:
        rule_method = r.get("method")
        if rule_method and rule_method.upper() != m:
            continue
        pattern = r.get("path") or ""
        try:
            if re.search(pattern, p, re.IGNORECASE):
                return _label(r)
        except re.error:
            # Treat an invalid regex as a literal substring match.
            if pattern.lower() in p.lower():
                return _label(r)
    return None


# ── internals ────────────────────────────────────────────────────────────────


def _coerce_rule(entry) -> Optional[dict]:
    if isinstance(entry, str) and entry.strip():
        return {"path": entry.strip(), "method": None}
    if isinstance(entry, dict) and entry.get("path"):
        return {"path": str(entry["path"]), "method": (entry.get("method") or None)}
    return None


def _label(rule: dict) -> str:
    m = rule.get("method")
    return f"{m} {rule['path']}" if m else rule["path"]


__all__ = ["DEFAULT_EXEMPT", "load_exemptions", "is_exempt"]
