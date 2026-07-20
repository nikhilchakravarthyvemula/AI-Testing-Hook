"""Synthesize a realistic request body for an API endpoint.

Priority order (cheapest → smartest):
  1. Crawler-observed `exampleRequestBodies` — actual production-shape data.
  2. DB-schema-driven defaults — for an endpoint that looks like
     "POST /<table>" / "PUT /<table>/{id}", borrow column types from
     indexed db-schema items to fabricate a body.
  3. Pydantic schema_ref — handlers reference a schema name we can
     look up in the API observation's `request_schema` block.
  4. Empty body — give up gracefully (test still runs, may 400).

No LLM call here in v1 — every layer is deterministic and works offline.
A future v2 can plug an LLM call in as priority 4 (or option flag).
"""

from __future__ import annotations

import random
import re
import string
from typing import Any, Optional


# ── primitive value synth ──────────────────────────────────────────────────


def _value_for_type(col_type: str | None, *, col_name: str = "") -> Any:
    """Map a SQL-like type string to a plausible primitive value."""
    t = (col_type or "").lower()
    name = (col_name or "").lower()

    # Name-driven specialisation overrides type-only guess.
    if any(k in name for k in ("email", "mail")):
        return f"qa{_rand_str(6)}@example.com"
    if name == "phone" or name.endswith("_phone"):
        return "+1-415-555-0123"
    if name in ("url", "website", "homepage"):
        return "https://example.com/"
    if "uuid" in name or "uuid" in t:
        return _rand_uuid()
    if name in ("password", "pass", "passwd"):
        return "Qa-test-1234"
    if name in ("first_name", "firstname"):  return "Test"
    if name in ("last_name", "lastname"):    return "User"
    if name in ("name", "title", "label"):   return "qa-" + _rand_str(8)
    if name.endswith("_id"):                 return random.randint(1, 100)

    # Type-driven defaults.
    if any(tt in t for tt in ("int", "serial", "bigint", "smallint")):
        return random.randint(1, 1000)
    if any(tt in t for tt in ("float", "double", "real", "decimal", "numeric")):
        return round(random.uniform(0.1, 100.0), 2)
    if "bool" in t:
        return True
    if any(tt in t for tt in ("date", "time")):
        return "2025-01-15T12:00:00Z"
    if "json" in t:
        return {}
    if any(tt in t for tt in ("uuid", "guid")):
        return _rand_uuid()
    if any(tt in t for tt in ("text", "string", "varchar", "char")):
        return f"qa-{_rand_str(8)}"

    # Unknown — best-effort string.
    return f"qa-{_rand_str(6)}"


def _rand_str(n: int = 8) -> str:
    return "".join(random.choices(string.ascii_lowercase + string.digits, k=n))


def _rand_uuid() -> str:
    h = _rand_str(32)
    return f"{h[0:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:32]}"


# ── body synthesis ─────────────────────────────────────────────────────────


# Fields that are dangerous to include in a generated body — putting a
# random value here would silently rotate the test user's credentials,
# permissions, or identity, leaving the next run unable to log in.
# Stripped from BOTH crawler-observed samples and schema-driven synthesis.
# Generic across frameworks (password/email/role appear everywhere).
_DANGEROUS_BODY_FIELDS = frozenset({
    "password", "new_password", "old_password", "current_password", "passwd", "pwd",
    "role", "roles", "role_id", "role_ids",
    "is_active", "is_admin", "is_superuser", "is_staff", "is_deleted",
    "permissions", "perms", "scopes",
    "api_key", "secret", "token", "refresh_token", "access_token",
    "email",   # changing email locks user out from their known login
})


