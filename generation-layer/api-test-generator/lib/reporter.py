"""Write per-test .sh files + a summary results.json + a human report."""

from __future__ import annotations

import json
import re
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .test_runner import TestResult


def write_curl_script(out_dir: Path, api_id: str, pretty_curl: str) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    safe = _safe_filename(api_id)
    p = out_dir / f"{safe}.sh"
    p.write_text(f"#!/usr/bin/env bash\nset -e\n{pretty_curl}\n")
    p.chmod(0o755)
    return p


def write_summary(
    out_path: Path,
    *,
    login_summary: dict,
    test_results: list[TestResult],
    skipped: list[dict] | None = None,
) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    stats = _compute_stats(test_results)
    stats["skipped"] = len(skipped or [])
    summary = {
        "generatedAt": datetime.now(tz=timezone.utc).isoformat(),
        "login": login_summary,
        "stats": stats,
        # Endpoints intentionally not executed (would break the auth session).
        "skipped": list(skipped or []),
        # Each entry includes a `runs_file` pointer to the per-test artifact
        # under runs/, where the full request + response live.
        "tests": [_test_to_summary_json(t) for t in test_results],
    }
    out_path.write_text(json.dumps(summary, indent=2, default=str))


def write_run_artifact(runs_dir: Path, t: TestResult, *, ran_at_iso: str | None = None) -> Path:
    """Write the full request + response for one test to runs/<id>.json.

    Captures everything you'd need to debug, reproduce, or diff this single
    test outside the harness — headers, full body (parsed as JSON when
    applicable), timing, the literal curl-replay command. The bearer
    token is already redacted in request_headers by the caller.
    """
    runs_dir.mkdir(parents=True, exist_ok=True)
    safe = _safe_filename(t.api_id)
    p = runs_dir / f"{safe}.json"
    artifact = {
        "test_id": t.api_id,
        "method": t.method,
        "url": t.url,
        "ok": t.ok,
        "ran_at": ran_at_iso or datetime.now(tz=timezone.utc).isoformat(),
        "request": {
            "method": t.method,
            "url": t.url,
            "headers": _coerce_jsonable(t.request_headers or {}),
            "body": _coerce_jsonable(t.request_body),
        },
        "response": {
            "status": t.http_status,
            "content_type": t.response_content_type,
            "headers": _coerce_jsonable(t.response_headers or {}),
            "body": _coerce_jsonable(t.response_body),
            "body_truncated": t.response_body_truncated,
            "timing_ms": int((t.timing_s or 0) * 1000) if t.timing_s else None,
        },
        "error": t.error,
        "replay": {
            "script": f"curls/{safe}.sh",
            "hint": "AUTH_TOKEN=<token> bash curls/" + safe + ".sh",
        },
    }
    p.write_text(json.dumps(artifact, indent=2, default=str))
    return p


def write_report(
    report_path: Path,
    *,
    login_summary: dict,
    test_results: list[TestResult],
    skipped: list[dict] | None = None,
) -> None:
    report_path.parent.mkdir(parents=True, exist_ok=True)
    skipped = skipped or []
    stats = _compute_stats(test_results)
    lines = []
    lines.append("# API Test Run Report")
    lines.append("")
    lines.append(f"_generated {datetime.now(tz=timezone.utc).isoformat()}_")
    lines.append("")
    lines.append("## Login")
    lines.append(f"- url: `{login_summary.get('login_url') or 'n/a'}`")
    lines.append(f"- ok: **{login_summary.get('ok')}**  status: `{login_summary.get('response_status')}`")
    if login_summary.get("error"):
        lines.append(f"- error: `{login_summary['error']}`")
    lines.append("")
    lines.append("## Results")
    lines.append(f"- total:    **{stats['total']}**")
    lines.append(f"- passed:   **{stats['passed']}**  ({stats['passed_pct']:.0f}%)")
    lines.append(f"- failed:   **{stats['failed']}**")
    lines.append(f"- skipped:  **{len(skipped)}**  (not executed — see below)")
    lines.append(f"- by status: {stats['by_status']}")
    lines.append("")
    if skipped:
        lines.append("## Skipped (generated but not executed)")
        lines.append("")
        lines.append("Each was generated (curl written) but not run — either the "
                     "run is in safe-mode (mutating method) or the endpoint is in "
                     "the always-protected catastrophic set (logout, password "
                     "reset, delete-self).")
        for s in skipped:
            lines.append(f"- `{s.get('method')} {s.get('path')}`  ← reason: `{s.get('reason')}`")
        lines.append("")
    lines.append("## Failures")
    for t in test_results:
        if t.ok: continue
        lines.append(f"- `{t.method} {t.url}` → {t.http_status or '?'}  ({t.error or ''})")
        if t.response_body_preview:
            preview = t.response_body_preview.strip()[:200]
            lines.append(f"  ```\n  {preview}\n  ```")
    lines.append("")
    lines.append("## All tests")
    for t in test_results:
        mark = "✓" if t.ok else "✗"
        ms = f"{int((t.timing_s or 0) * 1000)}ms" if t.timing_s else "—"
        lines.append(f"- {mark} `{t.method} {t.url}` → `{t.http_status or '?'}`  {ms}")
    report_path.write_text("\n".join(lines) + "\n")


