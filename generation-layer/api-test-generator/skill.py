"""api-test-generator — the first skill in the generation layer.

Takes APIs discovered by the context layer and turns them into runnable
curl-based tests:

  1. Read `output/indexed_output/apis.json`.
  2. Read `output/indexed_output/db-schema.json` (for body synthesis).
  3. Find the LOGIN endpoint, build a curl, run it, capture the token.
  4. For every other API, build a curl with the captured Authorization
     header + a request body synthesized from observations / DB schema.
  5. Execute each curl, collect (status, timing, body preview, error).
  6. Write per-test .sh files, results.json, and a markdown report.

Skill contract:
  * `name = "api-test-generator"`
  * `execute(ApiTestGeneratorArgs) -> ApiTestGeneratorResult`
  * `ApiTestGeneratorResult` has `ok: bool` so SkillService treats
    failures as failures.

LLM usage today: NONE inside the skill itself (every step is
deterministic). The hooks are there in `lib/request_synth.py` to add
LLM-driven body synthesis when we want it; for now crawler samples +
DB schema cover the common cases at zero cost.
"""

import asyncio
import json
import sys
from pathlib import Path
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field

# Make sibling `lib/` importable.
_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE))

from lib.curl_builder import build_curl                            # noqa: E402
from lib.exemptions import is_exempt, load_exemptions              # noqa: E402
from lib.login_flow import LoginResult, attempt_login, find_login_endpoint  # noqa: E402
from lib.request_synth import load_mock_data_index, load_openapi_index  # noqa: E402
from lib.reporter import (                                          # noqa: E402
    write_curl_script,
    write_replay_scripts,
    write_report,
    write_run_artifact,
    write_summary,
)
from lib.request_synth import synthesize_body                       # noqa: E402
from lib.test_runner import TestResult, execute_curl                # noqa: E402


# ── args + result ──────────────────────────────────────────────────────────


class ApiTestGeneratorArgs(BaseModel):
    """Inputs for the api-test-generator skill."""

    model_config = ConfigDict(extra="forbid")

    apis_json:      Path = Path("output/indexed_output/apis.json")
    db_schema_json: Path = Path("output/indexed_output/db-schema.json")
    base_url:       Optional[str] = Field(
        default=None,
        description="API base URL. Auto-detected from crawler bundle if omitted.",
    )
    login_email:    Optional[str] = Field(default=None, description="Login email/username.")
    login_password: Optional[str] = Field(default=None, description="Login password.")
    output_dir:     Path = Path("output/generation/api-tests")
    execute:        bool = Field(default=True, description="If false, only write the curl scripts.")
    test_mode:      str = Field(
        default="safe",
        description=(
            "'safe' (default): execute only read-only methods (GET/HEAD/OPTIONS); "
            "mutating requests (POST/PUT/PATCH/DELETE) are still generated but NOT "
            "executed — listed in the report as skipped. 'full': execute everything "
            "EXCEPT the always-protected catastrophic/session-breaking set (logout, "
            "token revoke, password reset, delete-self/account) which stay exempt."
        ),
    )
    max_tests:      Optional[int] = Field(default=None, ge=1, description="Cap on # APIs to test (None = no cap).")
    timeout_s:      int = Field(default=30, ge=1)
    auth_scheme:    str = Field(default="Bearer", description="`Bearer`, `Token`, `Cookie`, …")
    repo_root:      Optional[Path] = Field(default=None, description="Resolves relative paths; auto-detected if omitted.")
    exempt_patterns: list = Field(
        default_factory=list,
        description=(
            "Extra endpoints to skip (never executed). Each entry is a path "
            "regex string, or {\"method\":..,\"path\":..}. Merged on top of the "
            "built-in session-safety defaults (password reset, logout, delete-self)."
        ),
    )
    exempt_file:    Optional[Path] = Field(
        default=None,
        description="Path to an exemption JSON file. Defaults to <repo>/api-test-exemptions.json or $API_TEST_EXEMPTIONS.",
    )


