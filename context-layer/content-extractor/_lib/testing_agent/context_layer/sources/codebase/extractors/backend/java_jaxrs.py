"""JAX-RS endpoint extractor — AST-driven (Layer 1 + Layer 2).

JAX-RS is more rigid than Spring: every endpoint method has exactly
one verb annotation (`@GET`/`@POST`/etc.) and an optional `@Path`.
Class-level `@Path` is the base. Auth via `@RolesAllowed` /
`@PermitAll` / `@DenyAll`.
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
from .._shared.backend.auth_resolver import jaxrs_auth_from_annotations
from .._shared.backend_common import join_paths, normalise_path_params
from .._shared.backend.signature_reader import read_java_signature
from .._shared.provenance import provenance


_JAXRS_IMPORT_RE = re.compile(r"\bimport\s+(?:javax|jakarta)\.ws\.rs\.")
_VERBS = {"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"}


class JavaJaxRsExtractor:
    """JAX-RS endpoint extraction. Tier=ast (tree-sitter)."""

    name: str = "java_jaxrs"
    discovery_tier: DiscoveryTier = DiscoveryTier.AST
    file_globs: tuple[str, ...] = ("*.java",)

    def supports(self, file: Path, content: str) -> bool:
        return file.suffix == ".java" and bool(_JAXRS_IMPORT_RE.search(content))

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
            base_path = _class_path(class_anns)
            for method_node in iter_methods(cls):
                method_anns = [
                    {"name": annotation_name(a, source),
                     "kwargs": annotation_kwargs(a, source)}
                    for a in method_annotations(method_node)
                ]
                verb = _find_verb(method_anns)
                if not verb:
                    continue
                method_path = _method_path(method_anns)
                endpoints.append(_build_endpoint(
                    file=file, content=content, method=verb,
                    base_path=base_path, method_path=method_path,
                    method_node=method_node, method_anns=method_anns,
                    class_anns=class_anns, source=source,
                    extractor_name=self.name,
                ))
        return ExtractionOutput(endpoints=endpoints)


# ── helpers ────────────────────────────────────────────────────────────────


def _class_path(class_anns: list[dict]) -> str:
    for ann in class_anns:
        if ann["name"] == "Path":
            value = ann["kwargs"].get("value")
            if isinstance(value, str):
                return value
    return ""


def _method_path(method_anns: list[dict]) -> str:
    for ann in method_anns:
        if ann["name"] == "Path":
            value = ann["kwargs"].get("value")
            if isinstance(value, str):
                return value
    return ""


def _find_verb(method_anns: list[dict]) -> str | None:
    for ann in method_anns:
        if ann["name"] in _VERBS:
            return ann["name"]
    return None


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
    auth = jaxrs_auth_from_annotations(method_anns, class_anns)

    parameters: list[EndpointParameter] = []
    for p in sig.params:
        if p.location == "body":
            continue
        parameters.append(EndpointParameter(
            name=p.name, location=p.location, type=p.type,
            is_required=p.required, default=p.default,
        ))

    schema_ref = sig.body.schema_ref if sig.body else None
    handler_name = java_method_name(method_node, source) or "handler"
    line_start = method_node.start_point[0] + 1
    line_end = method_node.end_point[0] + 1

    return APIEndpoint(
        method=method,
        path=joined,
        operation_id=handler_name,
        parameters=parameters,
        request_content_type="application/json" if sig.body else None,
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