def _compute_stats(results: list[TestResult]) -> dict:
    total = len(results)
    passed = sum(1 for t in results if t.ok)
    by_status: dict[str, int] = {}
    for t in results:
        key = str(t.http_status or "no-response")
        by_status[key] = by_status.get(key, 0) + 1
    return {
        "total": total,
        "passed": passed,
        "failed": total - passed,
        "passed_pct": (100.0 * passed / total) if total else 0.0,
        "by_status": dict(sorted(by_status.items())),
    }


def _test_to_summary_json(t: TestResult) -> dict:
    """Compact per-test entry for results.json — points at the full
    artifact under runs/ rather than embedding the (possibly huge) body."""
    safe = _safe_filename(t.api_id)
    return {
        "api_id": t.api_id,
        "method": t.method,
        "url": t.url,
        "ok": t.ok,
        "http_status": t.http_status,
        "timing_ms": int((t.timing_s or 0) * 1000) if t.timing_s else None,
        "error": t.error,
        "response_body_preview": t.response_body_preview,
        "runs_file": f"runs/{safe}.json",
        "curl_script": f"curls/{safe}.sh",
    }


def _coerce_jsonable(v: Any) -> Any:
    """Make sure we can json.dump(v) — exotic types become str."""
    if v is None or isinstance(v, (str, int, float, bool)):
        return v
    if isinstance(v, list):
        return [_coerce_jsonable(x) for x in v]
    if isinstance(v, dict):
        return {str(k): _coerce_jsonable(x) for k, x in v.items()}
    try:
        json.dumps(v)
        return v
    except (TypeError, ValueError):
        return str(v)


_SAFE_FILENAME_RE = re.compile(r"[^A-Za-z0-9_.-]+")


def _safe_filename(s: str, *, max_len: int = 80) -> str:
    cleaned = _SAFE_FILENAME_RE.sub("_", s).strip("_")
    return cleaned[:max_len] or "test"


def write_replay_scripts(
    out_dir: Path,
    *,
    base_url: str,
    login_url: str | None,
    login_body_template: str | None,
    login_token_field: str,
    auth_scheme: str,
) -> None:
    """Drop _login.sh, run-all.sh, config.sh, README.md into out_dir so
    the caller can re-run the saved test suite tomorrow."""
    out_dir.mkdir(parents=True, exist_ok=True)

    # config.sh — anything the orchestrator + login helper need to know.
    (out_dir / "config.sh").write_text(_render_config(
        base_url=base_url,
        login_url=login_url or "",
        login_body_template=login_body_template or '{"email":"$LOGIN_EMAIL","password":"$LOGIN_PASSWORD"}',
        login_token_field=login_token_field,
        auth_scheme=auth_scheme,
    ))
    (out_dir / "config.sh").chmod(0o644)

    (out_dir / "_login.sh").write_text(_LOGIN_SH)
    (out_dir / "_login.sh").chmod(0o755)
    (out_dir / "run-all.sh").write_text(_RUN_ALL_SH)
    (out_dir / "run-all.sh").chmod(0o755)
    (out_dir / "README.md").write_text(_README_MD)