class ApiTestGeneratorResult(BaseModel):
    """Skill result. `ok` is the field SkillService inspects."""

    ok: bool
    curls_generated: int
    curls_executed: int
    passed: int
    failed: int
    skipped: int = 0
    login_succeeded: bool
    login_url: Optional[str] = None
    output_dir: str
    summary_path: str
    report_path: str
    error: Optional[str] = None


# ── skill ──────────────────────────────────────────────────────────────────


class ApiTestGeneratorSkill:
    """Implements `skill_register.ISkill`."""

    name: str = "api-test-generator"

    async def execute(self, args: ApiTestGeneratorArgs) -> ApiTestGeneratorResult:
        # Run the synchronous work in a thread so we don't block the event loop.
        # All real I/O here is subprocess (curl) + file I/O — synchronous is fine.
        return await asyncio.to_thread(self._run_sync, args)

    # ── sync engine ────────────────────────────────────────────────────────

    def _run_sync(self, args: ApiTestGeneratorArgs) -> ApiTestGeneratorResult:
        test_mode = (args.test_mode or "safe").lower()
        if test_mode not in ("safe", "full"):
            test_mode = "safe"
        repo_root = args.repo_root or _detect_repo_root()
        apis_path  = _resolve(repo_root, args.apis_json)
        db_path    = _resolve(repo_root, args.db_schema_json)
        mock_path    = repo_root / "output" / "mock-data" / "bundle.json"
        openapi_path = repo_root / "output" / "openapi-probe" / "bundle.json"
        out_dir    = _resolve(repo_root, args.output_dir)
        curls_dir  = out_dir / "curls"
        runs_dir   = out_dir / "runs"   # per-test request+response artifacts
        results_path = out_dir / "results.json"
        report_path  = out_dir / "report.md"

        if not apis_path.is_file():
            return ApiTestGeneratorResult(
                ok=False, curls_generated=0, curls_executed=0,
                passed=0, failed=0, login_succeeded=False,
                output_dir=str(out_dir), summary_path=str(results_path),
                report_path=str(report_path),
                error=f"indexed apis not found at {apis_path} — run `testo scan` first",
            )

        apis_bundle = json.loads(apis_path.read_text(encoding="utf-8"))
        api_items   = apis_bundle.get("items") or []

        # Endpoints that would break the authenticated session if executed
        # (password reset/forgot/change, logout/revoke, delete-self). Loaded
        # generically from built-in defaults + an optional per-target file.
        exempt_rules = load_exemptions(
            repo_root,
            extra_patterns=list(args.exempt_patterns or []),
            exempt_file=(_resolve(repo_root, args.exempt_file) if args.exempt_file else None),
        )

        db_tables = _index_db_tables(db_path)
        # Real observed bodies from the crawler — keyed by `METHOD:path`.
        # Strongest signal for body synthesis (and for refreshing the
        # login body in _login.sh).
        mock_data = load_mock_data_index(mock_path)
        # Spec-driven request schemas (any framework that publishes OpenAPI).
        # Second-strongest signal: gives us a body for endpoints the
        # crawler never observed posting to.
        openapi = load_openapi_index(openapi_path)
        # `fallback_base_url` is used ONLY for APIs the crawler never observed
        # live. For observed APIs we use their actual `primary.origin` — most
        # apps split frontend (e.g. localhost:3000) and backend (e.g.
        # localhost:8000) onto different ports, so a single --url can't be
        # right for both. The user's --url is treated as a hint for the
        # "didn't observe" tail.
        fallback_base_url = args.base_url or _detect_base_url(api_items, repo_root)

        observed_count = sum(1 for it in api_items if _origin_for(it))
        observed_origins = sorted({_origin_for(it) for it in api_items if _origin_for(it)})
        print(
            f"[api-test-generator] fallback base_url={fallback_base_url}  "
            f"apis={len(api_items)} ({observed_count} with observed origin)  "
            f"db_tables={len(db_tables)}  "
            f"mock_data={len(mock_data)}  openapi={len(openapi)}",
            flush=True,
        )
        if observed_origins:
            print(f"[api-test-generator] observed API origins: {', '.join(observed_origins)}", flush=True)
        # If the user's --url doesn't match any observed origin, code-only
        # APIs (no crawler observation) will probably 404 against it.
        # Surface this so the user can re-run with the right base URL.
        if args.base_url and observed_origins and args.base_url.rstrip("/") not in observed_origins:
            unobserved = len(api_items) - observed_count
            print(
                f"[api-test-generator] WARNING: --url {args.base_url} does not match any observed origin. "
                f"The {unobserved} code-only API(s) (no crawler observation) will use this URL — "
                f"they will 404 if the backend lives elsewhere. Suggested --url: {observed_origins[0]}",
                flush=True,
            )

        # ── step 1: login ────────────────────────────────────────────────
        login_item = find_login_endpoint(api_items)
        login_result: Optional[LoginResult] = None
        token: Optional[str] = None
        token_type = args.auth_scheme

        # Prefer a bearer harvested from a live authenticated browser session
        # (output/crawler/auth-token.json, written by harvest-token.mjs). OIDC /
        # Firebase backends mint their token in-browser — there is no
        # credential-POST login endpoint that returns one — so this is the only
        # way their authenticated endpoints get anything but a 401.
        harvested = _load_harvested_token(repo_root)
        if harvested:
            token = harvested["token"]
            token_type = harvested.get("scheme") or args.auth_scheme
            print(
                f"[api-test-generator] using harvested bearer "
                f"({token_type} {token[:12]}… from {harvested.get('origin')})",
                flush=True,
            )

        if not token and login_item and args.login_email and args.login_password:
            login_base = _origin_for(login_item) or fallback_base_url
            login_path = login_item["primary"]["path"]
            print(
                f"[api-test-generator] login endpoint: "
                f"{login_item['primary']['method']} {login_base.rstrip('/')}{login_path}",
                flush=True,
            )
            # Retry login up to 3 times — many backends have transient hiccups
            # right after reloading (pool warmup, passlib/bcrypt lazy init, etc.).
            # Idempotent + cheap, so retrying is safe.
            import time as _time
            for attempt in range(1, 4):
                login_result = attempt_login(
                    base_url=login_base,
                    api_item=login_item,
                    email=args.login_email,
                    password=args.login_password,
                    timeout_s=args.timeout_s,
                    mock_data=mock_data,
                )
                if login_result.ok:
                    break
                if attempt < 3:
                    print(
                        f"[api-test-generator] login attempt {attempt}/3 failed "
                        f"({login_result.error}); retrying in 1s…",
                        flush=True,
                    )
                    _time.sleep(1)
            if login_result.ok:
                token = login_result.token
                token_type = login_result.token_type or args.auth_scheme
                print(f"[api-test-generator] login OK — token captured ({token_type} {(token or '')[:12]}…)", flush=True)
            else:
                print(f"[api-test-generator] login FAILED: {login_result.error}", flush=True)
        elif not token:
            reason = "no login endpoint found" if not login_item else "no credentials provided"
            print(f"[api-test-generator] skipping login: {reason}", flush=True)

        login_summary = _build_login_summary(login_item, login_result)
        if harvested and not login_result:
            login_summary = {
                "attempted": True,
                "login_url": harvested.get("sampleUrl"),
                "ok": True,
                "response_status": None,
                "error": None,
                "token_type": token_type,
                "token_preview": (token or "")[:12] + "…" if token else None,
                "source": "harvested-browser-session",
            }

        # ── step 2: build + run remaining ────────────────────────────────
        # Skip the login endpoint itself in the per-API loop (we already
        # ran it). Cap with max_tests if set.
        login_id = (login_item or {}).get("id") if login_item else None
        candidates = [it for it in api_items if it.get("id") != login_id]
        if args.max_tests:
            candidates = candidates[:args.max_tests]

        test_results: list[TestResult] = []
        skipped_items: list[dict] = []
        curls_generated = 0

        for item in candidates:
            primary = item.get("primary") or {}
            api_id  = item.get("id") or f"{primary.get('method')}:{primary.get('path')}"
            api_method = (primary.get("method") or "GET").upper()
            api_path   = primary.get("path") or ""

            # Session-safety gate: never execute endpoints that would rotate
            # the password, revoke the token, or delete the acting account —
            # doing so breaks every authenticated test that follows.
            exempt_reason = is_exempt(api_method, api_path, exempt_rules)
            if exempt_reason:
                skipped_items.append({"method": api_method, "path": api_path, "reason": exempt_reason})
                print(f"  ⊘ {api_method:6} {api_path:60} → skipped (exempt: {exempt_reason})", flush=True)
                continue

            body    = synthesize_body(item, db_tables=db_tables, mock_data=mock_data, openapi=openapi)
            # Per-API origin: crawler-observed wins; user's --url is the fallback.
            api_base_url = _origin_for(item) or fallback_base_url
            # Real path-param values the crawler saw the frontend send for
            # THIS endpoint. Falls back to "1" inside curl_builder if absent.
            path_params = _path_params_for(item, mock_data)
            argv, pretty = build_curl(
                base_url=api_base_url,
                api_item=item,
                body=body,
                auth_token=token,
                auth_scheme=token_type,
                timeout_s=args.timeout_s,
                path_params=path_params,
            )
            write_curl_script(curls_dir, api_id, pretty)
            curls_generated += 1

            if not args.execute:
                continue

            # Safe-mode gate: mutating requests are generated (curl written above,
            # inspectable) but never executed against the live target. Recorded
            # as skipped so the unified report shows EVERY test with its reason.
            if test_mode == "safe" and api_method not in ("GET", "HEAD", "OPTIONS"):
                skipped_items.append({"method": api_method, "path": api_path,
                                      "reason": "safe-mode (mutating method not executed)"})
                print(f"  ⊘ {api_method:6} {api_path:60} → skipped (safe-mode)", flush=True)
                continue

            method = (primary.get("method") or "GET").upper()
            # The URL we record in the test result should reflect the resolved
            # path (with concrete IDs substituted) — what actually got hit,
            # not the abstract pattern.
            url = (api_base_url.rstrip("/") + "/" + _resolve_path(primary.get("path") or "", path_params).lstrip("/"))
            tr = execute_curl(
                argv=argv, api_id=api_id, method=method, url=url,
                request_body=body, request_headers=_headers_from_argv(argv),
                timeout_s=args.timeout_s + 5,
            )
            test_results.append(tr)
            # Persist the full request + response for this test under runs/
            # — easy to grep, easy to diff between runs, easy to attach
            # to a bug report.
            write_run_artifact(runs_dir, tr)
            mark = "✓" if tr.ok else "✗"
            # Show HTTP status when we got one; otherwise show why curl couldn't
            # complete (connection refused / timeout / etc.). The previous "?"
            # made backend-down indistinguishable from real 404s.
            status_str = (
                str(tr.http_status) if tr.http_status is not None
                else _short_curl_error(tr.error or "no response")
            )
            print(f"  {mark} {method:6} {primary.get('path','?'):60} → {status_str}", flush=True)

        # ── step 3: write summary + report ───────────────────────────────
        write_summary(results_path, login_summary=login_summary, test_results=test_results, skipped=skipped_items)
        write_report(report_path,   login_summary=login_summary, test_results=test_results, skipped=skipped_items)
        if skipped_items:
            print(f"[api-test-generator] skipped {len(skipped_items)} session-mutating endpoint(s) (password reset / logout / delete-self)", flush=True)

        # ── step 4: write replay scripts (so the user can re-run later) ──
        # `_login.sh` + `run-all.sh` + `config.sh` + `README.md`.
        # The replay scripts only need the login base — every per-API .sh
        # file already has the full URL baked in (with the right per-API
        # origin) from the build_curl step.
        replay_base = _origin_for(login_item) if login_item else None
        write_replay_scripts(
            out_dir,
            base_url=replay_base or fallback_base_url,
            login_url=(login_result.login_url if login_result else None),
            login_body_template=_template_from_login_item(login_item),
            login_token_field="access_token",
            auth_scheme=token_type or args.auth_scheme,
        )

        passed = sum(1 for t in test_results if t.ok)
        failed = len(test_results) - passed
        # Overall skill `ok`: auth (when attempted) succeeded AND every executed test passed.
        # A harvested bearer counts as a successful login.
        got_auth = bool(harvested) or bool(login_result and login_result.ok)
        login_attempted = bool(harvested) or (login_item is not None and bool(args.login_email))
        overall_ok = (not login_attempted or got_auth) and (failed == 0 or not args.execute)

        return ApiTestGeneratorResult(
            ok=bool(overall_ok),
            curls_generated=curls_generated,
            curls_executed=len(test_results),
            passed=passed, failed=failed,
            skipped=len(skipped_items),
            login_succeeded=got_auth,
            login_url=(login_result.login_url if login_result else None),
            output_dir=str(out_dir),
            summary_path=str(results_path),
            report_path=str(report_path),
        )