def synthesize_body(
    api_item: dict,
    *,
    db_tables: dict[str, dict] | None = None,
    mock_data: dict[str, dict] | None = None,
    openapi: dict[str, dict] | None = None,
) -> Optional[dict]:
    """Pick or build a request body for an endpoint. Returns None when no
    body is appropriate (e.g. GET/HEAD).

    `mock_data` — dict keyed by `<METHOD>:<path>`, values are entries from
        `output/mock-data/bundle.json#facts.endpoints`. Strongest signal:
        real bodies the frontend actually sent and the backend accepted.

    `openapi`   — dict keyed by `<METHOD>:<path>`, values are entries from
        `output/openapi-probe/bundle.json#facts.endpoints`. Second-strongest:
        the published request schema with $refs resolved. Generic across
        any framework that serves OpenAPI/Swagger.
    """
    primary = api_item.get("primary") or {}
    method = (primary.get("method") or "").upper()
    if method in ("GET", "HEAD", "DELETE", "OPTIONS"):
        return None

    key = f"{method}:{primary.get('path') or ''}"
    path = primary.get("path") or ""
    # PUT/PATCH on "self" endpoints (`/me`, `/users/me`, `/profile`,
    # `/account`) are the highest-risk for credential rotation: their bodies
    # always include the auth fields. Apply stricter stripping there.
    is_self_mutating = method in ("PUT", "PATCH") and _looks_like_self_endpoint(path)

    # 1. Real bodies from the mock-data bundle.
    if mock_data and key in mock_data:
        for s in (mock_data[key].get("samples") or []):
            body = (s.get("request") or {}).get("body")
            if isinstance(body, dict) and body:
                return _strip_dangerous_fields(body, aggressive=is_self_mutating)

    # 2. Schema-driven body from OpenAPI (works for any spec-publishing
    #    backend: FastAPI/NestJS/Spring/DRF/Laravel/Express+swagger/...).
    if openapi and key in openapi:
        ep = openapi[key]
        # Prefer a spec-provided example if present — author-curated wins.
        if ep.get("requestExample") is not None:
            ex = ep["requestExample"]
            if isinstance(ex, dict):
                return _strip_dangerous_fields(ex, aggressive=is_self_mutating)
        schema = ep.get("requestSchema")
        if schema:
            body = build_body_from_schema(schema)
            if isinstance(body, dict) and body:
                return _strip_dangerous_fields(body, aggressive=is_self_mutating)

    # 3. Legacy fallback — exampleRequestBodies surfaced by older indexer paths.
    for obs in (api_item.get("observations") or []):
        fields = obs.get("fields") or {}
        for body in fields.get("exampleRequestBodies") or []:
            if isinstance(body, dict) and body:
                return body

    # 4. DB-schema-driven fabrication (rough — uses table columns).
    if db_tables:
        table = _guess_table(primary.get("path") or "", db_tables)
        if table:
            return _body_from_table(table)

    # 5. Schema_ref stub (last-resort, body says "I don't know").
    schema_ref = None
    for obs in (api_item.get("observations") or []):
        fields = obs.get("fields") or {}
        if fields.get("schema_ref"):
            schema_ref = fields["schema_ref"]
            break
    if schema_ref:
        return {"_note": f"stub body for schema {schema_ref}", "data": {}}

    # 6. Empty — let the API fail loudly.
    return {}


def _looks_like_self_endpoint(path: str) -> bool:
    """Detect endpoints that mutate the calling user's own record.

    Examples:
      /me, /api/me, /users/me, /v1/users/me, /profile, /account, /current-user
    """
    p = (path or "").lower()
    if p.endswith("/me") or p.endswith("/profile") or p.endswith("/account"):
        return True
    if "/me/" in p or "/profile/" in p or "/account/" in p:
        return True
    if p.endswith("/current-user") or p.endswith("/current_user"):
        return True
    return False


def _strip_dangerous_fields(body, *, aggressive: bool):
    """Remove credential / permission / identity fields from a body.

    `aggressive` — applied on self-mutating endpoints. There we also strip
    `email` (changing it locks the user out of their known login). For
    other endpoints we keep email but still strip credentials & roles.
    """
    if not isinstance(body, dict):
        return body
    blocked = _DANGEROUS_BODY_FIELDS if aggressive else (_DANGEROUS_BODY_FIELDS - {"email"})
    cleaned = {k: v for k, v in body.items() if k.lower() not in blocked}
    # Recurse into nested objects (e.g. {user: {password: …}}).
    for k, v in list(cleaned.items()):
        if isinstance(v, dict):
            cleaned[k] = _strip_dangerous_fields(v, aggressive=aggressive)
    return cleaned