def _render_config(*, base_url, login_url, login_body_template, login_token_field, auth_scheme) -> str:
    return (
        "# Re-run config. Source-able from bash. Edit to point at a different env.\n"
        f"export BASE_URL='{base_url}'\n"
        f"export LOGIN_URL='{login_url}'\n"
        f"export LOGIN_BODY_TEMPLATE='{login_body_template}'\n"
        f"export LOGIN_TOKEN_FIELD='{login_token_field}'\n"
        f"export AUTH_SCHEME='{auth_scheme}'\n"
    )


_LOGIN_SH = r"""#!/usr/bin/env bash
# _login.sh — refresh the AUTH_TOKEN env var by hitting the login URL.
# Sourced by run-all.sh; also runnable standalone for one-off token refresh.
#
# Required env (set by user OR by sourcing config.sh):
#   LOGIN_EMAIL, LOGIN_PASSWORD           — credentials
# Optional (have defaults via config.sh):
#   LOGIN_URL                              — full URL (default empty → derived from BASE_URL)
#   LOGIN_BODY_TEMPLATE                    — JSON template with $LOGIN_EMAIL/$LOGIN_PASSWORD vars
#   LOGIN_TOKEN_FIELD                      — JSON field to read the token from (default: access_token)
#
# Outputs: exports AUTH_TOKEN (empty string when login fails, so sourcing
#          this script never aborts the suite — auth'd tests just get 401).

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$HERE/config.sh" ] && source "$HERE/config.sh"

: "${LOGIN_EMAIL:?LOGIN_EMAIL required (export it or put it in your .env)}"
: "${LOGIN_PASSWORD:?LOGIN_PASSWORD required}"
: "${LOGIN_URL:?LOGIN_URL not set — check config.sh}"
: "${LOGIN_TOKEN_FIELD:=access_token}"
: "${LOGIN_BODY_TEMPLATE:='{"email":"$LOGIN_EMAIL","password":"$LOGIN_PASSWORD"}'}"

# Substitute $LOGIN_EMAIL / $LOGIN_PASSWORD into the body template using envsubst-style expansion.
BODY=$(LOGIN_EMAIL="$LOGIN_EMAIL" LOGIN_PASSWORD="$LOGIN_PASSWORD" \
       python3 -c "import os,string,sys; print(string.Template(sys.stdin.read()).safe_substitute(os.environ))" \
       <<< "$LOGIN_BODY_TEMPLATE")

echo "[_login] POST $LOGIN_URL" >&2
# Capture both status and body — never abort, even on connection failure.
RESP=$(curl -sS -X POST "$LOGIN_URL" \
            -H "Content-Type: application/json" \
            -H "Accept: application/json" \
            -d "$BODY" 2>&1) || RESP="{}"

# Pull the token field from the JSON response (handles top-level + common envelopes).
TOKEN=$(python3 -c "
import json, sys
try:
    data = json.loads(sys.stdin.read())
except Exception:
    sys.exit(0)
field = '$LOGIN_TOKEN_FIELD'
for envelope in [None, 'data', 'result', 'auth']:
    obj = data if envelope is None else data.get(envelope, {}) if isinstance(data, dict) else {}
    if isinstance(obj, dict) and obj.get(field):
        print(obj[field]); sys.exit(0)
" <<< "$RESP" 2>/dev/null || true)

if [ -z "$TOKEN" ]; then
  echo "[_login] WARN — no token extracted; auth'd tests will get 401." >&2
  echo "[_login]   response: $(echo "$RESP" | head -c 200)" >&2
  export AUTH_TOKEN=""
else
  export AUTH_TOKEN="$TOKEN"
  echo "[_login] OK — AUTH_TOKEN set (${AUTH_TOKEN:0:12}…)" >&2
fi
"""