# ── helpers ────────────────────────────────────────────────────────────────


def _detect_repo_root() -> Path:
    # This file: <repo>/generation-layer/api-test-generator/skill.py
    return Path(__file__).resolve().parents[2]


def _load_harvested_token(repo_root: Path) -> Optional[dict]:
    """Read a live bearer harvested from an authenticated browser session.

    Written by testo/src/crawler/harvest-token.mjs (run by `ctx execute` before
    the suites). Returns a dict with at least {'token'} or None when absent /
    malformed. This is the auth path for OIDC/Firebase backends whose token
    isn't obtainable via a credential POST.
    """
    p = repo_root / "output" / "crawler" / "auth-token.json"
    try:
        data = json.loads(p.read_text())
    except (OSError, ValueError):
        return None
    tok = data.get("token") if isinstance(data, dict) else None
    return data if isinstance(tok, str) and tok else None


def _short_curl_error(err: str) -> str:
    """Compress curl's verbose error into a single tag for the per-API line."""
    s = (err or "").lower()
    if "could not resolve host" in s:        return "dns-fail"
    if "connection refused" in s:            return "conn-refused"
    if "timed out" in s or "timeout" in s:   return "timeout"
    if "ssl" in s or "certificate" in s:     return "ssl-fail"
    if "no response" in s:                   return "no-response"
    # Fall back to curl exit-code tag if present.
    import re as _re
    m = _re.search(r"curl exit (\d+)", s)
    if m: return f"curl-exit-{m.group(1)}"
    return "err"