# ── JSON Schema → sample body ──────────────────────────────────────────────


def build_body_from_schema(schema: dict, *, depth: int = 0, max_depth: int = 5) -> Any:
    """Build a sample JSON value satisfying a JSON Schema.

    Generic across frameworks — uses only the JSON Schema vocabulary
    (type / format / properties / required / enum / oneOf / anyOf /
    allOf / items / example / default / minimum / minLength / pattern).

    Strategy:
      * `example` / `default` always win — author-curated > anything we'd guess
      * For objects, emit every required field; emit optional fields only at
        depth 0 (so root payloads are realistic, nested aren't bloated)
      * For oneOf/anyOf, pick the first option
      * For allOf, merge all object fragments
    """
    if not isinstance(schema, dict) or depth > max_depth:
        return None

    # Author-provided sample beats anything we'd synthesize.
    if "example" in schema:
        return schema["example"]
    if "default" in schema:
        return schema["default"]
    if "enum" in schema and isinstance(schema["enum"], list) and schema["enum"]:
        return schema["enum"][0]
    if "const" in schema:
        return schema["const"]

    # Composition keywords — resolve before falling through to type.
    if "allOf" in schema and isinstance(schema["allOf"], list):
        merged: dict[str, Any] = {}
        for sub in schema["allOf"]:
            v = build_body_from_schema(sub, depth=depth, max_depth=max_depth)
            if isinstance(v, dict):
                merged.update(v)
        if merged:
            return merged
    if "oneOf" in schema and isinstance(schema["oneOf"], list) and schema["oneOf"]:
        return build_body_from_schema(schema["oneOf"][0], depth=depth, max_depth=max_depth)
    if "anyOf" in schema and isinstance(schema["anyOf"], list) and schema["anyOf"]:
        # Prefer a non-null option for anyOf (common pydantic pattern for Optional).
        for sub in schema["anyOf"]:
            if isinstance(sub, dict) and sub.get("type") != "null":
                v = build_body_from_schema(sub, depth=depth, max_depth=max_depth)
                if v is not None:
                    return v
        return build_body_from_schema(schema["anyOf"][0], depth=depth, max_depth=max_depth)

    t = schema.get("type")
    # Multi-type (JSON Schema allows array of types) — pick first non-null.
    if isinstance(t, list):
        non_null = [x for x in t if x != "null"]
        t = non_null[0] if non_null else t[0]

    # Object (or schema with `properties` and no explicit type).
    if t == "object" or (t is None and "properties" in schema):
        required = set(schema.get("required") or [])
        props = schema.get("properties") or {}
        body: dict[str, Any] = {}
        for name, sub in props.items():
            # Always emit required. At root (depth=0), also emit optionals
            # so the body is a realistic full request. Below root, only required.
            if name in required or depth == 0:
                v = build_body_from_schema(sub, depth=depth + 1, max_depth=max_depth)
                if v is None and name in required:
                    v = _value_for_schema_name(name, sub)
                if v is not None:
                    body[name] = v
        # If schema declares additional/free-form properties and gave us nothing
        # else, fall back to a single placeholder so the request isn't empty.
        if not body and schema.get("additionalProperties") is True:
            return {"_extra": "value"}
        return body

    if t == "array":
        items = schema.get("items") or {}
        v = build_body_from_schema(items, depth=depth + 1, max_depth=max_depth)
        return [v] if v is not None else []

    if t == "string":
        fmt = (schema.get("format") or "").lower()
        if fmt == "email":         return f"qa{_rand_str(6)}@example.com"
        if fmt in ("date-time", "datetime"): return "2025-01-15T12:00:00Z"
        if fmt == "date":          return "2025-01-15"
        if fmt == "time":          return "12:00:00"
        if fmt == "uuid":          return _rand_uuid()
        if fmt in ("uri", "url"):  return "https://example.com/"
        if fmt == "hostname":      return "example.com"
        if fmt == "ipv4":          return "127.0.0.1"
        if fmt == "ipv6":          return "::1"
        if fmt == "password":      return "TestPass-12345"
        if fmt == "byte":          return "dGVzdA=="     # base64
        if fmt == "binary":        return "binary-bytes"
        min_len = schema.get("minLength") or 0
        max_len = schema.get("maxLength") or 64
        if "pattern" in schema:
            # We don't synthesize from a regex; emit a neutral test string
            # that often passes loose patterns (alnum + dash).
            return "qa-test-1234"[:max(min_len, 11)]
        s = "qa-" + _rand_str(8)
        if len(s) < min_len:
            s = s + "x" * (min_len - len(s))
        if len(s) > max_len:
            s = s[:max_len]
        return s

    if t == "integer":
        mn = schema.get("minimum")
        if mn is not None:
            return int(mn)
        return 1
    if t == "number":
        mn = schema.get("minimum")
        if mn is not None:
            return float(mn)
        return 1.0
    if t == "boolean":
        return True
    if t == "null":
        return None

    return None