_RUN_ALL_SH = r"""#!/usr/bin/env bash
# run-all.sh — re-run the entire saved test suite.
#
#   ./run-all.sh                              # uses LOGIN_EMAIL/LOGIN_PASSWORD from env
#   LOGIN_EMAIL=a@b.com LOGIN_PASSWORD=x ./run-all.sh
#   ./run-all.sh path/to/.env                 # source vars from a .env file first
#
# Exits non-zero if any test failed.

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Optional .env arg — source it before login.
if [ "${1:-}" ] && [ -f "${1}" ]; then
  echo "[run-all] sourcing env from $1"
  set -a; source "$1"; set +a
fi

source "$HERE/_login.sh"   # exports AUTH_TOKEN

pass=0; fail=0; skipped=0
failed_tests=()
total=$(find "$HERE/curls" -maxdepth 1 -name '*.sh' -type f 2>/dev/null | wc -l | tr -d ' ')
echo ""
echo "[run-all] running $total test(s) from $HERE/curls/"
echo "[run-all] base: ${BASE_URL:-(unset)}"
echo ""

for script in "$HERE/curls"/*.sh; do
  [ -e "$script" ] || { skipped=$((skipped+1)); continue; }
  name=$(basename "$script" .sh)
  if out=$("$script" 2>&1); then
    # The script prints `__HTTP_STATUS__=<code>` somewhere in its output;
    # use that to decide pass/fail (2xx + 3xx = pass).
    status=$(echo "$out" | grep -oE '__HTTP_STATUS__=[0-9]+' | head -1 | cut -d= -f2)
    if [ -n "$status" ] && [ "$status" -lt 400 ]; then
      pass=$((pass+1))
      printf "  ✓ %-60s → %s\n" "$name" "$status"
    else
      fail=$((fail+1)); failed_tests+=("$name → ${status:-?}")
      printf "  ✗ %-60s → %s\n" "$name" "${status:-?}"
    fi
  else
    fail=$((fail+1)); failed_tests+=("$name → exec-error")
    printf "  ✗ %-60s → exec-error\n" "$name"
  fi
done

echo ""
echo "[run-all] passed=$pass  failed=$fail  skipped=$skipped"
if [ "$fail" -gt 0 ]; then
  echo "[run-all] failed tests:"
  printf '  - %s\n' "${failed_tests[@]}"
  exit 1
fi
"""


_README_MD = r"""# Saved API Test Suite

Generated by `testo generate api-tests`. Re-runnable without re-running
the whole context layer (no need to re-crawl).

## Layout

```
api-tests/
├── curls/                  one .sh per API endpoint (executable)
├── _login.sh               refresh AUTH_TOKEN by POSTing to the login URL
├── run-all.sh              orchestrator: source _login.sh, run every curls/*.sh, summarise
├── config.sh               BASE_URL, LOGIN_URL, token field name — edit to point at another env
├── results.json            last run's structured results
├── report.md               last run's human-readable summary
└── README.md               this file
```

## Re-run later (the common case)

```bash
# From the project root:
LOGIN_EMAIL=admin@example.com LOGIN_PASSWORD=secret \
  ./output/generation/api-tests/run-all.sh
```

Or source a .env first:

```bash
./output/generation/api-tests/run-all.sh path/to/your.env
```

`run-all.sh` will:
1. Source `config.sh` (BASE_URL, LOGIN_URL, etc.)
2. Source `_login.sh` (POSTs creds → exports fresh AUTH_TOKEN)
3. Iterate every `curls/*.sh` — they reference `$AUTH_TOKEN`
4. Print pass/fail per test + a summary
5. Exit non-zero if any test fails

## Run one test

```bash
LOGIN_EMAIL=... LOGIN_PASSWORD=... source ./_login.sh
./curls/GET_api_logs.sh
```

`_login.sh` exports `AUTH_TOKEN`; the individual curl uses it.

## Target a different environment

Edit `config.sh` (change `BASE_URL` and `LOGIN_URL`) — every curl script
uses the absolute URL baked into it from generation time, BUT they all
use `$AUTH_TOKEN` for auth, so changing the env's credentials works fine.
For a full env switch (different host), re-generate:

```bash
testo generate api-tests --url https://staging.example.com \
                         --user qa@example.com --pass ...
```

## Add an assertion

The curl scripts only capture `__HTTP_STATUS__` + body. To assert specific
fields, edit a saved script and pipe its body through `jq` etc.

## Regenerate from scratch

When the indexed APIs change (new endpoints, new param shapes), re-run:

```bash
testo scan --url ... --codebase ...        # refreshes output/indexed_output/apis.json
testo generate api-tests --url ... --user ... --pass ...   # rebuilds this folder
```
"""


__all__ = ["write_curl_script", "write_summary", "write_report", "write_replay_scripts"]