def _path_params_for(api_item: dict, mock_data: dict[str, dict]) -> dict[str, str]:
    """Pick concrete path-param values for this endpoint.

    Strategy:
      1. mock-data bundle's `observedPathParams[name][0]` — the crawler
         saw this value used live, so it's almost certainly valid (FK
         exists, user has access, etc.).
      2. otherwise omit — curl_builder._resolve_path_params falls back to
         "1", which works for synthetic test data but fails for real IDs
         the backend rejects with 403/404.
    """
    primary = api_item.get("primary") or {}
    method = (primary.get("method") or "").upper()
    path = primary.get("path") or ""
    entry = mock_data.get(f"{method}:{path}") if mock_data else None
    observed = (entry or {}).get("observedPathParams") or {}
    out: dict[str, str] = {}
    for name, values in observed.items():
        if isinstance(values, list) and values:
            out[name] = str(values[0])
    return out


def _resolve_path(path: str, params: dict[str, str]) -> str:
    """Local copy of curl_builder._resolve_path_params for the URL we log."""
    import re as _re
    def sub(m):
        name = m.group(1) or m.group(2)
        return str(params.get(name, "1"))
    return _re.sub(r"\{(\w+)\}|:(\w+)", sub, path)


def _origin_for(api_item: Optional[dict]) -> Optional[str]:
    """The crawler-observed origin for an API, if we saw it live.

    Indexer's apis topic merges `origin` from crawler observations into
    `primary` (see context-layer/indexer/topics/apis.mjs `liveOnly` set).
    Returns None for endpoints that exist only in code (no crawler
    observation) — caller falls back to user's --url for those.
    """
    if not api_item:
        return None
    primary = api_item.get("primary") or {}
    origin = primary.get("origin")
    return origin if isinstance(origin, str) and origin else None


