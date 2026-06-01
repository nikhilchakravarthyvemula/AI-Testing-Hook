"""Spring Boot endpoint extractor — AST-driven (Layer 1 + Layer 2).

Tree-sitter walks every class_declaration; for each method with a
`@Get/Post/Put/Patch/Delete/Mapping` (or verbose `@RequestMapping`)
annotation, we collect:

  * Class-level `@RequestMapping` value (joined as base path).
  * Method annotation kwargs (path, method, produces, consumes).
  * Method parameters classified by `@PathVariable`, `@RequestParam`,
    `@RequestHeader`, `@RequestBody`.
  * `@PreAuthorize` / `@Secured` for auth + roles.
"""

from __future__ import annotations

import re
from pathlib import Path

from .....models import APIEndpoint, DiscoveryTier, EndpointParameter, method_is_idempotent
from ...framework_port import Extractor, ExtractionOutput
from .._shared.ast.java import (
    annotation_kwargs,
    annotation_name,
    class_annotations,
    iter_classes,
    iter_methods,
    method_annotations,
    method_name as java_method_name,
    parse,
)
from .._shared.backend.auth_resolver import spring_auth_from_annotations
from .._shared.backend_common import join_paths, normalise_path_params
from .._shared.backend.response_reader import spring_responses_from_method
from .._shared.backend.signature_reader import read_java_signature
from .._shared.provenance import provenance


_SPRING_IMPORT_RE = re.compile(r"\bimport\s+org\.springframework\.web\.")
_MAPPING_VERBS = {
    "GetMapping": "GET",
    "PostMapping": "POST",
    "PutMapping": "PUT",
    "PatchMapping": "PATCH",
    "DeleteMapping": "DELETE",
}
_REQUEST_METHOD_RE = re.compile(r"RequestMethod\.(?P<verb>[A-Z]+)")


class JavaSpringExtractor:
    """Spring Boot endpoint extraction. Tier=ast (tree-sitter)."""

    name: str = "java_spring"
    discovery_tier: DiscoveryTier = DiscoveryTier.AST
    file_globs: tuple[str, ...] = ("*.java",)

    def supports(self, file: Path, content: str) -> bool:
        return file.suffix == ".java" and bool(_SPRING_IMPORT_RE.search(content))

    def extract(self, file: Path, content: str) -> ExtractionOutput:
        root, source = parse(file, content)
        if root is None:
            return ExtractionOutput()

        endpoints: list[APIEndpoint] = []
        for cls in iter_classes(root):
            class_anns = [
                {"name": annotation_name(a, source),
                 "kwargs": annotation_kwargs(a, source)}
                for a in class_annotations(cls)
            ]
            base_path = _class_base_path(class_anns)
            for method_node in iter_methods(cls):
                method_anns = [
                    {"name": annotation_name(a, source),
                     "kwargs": annotation_kwargs(a, source)}
                    for a in method_annotations(method_node)
                ]
                for verb, method_path in _verbs_and_paths(method_anns):
                    endpoints.append(_build_endpoint(
                        file=file,
                        content=content,
                        method=verb,
                        base_path=base_path,
                        method_path=method_path,
                        method_node=method_node,
                        method_anns=method_anns,
                        class_anns=class_anns,
                        source=source,
                        extractor_name=self.name,
                    ))
        return ExtractionOutput(endpoints=endpoints)


# ── helpers ────────────────────────────────────────────────────────────────


def _class_base_path(class_anns: list[dict]) -> str:
    for ann in class_anns:
        if ann["name"] in ("RequestMapping", *_MAPPING_VERBS.keys()):
            value = ann["kwargs"].get("value") or ann["kwargs"].get("path")
            if isinstance(value, str):
                return value
            if isinstance(value, list) and value and isinstance(value[0], str):
                return value[0]
    return ""


def _verbs_and_paths(method_anns: list[dict]):
    """Yield `(verb, path)` for every routing annotation on the method."""
    for ann in method_anns:
        name = ann["name"]
        kwargs = ann["kwargs"]
        if name in _MAPPING_VERBS:
            verb = _MAPPING_VERBS[name]
            value = kwargs.get("value") or kwargs.get("path") or ""
            if isinstance(value, list):
                value = value[0] if value else ""
            yield verb, str(value)
        elif name == "RequestMapping":
            method_raw = kwargs.get("method")
            value = kwargs.get("value") or kwargs.get("path") or ""
            if isinstance(value, list):
                value = value[0] if value else ""
            if isinstance(method_raw, str):
                m = _REQUEST_METHOD_RE.search(method_raw)
                if m:
                    yield m.group("verb"), str(value)
            elif isinstance(method_raw, list):
                for mr in method_raw:
                    if isinstance(mr, str):
                        m = _REQUEST_METHOD_RE.search(mr)
                        if m:
                            yield m.group("verb"), str(value)


def _build_endpoint(
    *,
    file: Path,
    content: str,
    method: str,
    base_path: str,
    method_path: str,
    method_node,
    method_anns: list[dict],
    class_anns: list[dict],
    source: bytes,
    extractor_name: str,
) -> APIEndpoint:
    joined = normalise_path_params(join_paths(base_path, method_path))
    sig = read_java_signature(method_node, source)
    auth = spring_auth_from_annotations(method_anns, class_anns)
    return_type = _java_return_type(method_node, source)
    responses = spring_responses_from_method(method_anns, return_type)

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

    handler_name = java_method_name(method_node, source) or "handler"
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


def _java_return_type(method_node, source: bytes) -> str | None:
    for c in method_node.children:
        if c.type in (
            "type_identifier", "void_type", "generic_type",
            "integral_type", "scoped_type_identifier",
        ):
            return source[c.start_byte : c.end_byte].decode("utf-8", errors="replace")
    return None
