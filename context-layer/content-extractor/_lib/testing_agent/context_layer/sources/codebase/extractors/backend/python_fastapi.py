"""FastAPI endpoint extractor — AST-driven (Layer 1 + Layer 2).

Walks the file's stdlib AST, finds `@<obj>.<verb>(...)` decorators
on functions, and emits one `APIEndpoint` per (decorator, function)
pair with rich data:

  * Decorator kwargs: `status_code`, `response_model`, `tags`,
    `summary`, `deprecated`, `description`.
  * Handler signature: path/query/header/body params classified by
    FastAPI marker (`Path(...)`, `Body(...)`, `Depends(...)`).
  * Pydantic class name in `schema_ref` for the request body —
    Layer 3's schema_resolver expands it to fields.
  * First docstring line as `description`.

Limitations (deferred to resolution passes):
  * APIRouter `prefix=` not joined here — prefix_resolver does it.
  * `response_model` stays as `schema_ref`; schema_resolver expands.
  * Custom dependency auth classified heuristically by name.
"""

from __future__ import annotations

import ast as stdlib_ast
import re
from pathlib import Path

from .....models import APIEndpoint, DiscoveryTier, EndpointParameter, method_is_idempotent
from ...framework_port import Extractor, ExtractionOutput
from .._shared.ast.python import (
    decorator_call_attr,
    function_decorators,
    parse_cached,
)
from .._shared.backend.auth_resolver import fastapi_auth_from_signature
from .._shared.backend.decorator_reader import read_python_decorator_kwargs
from .._shared.backend.response_reader import fastapi_responses_from_kwargs
from .._shared.backend.signature_reader import read_python_signature
from .._shared.backend_common import normalise_path_params
from .._shared.provenance import provenance


_FASTAPI_IMPORT_RE = re.compile(r"\bfrom\s+fastapi\b|\bimport\s+fastapi\b")
_HTTP_VERBS = {"get", "post", "put", "patch", "delete", "options", "head"}
_PATH_PARAM_RE = re.compile(r"\{([A-Za-z_][A-Za-z0-9_]*)\}")


class PythonFastAPIExtractor:
    """FastAPI extractor — Tier=ast (real Python AST via stdlib)."""

    name: str = "python_fastapi"
    discovery_tier: DiscoveryTier = DiscoveryTier.AST
    file_globs: tuple[str, ...] = ("*.py",)

    def supports(self, file: Path, content: str) -> bool:
        if file.suffix != ".py":
            return False
        return bool(_FASTAPI_IMPORT_RE.search(content))

    def extract(self, file: Path, content: str) -> ExtractionOutput:
        tree = parse_cached(file, content)
        if tree is None:
            return ExtractionOutput()

        endpoints: list[APIEndpoint] = []
        for func, decorators in function_decorators(tree):
            for decorator in decorators:
                attr = decorator_call_attr(decorator)
                if attr is None:
                    continue
                _obj, method_name = attr
                if method_name not in _HTTP_VERBS:
                    continue

                kwargs = read_python_decorator_kwargs(decorator, framework="fastapi")
                if "path" not in kwargs:
                    continue

                endpoints.append(_build_endpoint(
                    file=file,
                    content=content,
                    func=func,
                    decorator=decorator,
                    method=method_name.upper(),
                    decorator_kwargs=kwargs,
                    extractor_name=self.name,
                ))

        return ExtractionOutput(endpoints=endpoints)


# ── helpers ────────────────────────────────────────────────────────────────


def _build_endpoint(
    *,
    file: Path,
    content: str,
    func: stdlib_ast.FunctionDef | stdlib_ast.AsyncFunctionDef,
    decorator: stdlib_ast.expr,
    method: str,
    decorator_kwargs: dict,
    extractor_name: str,
) -> APIEndpoint:
    path = normalise_path_params(decorator_kwargs["path"])
    path_params = set(_PATH_PARAM_RE.findall(path))

    sig = read_python_signature(func, framework="fastapi", path_param_names=path_params)
    auth = fastapi_auth_from_signature(sig.params)
    responses = fastapi_responses_from_kwargs(decorator_kwargs)

    parameters: list[EndpointParameter] = []
    for p in sig.params:
        if p.location in ("auth_dep", "body"):
            continue
        parameters.append(EndpointParameter(
            name=p.name,
            location=p.location,
            type=p.type,
            is_required=p.required,
            default=p.default,
        ))

    primary_response = responses[0] if responses else None
    schema_ref = sig.body.schema_ref if sig.body else None
    response_schemas: dict[str, dict] = {}
    if primary_response and primary_response.get("schema_ref"):
        response_schemas[str(primary_response["status_code"])] = {
            "$ref": f"#/components/schemas/{primary_response['schema_ref']}",
        }

    tags_raw = decorator_kwargs.get("tags") or []
    tags: list[str] = [t for t in tags_raw if isinstance(t, str)] if isinstance(tags_raw, list) else []

    return APIEndpoint(
        method=method,
        path=path,
        operation_id=func.name,
        summary=decorator_kwargs.get("summary"),
        description=sig.docstring or decorator_kwargs.get("description"),
        tags=tags,
        parameters=parameters,
        request_content_type="application/json" if sig.body else None,
        response_schemas=response_schemas or None,
        schema_ref=schema_ref,
        auth_required=auth["auth_required"],
        required_roles=auth["required_roles"],
        security_scheme=auth["security_scheme"],
        is_deprecated=bool(decorator_kwargs.get("deprecated", False)),
        idempotent_hint=method_is_idempotent(method),
        provenance=provenance(
            source_file=file,
            content=content,
            discovery_tier=DiscoveryTier.AST,
            extracted_by=extractor_name,
            source_line_start=getattr(decorator, "lineno", None) or func.lineno,
            source_line_end=getattr(func, "end_lineno", None),
        ),
    )