def _resolve(repo_root: Path, p: Path) -> Path:
    return p if p.is_absolute() else (repo_root / p)


def _index_db_tables(db_path: Path) -> dict[str, dict]:
    """Index db-schema items by table name. Empty dict if file missing."""
    if not db_path.is_file():
        return {}
    bundle = json.loads(db_path.read_text(encoding="utf-8"))
    out: dict[str, dict] = {}
    for item in bundle.get("items") or []:
        primary = item.get("primary") or {}
        name = primary.get("table")
        if name:
            out[name] = item
    return out


def _detect_base_url(api_items: list[dict], repo_root: Path) -> str:
    """Pick a base URL: crawler bundle's first origin, else first item's origin."""
    crawler_path = repo_root / "output" / "crawler" / "bundle.json"
    if crawler_path.is_file():
        try:
            cb = json.loads(crawler_path.read_text(encoding="utf-8"))
            origins = (cb.get("stats") or {}).get("origins") or []
            # Prefer an API-shaped origin (port 8000/8080/443/etc) over the frontend.
            api_origins = [o for o in origins if any(p in o for p in (":8000", ":8080", ":8443", ":443", "/api"))]
            if api_origins: return api_origins[0]
            if origins: return origins[0]
        except (json.JSONDecodeError, OSError):
            pass
    for item in api_items:
        for obs in (item.get("observations") or []):
            fields = obs.get("fields") or {}
            origin = fields.get("origin")
            if origin: return origin
    return "http://localhost:3000"