def _value_for_schema_name(name: str, sub: dict) -> Any:
    """When build_body_from_schema returns None for a *required* field, fall
    back to a name-driven guess so the request isn't missing keys."""
    return _value_for_type(sub.get("type") if isinstance(sub.get("type"), str) else None,
                           col_name=name)


def load_mock_data_index(mock_data_bundle_path) -> dict[str, dict]:
    """Load `output/mock-data/bundle.json` into a `METHOD:path → entry` dict.
    Returns {} when the bundle is missing — fallback behavior is unchanged."""
    return _load_endpoint_index(mock_data_bundle_path)


def load_openapi_index(openapi_bundle_path) -> dict[str, dict]:
    """Load `output/openapi-probe/bundle.json` into a `METHOD:path → entry` dict.
    Returns {} when the bundle is missing — fallback behavior is unchanged."""
    return _load_endpoint_index(openapi_bundle_path)


def _load_endpoint_index(bundle_path) -> dict[str, dict]:
    import json
    from pathlib import Path
    p = Path(bundle_path)
    if not p.is_file():
        return {}
    bundle = json.loads(p.read_text(encoding="utf-8"))
    out: dict[str, dict] = {}
    for ep in (bundle.get("facts") or {}).get("endpoints") or []:
        method = (ep.get("method") or "").upper()
        path = ep.get("path") or ""
        if method and path:
            out[f"{method}:{path}"] = ep
    return out


def _guess_table(path: str, db_tables: dict[str, dict]) -> Optional[dict]:
    """Best-effort: pick the table whose name appears in the path."""
    parts = [p for p in re.split(r"[/{}]", path) if p and not p.startswith(":")]
    for part in reversed(parts):  # rightmost match (e.g. /users/123/posts → "posts")
        if part in db_tables:
            return db_tables[part]
        # singular → plural sniff (e.g. user → users)
        if (part + "s") in db_tables:
            return db_tables[part + "s"]
    return None


def _body_from_table(table_item: dict) -> dict:
    """Build a body using the table's columns. Skips PK + audit cols."""
    primary = table_item.get("primary") or table_item
    columns = primary.get("columns") or []
    pk = set(primary.get("primaryKeyColumns") or [])
    auto_audit = {"created_at", "updated_at", "deleted_at", "is_deleted"}

    body: dict[str, Any] = {}
    for col in columns:
        name = col.get("name") or ""
        if not name or name in pk or name in auto_audit:
            continue
        # Skip server-default columns — DB picks them.
        if col.get("serverDefault") is not None or col.get("default") is not None:
            continue
        body[name] = _value_for_type(col.get("type"), col_name=name)
    return body


__all__ = ["synthesize_body", "_value_for_type"]
