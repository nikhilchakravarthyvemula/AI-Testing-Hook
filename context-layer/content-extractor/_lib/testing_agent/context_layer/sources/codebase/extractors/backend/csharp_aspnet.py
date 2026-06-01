"""ASP.NET Core endpoint extractor — AST-driven (Layer 1 + Layer 2).

Tree-sitter walks every class_declaration; for each method with an
`[Http*]` attribute, we collect:

  * Class-level `[Route(...)]` (with `[controller]` token expansion).
  * Method `[HttpGet("subpath")]` etc.
  * Parameters classified by `[From*]` attributes.
  * `[Authorize]` / `[AllowAnonymous]` for auth.
"""

from __future__ import annotations

import re
from pathlib import Path

from .....models import APIEndpoint, DiscoveryTier, EndpointParameter, method_is_idempotent
from ...framework_port import Extractor, ExtractionOutput
from .._shared.ast.csharp import (
    attribute_kwargs,
    attribute_name,
    class_attributes,
    class_name as cs_class_name,
    iter_classes,
    iter_methods,
    method_attributes,
    method_name as cs_method_name,
    parse,
)
from .._shared.backend.auth_resolver import aspnet_auth_from_attributes
from .._shared.backend_common import join_paths, normalise_path_params
from .._shared.backend.response_reader import csharp_responses_from_method
from .._shared.backend.signature_reader import read_csharp_signature
from .._shared.provenance import provenance


_ASPNET_USING_RE = re.compile(r"\busing\s+Microsoft\.AspNetCore\b")
_HTTP_ATTRS = {
    "HttpGet": "GET",
    "HttpPost": "POST",
    "HttpPut": "PUT",
    "HttpPatch": "PATCH",
    "HttpDelete": "DELETE",
    "HttpHead": "HEAD",
    "HttpOptions": "OPTIONS",
}


class CSharpAspNetExtractor:
    """ASP.NET Core endpoint extraction. Tier=ast (tree-sitter)."""

    name: str = "csharp_aspnet"
    discovery_tier: DiscoveryTier = DiscoveryTier.AST
    file_globs: tuple[str, ...] = ("*.cs",)

    def supports(self, file: Path, content: str) -> bool:
        return file.suffix == ".cs" and bool(_ASPNET_USING_RE.search(content))

    def extract(self, file: Path, content: str) -> ExtractionOutput:
        root, source = parse(file, content)
        if root is None:
            return ExtractionOutput()

        endpoints: list[APIEndpoint] = []
        for cls in iter_classes(root):
            class_attrs = [
                {"name": attribute_name(a, source),
                 "kwargs": attribute_kwargs(a, source)}
                for a in class_attributes(cls)
            ]
            controller_name = cs_class_name(cls, source) or ""
            base_path = _class_base_path(class_attrs, controller_name)
            for method_node in iter_methods(cls):
                method_attrs = [
                    {"name": attribute_name(a, source),
                     "kwargs": attribute_kwargs(a, source)}
                    for a in method_attributes(method_node)
                ]
                for verb, sub_path in _verbs_and_paths(method_attrs):
                    endpoints.append(_build_endpoint(
                        file=file, content=content, method=verb,
                        base_path=base_path, sub_path=sub_path,
                        method_node=method_node, method_attrs=method_attrs,
                        class_attrs=class_attrs, source=source,
                        extractor_name=self.name,
                    ))
        return ExtractionOutput(endpoints=endpoints)


# ── helpers ────────────────────────────────────────────────────────────────


def _class_base_path(class_attrs: list[dict], controller_name: str) -> str:
    """Find class-level `[Route(...)]` and expand `[controller]` token."""
    for attr in class_attrs:
        if attr["name"] != "Route":
            continue
        value = attr["kwargs"].get("value")
        if not isinstance(value, str):
            continue
        if controller_name.endswith("Controller"):
            token = controller_name[: -len("Controller")].lower()
        else:
            token = controller_name.lower()
        return value.replace("[controller]", token)
    return ""


def _verbs_and_paths(method_attrs: list[dict]):
    for attr in method_attrs:
        name = attr["name"]
        if name not in _HTTP_ATTRS:
            continue
        verb = _HTTP_ATTRS[name]
        sub = attr["kwargs"].get("value") or ""
        yield verb, str(sub)


def _build_endpoint(
    *,
    file: Path,
    content: str,
    method: str,
    base_path: str,
    sub_path: str,
    method_node,
    method_attrs: list[dict],
    class_attrs: list[dict],
    source: bytes,
    extractor_name: str,
) -> APIEndpoint:
    joined = normalise_path_params(join_paths(base_path, sub_path))
    sig = read_csharp_signature(method_node, source)
    auth = aspnet_auth_from_attributes(method_attrs, class_attrs)
    return_type = _cs_return_type(method_node, source)
    responses = csharp_responses_from_method(method_attrs, return_type)

    parameters: list[EndpointParameter] = []
    for p in sig.params:
        if p.location == "body":
            continue
        parameters.append(EndpointParameter(
            name=p.name, location=p.location, type=p.type,
            is_required=p.required, default=p.default,
        ))

    schema_ref = sig.body.schema_ref if sig.body else None
    response_schemas: dict[str, dict] = {}
    primary = responses[0] if responses else None
    if primary and primary.get("schema_ref"):
        response_schemas[str(primary["status_code"])] = {
            "$ref": f"#/components/schemas/{primary['schema_ref']}",
        }

    handler_name = cs_method_name(method_node, source) or "handler"
    line_start = method_node.start_point[0] + 1
    line_end = method_node.end_point[0] + 1

    return APIEndpoint(
        method=method,
        path=joined,
        operation_id=handler_name,
        parameters=parameters,
        request_content_type="application/json" if sig.body else None,
        response_schemas=response_schemas or None,
        schema_ref=schema_ref,
        auth_required=auth["auth_required"],
        required_roles=auth["required_roles"],
        security_scheme=auth["security_scheme"],
        idempotent_hint=method_is_idempotent(method),
        provenance=provenance(
            source_file=file,
            content=content,
            discovery_tier=DiscoveryTier.AST,
            extracted_by=extractor_name,
            source_line_start=line_start,
            source_line_end=line_end,
        ),
    )


def _cs_return_type(method_node, source: bytes) -> str | None:
    for c in method_node.children:
        if c.type in (
            "predefined_type", "identifier", "generic_name",
            "nullable_type", "qualified_name",
        ):
            text = source[c.start_byte : c.end_byte].decode("utf-8", errors="replace")
            # Skip access modifiers and `async`.
            if text in ("public", "private", "protected", "internal", "static",
                        "async", "virtual", "override", "sealed", "abstract"):
                continue
            return text
    return None