def _build_login_summary(login_item: Optional[dict], login_result: Optional[LoginResult]) -> dict:
    if login_result is None:
        return {
            "attempted": False,
            "login_url": (login_item or {}).get("primary", {}).get("path") if login_item else None,
            "ok": False,
            "error": "not attempted (no credentials or no login endpoint)",
            "response_status": None,
        }
    return {
        "attempted": True,
        "login_url": login_result.login_url,
        "ok": login_result.ok,
        "response_status": login_result.response_status,
        "error": login_result.error,
        "token_type": login_result.token_type,
        "token_preview": (login_result.token or "")[:12] + "…" if login_result.token else None,
    }


def _template_from_login_item(login_item: Optional[dict]) -> Optional[str]:
    """Build the JSON template _login.sh should POST to refresh tokens.

    Mimics whatever shape the crawler observed (username vs email field,
    extra constants like grant_type). Returns None when no login item
    was found — _login.sh's default applies."""
    if not login_item:
        return None
    sample_bodies: list = []
    for obs in (login_item.get("observations") or []):
        fields = obs.get("fields") or {}
        sample_bodies.extend(fields.get("exampleRequestBodies") or [])
    if not sample_bodies or not isinstance(sample_bodies[0], dict):
        return None

    sample = sample_bodies[0]
    template: dict = {}
    for k, v in sample.items():
        kl = k.lower()
        if kl in ("email", "user_email"):                                          template[k] = "$LOGIN_EMAIL"
        elif kl in ("username", "user", "login", "user_name"):                     template[k] = "$LOGIN_EMAIL"
        elif kl in ("password", "pass", "passwd", "secret"):                       template[k] = "$LOGIN_PASSWORD"
        else:                                                                       template[k] = v
    return json.dumps(template)


def _headers_from_argv(argv: list[str]) -> dict[str, str]:
    out: dict[str, str] = {}
    i = 0
    while i < len(argv) - 1:
        if argv[i] == "-H":
            kv = argv[i + 1]
            if ":" in kv:
                k, v = kv.split(":", 1)
                # Redact Authorization in the recorded results.
                if k.strip().lower() == "authorization":
                    v = v.split(" ", 1)[0] + " <redacted>" if " " in v else "<redacted>"
                out[k.strip()] = v.strip()
            i += 2
        else:
            i += 1
    return out


__all__ = ["ApiTestGeneratorSkill", "ApiTestGeneratorArgs", "ApiTestGeneratorResult"]
