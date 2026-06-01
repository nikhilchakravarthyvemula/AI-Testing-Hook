"""Form-field extraction from HTML / JSX / Vue / Svelte markup.

Walks `<input>`, `<select>`, `<textarea>` elements and pulls every
HTML5 attribute the parsers can populate. The result is a list of
dicts shaped to feed `FormField` constructors directly.

What's extracted (per field):
  * name, field_type
  * label_text (from `<label for="x">…</label>` association)
  * placeholder, default_value
  * is_required, is_disabled, is_readonly
  * autocomplete
  * Validation: pattern, min, max, minlength, maxlength, step, accept
  * Options: list of {value, label} for `<select><option>`

What's NOT extracted (deferred — needs cross-element resolution):
  * `form_intent` — which `<button type=submit>` owns this field. The
    extractor returns `form_intent=None`; downstream layers resolve.
  * Conditional rendering of fields (`{isOpen && <input/>}`) — we emit
    them anyway; they're still in the source.
"""

from __future__ import annotations

import re
from typing import Any


# Element tag patterns — we use one regex per shape because the
# attribute sets differ enough that one mega-regex would be unreadable.
_INPUT_RE = re.compile(r"""<input\b(?P<attrs>[^>]*?)/?>""", re.IGNORECASE | re.DOTALL)
_TEXTAREA_RE = re.compile(
    r"""<textarea\b(?P<attrs>[^>]*?)>(?P<default>.*?)</textarea>""",
    re.IGNORECASE | re.DOTALL,
)
_SELECT_RE = re.compile(
    r"""<select\b(?P<attrs>[^>]*?)>(?P<inner>.*?)</select>""",
    re.IGNORECASE | re.DOTALL,
)
_OPTION_RE = re.compile(
    r"""<option\b(?P<attrs>[^>]*?)>(?P<label>.*?)</option>""",
    re.IGNORECASE | re.DOTALL,
)
# `<label for="x">Username</label>` — we extract these once and look up by id.
_LABEL_RE = re.compile(
    r"""<label\b[^>]*?\bfor\s*=\s*["'](?P<for_id>[^"']+)["'][^>]*>(?P<text>.*?)</label>""",
    re.IGNORECASE | re.DOTALL,
)


# Maps `type="..."` strings to our `FormFieldType` enum values.
_INPUT_TYPE_NORMALISE = {
    "text": "text", "password": "password", "email": "email", "number": "number",
    "tel": "tel", "url": "url", "search": "search",
    "checkbox": "checkbox", "radio": "radio",
    "date": "date", "datetime-local": "datetime-local", "time": "time",
    "month": "month", "week": "week",
    "file": "file", "color": "color", "range": "range", "hidden": "hidden",
}


def extract_form_fields(content: str) -> list[dict[str, Any]]:
    """Return a list of form-field dicts ready to feed `FormField(...)`.

    The caller adds `route_path`, `selector_*`, and `provenance` —
    those are the per-route bits this helper doesn't know.
    """
    labels = _collect_labels(content)
    fields: list[dict[str, Any]] = []

    for match in _INPUT_RE.finditer(content):
        attrs = _parse_attrs(match.group("attrs"))
        field = _input_to_field(attrs, labels)
        if field is not None:
            fields.append(field)

    for match in _TEXTAREA_RE.finditer(content):
        attrs = _parse_attrs(match.group("attrs"))
        default = match.group("default").strip()
        field = _textarea_to_field(attrs, default, labels)
        if field is not None:
            fields.append(field)

    for match in _SELECT_RE.finditer(content):
        attrs = _parse_attrs(match.group("attrs"))
        options = _parse_options(match.group("inner"))
        field = _select_to_field(attrs, options, labels)
        if field is not None:
            fields.append(field)

    return fields


# ── per-element conversion ─────────────────────────────────────────────────


def _input_to_field(
    attrs: dict[str, Any], labels: dict[str, str]
) -> dict[str, Any] | None:
    """`<input>` → FormField dict. Skips submit/button types — those are
    Interactions, not fields.
    """
    raw_type = (attrs.get("type") or "text").lower()
    if raw_type in ("submit", "button", "reset", "image"):
        return None
    field_type = _INPUT_TYPE_NORMALISE.get(raw_type, "text")

    name = attrs.get("name") or attrs.get("id")
    if not name:
        return None

    return _base_field(name, field_type, attrs, labels) | {
        "default_value": _stringify(attrs.get("value")),
    }


def _textarea_to_field(
    attrs: dict[str, Any], default_text: str, labels: dict[str, str]
) -> dict[str, Any] | None:
    name = attrs.get("name") or attrs.get("id")
    if not name:
        return None

    return _base_field(name, "textarea", attrs, labels) | {
        "default_value": default_text or None,
    }


