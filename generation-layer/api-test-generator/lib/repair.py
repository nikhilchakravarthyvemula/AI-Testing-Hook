"""Self-repair for failing request bodies.

When a generated curl returns a client-side *validation* error (HTTP 422 /
400), the body is wrong — the server tells us exactly how. This module reads
that structured error and patches the body, so the caller can re-run and
re-validate (bounded to a few attempts).

Generic across frameworks: handles FastAPI/Pydantic's `{"detail": [{loc, type,
msg, ctx}]}`, plain `{"errors": {field: msg}}`, and `{"message": ...}` shapes.
Falls back to None (no actionable fix) so the caller stops retrying.
"""

from __future__ import annotations

import re
from typing import Any, Optional


REPAIRABLE_STATUSES = {400, 422}


def repair_request_body(
    body: Any,
    response_body: Any,
    openapi_ep: Optional[dict] = None,
) -> Optional[dict]:
    """Return a repaired COPY of `body` using the validation error in
    `response_body`, or None if nothing actionable was found (stop retrying)."""
    errors = _extract_field_errors(response_body)
    if not errors:
        return None
    schema_props = _request_schema_props(openapi_ep)
    out = dict(body) if isinstance(body, dict) else {}
    changed = False
    for err in errors:
        # Drop the leading "body" segment FastAPI prepends; ignore query/path errs.
        path = [p for p in err["path"] if p != "body"]
        if not path or err["path"][:1] == ["query"] or err["path"][:1] == ["path"]:
            continue
        if err["kind"] == "missing":
            _set_nested(out, path, _sample_for(path[-1], schema_props, err))
            changed = True
        elif err["kind"] == "type":
            _set_nested(out, path, _coerce_for(path[-1], schema_props, err))
            changed = True
        elif err["kind"] == "enum" and err.get("allowed"):
            _set_nested(out, path, err["allowed"][0])
            changed = True
    return out if changed else None


# ── error extraction ─────────────────────────────────────────────────────────

def _extract_field_errors(resp: Any) -> list[dict]:
    """Normalize various validation-error shapes into
    [{path:[...], kind:'missing'|'type'|'enum'|'other', msg, allowed?}]."""
    out: list[dict] = []
    if isinstance(resp, dict) and isinstance(resp.get("detail"), list):
        for d in resp["detail"]:
            if not isinstance(d, dict):
                continue
            loc = [str(x) for x in (d.get("loc") or [])]
            typ = str(d.get("type") or "")
            msg = str(d.get("msg") or "")
            ctx = d.get("ctx") or {}
            out.append({
                "path": loc, "kind": _classify(typ, msg), "msg": msg,
                "allowed": _allowed_values(typ, msg, ctx),
            })
        return out
    # plain {"errors": {field: msg|[msg]}}
    if isinstance(resp, dict) and isinstance(resp.get("errors"), dict):
        for field, m in resp["errors"].items():
            msg = m if isinstance(m, str) else " ".join(map(str, m if isinstance(m, list) else [m]))
            out.append({"path": [str(field)], "kind": _classify("", msg), "msg": msg, "allowed": _allowed_values("", msg, {})})
        return out
    return out


def _classify(typ: str, msg: str) -> str:
    t, m = typ.lower(), msg.lower()
    if "missing" in t or "required" in m:
        return "missing"
    if "enum" in t or "permitted" in m or "must be one of" in m:
        return "enum"
    if "parsing" in t or "type" in t or "not a valid" in m or "should be" in m:
        return "type"
    return "other"


def _allowed_values(typ: str, msg: str, ctx: dict) -> list:
    if isinstance(ctx.get("expected"), str):
        # FastAPI literal/enum ctx, e.g. "'a' or 'b'"
        vals = re.findall(r"'([^']+)'", ctx["expected"])
        if vals:
            return vals
    vals = re.findall(r"'([^']+)'", msg)
    return vals if ("permitted" in msg.lower() or "one of" in msg.lower()) else []


# ── sample / coercion values ──────────────────────────────────────────────────

def _request_schema_props(openapi_ep: Optional[dict]) -> dict:
    if not isinstance(openapi_ep, dict):
        return {}
    rb = openapi_ep.get("requestBody") or openapi_ep.get("request_schema") or {}
    schema = rb.get("schema") if isinstance(rb, dict) else None
    schema = schema or rb
    if isinstance(schema, dict):
        return schema.get("properties") or {}
    return {}


def _sample_for(name: str, props: dict, err: dict) -> Any:
    spec = props.get(name) if isinstance(props, dict) else None
    if isinstance(spec, dict):
        if spec.get("enum"):
            return spec["enum"][0]
        if "example" in spec:
            return spec["example"]
        t = spec.get("type")
        fmt = spec.get("format")
        v = _by_type(t, fmt)
        if v is not _UNSET:
            return v
    if err.get("allowed"):
        return err["allowed"][0]
    return _by_name(name)


def _coerce_for(name: str, props: dict, err: dict) -> Any:
    typ = (err.get("msg") or "").lower()
    if "int" in typ or "integer" in typ:
        return 0
    if "float" in typ or "number" in typ or "decimal" in typ:
        return 0.0
    if "bool" in typ:
        return True
    if "list" in typ or "array" in typ:
        return []
    if "dict" in typ or "object" in typ or "mapping" in typ:
        return {}
    return _sample_for(name, props, err)


_UNSET = object()

def _by_type(t: Optional[str], fmt: Optional[str]) -> Any:
    if t == "integer":
        return 0
    if t == "number":
        return 0.0
    if t == "boolean":
        return True
    if t == "array":
        return []
    if t == "object":
        return {}
    if t == "string":
        return _by_format(fmt)
    return _UNSET


def _by_format(fmt: Optional[str]) -> str:
    f = (fmt or "").lower()
    if f in ("email",):
        return "qa-test@example.com"
    if f in ("date-time", "datetime"):
        return "2024-01-01T00:00:00Z"
    if f == "date":
        return "2024-01-01"
    if f == "uuid":
        return "00000000-0000-0000-0000-000000000000"
    if f in ("uri", "url"):
        return "https://example.com"
    return "qa-test"


def _by_name(name: str) -> Any:
    n = name.lower()
    if "email" in n:
        return "qa-test@example.com"
    if "password" in n or "passwd" in n:
        return "TestPass!23"          # satisfies common complexity rules (test env)
    if n.endswith("_id") or n == "id":
        return "1"
    if "grant_type" in n:
        return "password"
    if "count" in n or "num" in n or "qty" in n or "amount" in n:
        return 1
    if n.startswith("is_") or n.startswith("has_") or "enabled" in n or "active" in n:
        return True
    if "url" in n or "uri" in n:
        return "https://example.com"
    if "date" in n or "time" in n:
        return "2024-01-01T00:00:00Z"
    return "qa-test"


# ── nested set ────────────────────────────────────────────────────────────────

def _set_nested(obj: dict, path: list, value: Any) -> None:
    cur = obj
    for key in path[:-1]:
        if not isinstance(cur.get(key), dict):
            cur[key] = {}
        cur = cur[key]
    cur[path[-1]] = value
