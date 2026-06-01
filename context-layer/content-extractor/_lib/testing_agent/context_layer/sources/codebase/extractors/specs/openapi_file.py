"""OpenAPI / Swagger file extractor — enriched.

Pulls every field the spec actually carries: parameters (path/query/
header/cookie), tags, deprecated, summary, description, request/response
content types, security scheme. Per the doc's mandate: the layer
produces what it can determine and leaves the rest empty — no guessing.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import yaml

from ......platform.logging import get_logger
from .....models import (
    APIEndpoint,
    DiscoveryTier,
    EndpointParameter,
    method_is_idempotent,
)
from ...framework_port import Extractor, ExtractionOutput
from .._shared.provenance import provenance

log = get_logger(__name__)


_HTTP_METHODS = ("get", "post", "put", "patch", "delete", "options", "head")


class OpenAPIFileExtractor:
    """Parses OpenAPI 3.x / Swagger 2 documents. Tier=spec."""

    name: str = "openapi_file"
    discovery_tier: DiscoveryTier = DiscoveryTier.SPEC
    file_globs: tuple[str, ...] = ("*.yaml", "*.yml", "*.json")

    def supports(self, file: Path, content: str) -> bool:
        head = content[:2048].lower()
        return any(
            token in head
            for token in ("openapi:", '"openapi"', "swagger:", '"swagger"')
        )

    def extract(self, file: Path, content: str) -> ExtractionOutput:
        try:
            doc = _parse_text(file.suffix.lower(), content)
        except (yaml.YAMLError, json.JSONDecodeError) as exc:
            log.debug("openapi_file: %s parse error: %s", file, exc)
            return ExtractionOutput()

        prov = provenance(
            source_file=file,
            content=content,
            discovery_tier=self.discovery_tier,
            extracted_by=self.name,
        )
        endpoints = _parse_openapi_dict(doc, prov)
        log.info("openapi_file: %s → %d endpoints", file, len(endpoints))
        return ExtractionOutput(endpoints=endpoints)


# ── parsing ────────────────────────────────────────────────────────────────


def _parse_text(suffix: str, content: str) -> Any:
    if suffix in (".yaml", ".yml"):
        return yaml.safe_load(content)
    return json.loads(content)


def _parse_openapi_dict(doc: Any, prov) -> list[APIEndpoint]:
    if not isinstance(doc, dict):
        return []
    paths = doc.get("paths")
    if not isinstance(paths, dict):
        return []

    # Path-level parameters apply to all methods on that path.
    endpoints: list[APIEndpoint] = []
    for path, methods in paths.items():
        if not isinstance(methods, dict):
            continue
        path_level_params = _extract_parameters(methods.get("parameters") or [])
        for method, op in methods.items():
            if method.lower() not in _HTTP_METHODS:
                continue
            if not isinstance(op, dict):
                continue
            endpoints.append(_build_endpoint(method, path, op, path_level_params, prov))
    return endpoints


def _build_endpoint(
    method: str,
    path: str,
    op: dict[str, Any],
    path_level_params: list[EndpointParameter],
    prov,
) -> APIEndpoint:
    method_upper = method.upper()
    op_params = _extract_parameters(op.get("parameters") or [])
    # Path-level + method-level params, deduping by (name, location).
    merged_params = _merge_params(path_level_params, op_params)

    request_schema, request_content_type = _extract_request(op)
    response_schemas, response_content_types = _extract_responses(op)
    auth_required, security_scheme = _extract_security(op)

    return APIEndpoint(
        method=method_upper,
        path=path,
        operation_id=op.get("operationId"),
        summary=_str_or_none(op.get("summary")),
        description=_str_or_none(op.get("description")),
        tags=[str(t) for t in (op.get("tags") or []) if isinstance(t, str)],
        parameters=merged_params,
        request_schema=request_schema,
        request_content_type=request_content_type,
        response_schemas=response_schemas or None,
        response_content_types=response_content_types,
        auth_required=auth_required,
        security_scheme=security_scheme,
        is_deprecated=bool(op.get("deprecated", False)),
        idempotent_hint=method_is_idempotent(method_upper),
        provenance=prov,
    )


# ── parameter helpers ──────────────────────────────────────────────────────


def _extract_parameters(raw: list) -> list[EndpointParameter]:
    out: list[EndpointParameter] = []
    if not isinstance(raw, list):
        return out
    for p in raw:
        if not isinstance(p, dict):
            continue
        name = p.get("name")
        location = p.get("in")
        if not name or location not in ("query", "path", "header", "cookie"):
            continue
        schema = p.get("schema") if isinstance(p.get("schema"), dict) else {}
        examples = _collect_parameter_examples(p)
        out.append(
            EndpointParameter(
                name=name,
                location=location,
                type=_str_or_none(schema.get("type")),
                is_required=bool(p.get("required", False)),
                default=schema.get("default"),
                description=_str_or_none(p.get("description")),
                examples=examples,
                validation=_pick_validation_keys(schema),
            )
        )
    return out


def _collect_parameter_examples(p: dict[str, Any]) -> list[Any]:
    """OpenAPI 3.x: parameters can carry `example` (singular) or `examples`
    (map keyed by name). Collect both into a flat list.
    """
    out: list[Any] = []
    if "example" in p:
        out.append(p["example"])
    examples = p.get("examples")
    if isinstance(examples, dict):
        for entry in examples.values():
            if isinstance(entry, dict) and "value" in entry:
                out.append(entry["value"])
            else:
                out.append(entry)
    return out


def _merge_params(
    path_level: list[EndpointParameter], op_level: list[EndpointParameter]
) -> list[EndpointParameter]:
    """Method-level wins over path-level for the same (name, location)."""
    seen: dict[tuple[str, str], EndpointParameter] = {}
    for p in path_level:
        seen[(p.name, p.location)] = p
    for p in op_level:
        seen[(p.name, p.location)] = p
    return list(seen.values())


_VALIDATION_KEYS = (
    "pattern", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
    "minLength", "maxLength", "enum", "format", "multipleOf",
)


def _pick_validation_keys(schema: dict[str, Any]) -> dict[str, Any]:
    return {k: schema[k] for k in _VALIDATION_KEYS if k in schema}


# ── request / response helpers ─────────────────────────────────────────────


def _extract_request(op: dict[str, Any]) -> tuple[dict[str, Any] | None, str | None]:
    body = op.get("requestBody")
    if not isinstance(body, dict):
        return None, None
    content = body.get("content")
    if not isinstance(content, dict):
        return None, None
    # Prefer JSON; fall back to first content type.
    content_type = "application/json" if "application/json" in content else next(iter(content), None)
    if content_type is None:
        return None, None
    media = content.get(content_type)
    if not isinstance(media, dict):
        return None, content_type
    schema = media.get("schema")
    return (schema if isinstance(schema, dict) else None), content_type


def _extract_responses(
    op: dict[str, Any]
) -> tuple[dict[str, dict[str, Any]], dict[str, str]]:
    responses = op.get("responses")
    schemas: dict[str, dict[str, Any]] = {}
    content_types: dict[str, str] = {}
    if not isinstance(responses, dict):
        return schemas, content_types

    for status, spec in responses.items():
        if not isinstance(spec, dict):
            continue
        content = spec.get("content")
        if not isinstance(content, dict):
            continue
        content_type = (
            "application/json" if "application/json" in content
            else next(iter(content), None)
        )
        if content_type is None:
            continue
        media = content.get(content_type)
        if not isinstance(media, dict):
            continue
        schema = media.get("schema")
        if isinstance(schema, dict):
            schemas[str(status)] = schema
        content_types[str(status)] = content_type
    return schemas, content_types


# ── security helpers ───────────────────────────────────────────────────────


def _extract_security(op: dict[str, Any]) -> tuple[bool, str | None]:
    security = op.get("security")
    if not security or not isinstance(security, list):
        return False, None
    # `security` is a list of dicts; each dict has scheme names as keys.
    for entry in security:
        if not isinstance(entry, dict):
            continue
        for scheme_name in entry:
            return True, scheme_name
    return True, None  # auth_required=True but couldn't name the scheme


def _str_or_none(v: Any) -> str | None:
    if not isinstance(v, str):
        return None
    s = v.strip()
    return s or None