def _select_to_field(
    attrs: dict[str, Any], options: list[dict[str, str]], labels: dict[str, str]
) -> dict[str, Any] | None:
    name = attrs.get("name") or attrs.get("id")
    if not name:
        return None

    default_value = None
    for opt in options:
        if opt.get("selected"):
            default_value = opt["value"]
            break

    return _base_field(name, "select", attrs, labels) | {
        "default_value": default_value,
        "options": [{"value": o["value"], "label": o["label"]} for o in options],
    }


# ── shared shape helpers ──────────────────────────────────────────────────


def _base_field(
    name: str, field_type: str, attrs: dict[str, Any], labels: dict[str, str]
) -> dict[str, Any]:
    """Common fields populated for every input/select/textarea."""
    elem_id = attrs.get("id")
    return {
        "name": name,
        "field_type": field_type,
        "label_text": labels.get(elem_id) if elem_id else None,
        "placeholder": _stringify(attrs.get("placeholder")),
        "is_required": _bool_attr(attrs, "required"),
        "is_disabled": _bool_attr(attrs, "disabled"),
        "is_readonly": _bool_attr(attrs, "readonly") or _bool_attr(attrs, "readOnly"),
        "autocomplete": _stringify(attrs.get("autocomplete") or attrs.get("autoComplete")),
        "min_value": _stringify(attrs.get("min")),
        "max_value": _stringify(attrs.get("max")),
        "min_length": _int_attr(attrs, "minlength") or _int_attr(attrs, "minLength"),
        "max_length": _int_attr(attrs, "maxlength") or _int_attr(attrs, "maxLength"),
        "pattern": _stringify(attrs.get("pattern")),
        "step": _stringify(attrs.get("step")),
        "accept": _stringify(attrs.get("accept")),
        # Selector defaults — caller can override when it has a better strategy.
        "selector_strategy": "css",
        "selector_value": f"[name='{name}']",
        "selector_role": None,
        "selector_name": None,
    }


def _collect_labels(content: str) -> dict[str, str]:
    """`{ id: label_text }` map from every `<label for="id">…</label>`."""
    out: dict[str, str] = {}
    for match in _LABEL_RE.finditer(content):
        text = " ".join(match.group("text").split())
        # Strip embedded JSX expressions; trust the literal text only.
        if "{" in text:
            continue
        if text:
            out[match.group("for_id")] = text
    return out


_ATTR_RE = re.compile(
    r"""(?P<name>[A-Za-z_:][A-Za-z0-9_:\-]*)\s*(?:=\s*(?:"(?P<dq>[^"]*)"|'(?P<sq>[^']*)'|\{(?P<jsx>[^}]*)\}|(?P<bare>[^\s>]+)))?""",
)


def _parse_attrs(attr_blob: str) -> dict[str, Any]:
    """Parse an attribute string into `{name: value}`. JSX `{expr}` and
    bare attributes (`required`) become `True` — they're presence flags.
    """
    out: dict[str, Any] = {}
    for match in _ATTR_RE.finditer(attr_blob):
        name = match.group("name")
        value = (
            match.group("dq")
            if match.group("dq") is not None
            else match.group("sq")
            if match.group("sq") is not None
            else None
        )
        if value is None and match.group("jsx") is not None:
            # `disabled={true}` / `value={x}` — we record presence only.
            value = True
        elif value is None and match.group("bare") is not None:
            value = match.group("bare")
        elif value is None:
            value = True  # bare attribute like `required`
        out[name] = value
    return out


def _parse_options(inner: str) -> list[dict[str, Any]]:
    """`<option>` children → `[{value, label, selected}]` list."""
    out: list[dict[str, Any]] = []
    for match in _OPTION_RE.finditer(inner):
        attrs = _parse_attrs(match.group("attrs"))
        label = " ".join(match.group("label").split())
        value = _stringify(attrs.get("value"))
        if value is None:
            value = label
        out.append({
            "value": value or "",
            "label": label,
            "selected": _bool_attr(attrs, "selected"),
        })
    return out


def _bool_attr(attrs: dict[str, Any], name: str) -> bool:
    """`required` (presence) or `required="true"` / `required={true}`."""
    v = attrs.get(name)
    if v is None:
        return False
    if isinstance(v, bool):
        return v
    return str(v).lower() not in ("false", "0", "")


def _int_attr(attrs: dict[str, Any], name: str) -> int | None:
    v = attrs.get(name)
    if v is None or isinstance(v, bool):
        return None
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _stringify(v: Any) -> str | None:
    if v is None or isinstance(v, bool):
        return None
    s = str(v).strip()
    return s or None
