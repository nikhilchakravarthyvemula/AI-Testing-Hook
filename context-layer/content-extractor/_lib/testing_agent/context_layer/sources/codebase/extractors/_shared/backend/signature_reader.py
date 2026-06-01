"""Handler signature reader — extracts typed parameters from function nodes.

Returns a `HandlerSignature` with classified params: query / path /
header / body / auth-dep. The classification rules differ by framework
but the output shape is uniform.

FastAPI specifics:
  * `Depends(...)` → auth dependency.
  * `Body(...)` / annotated with a Pydantic class → body param.
  * `Path(...)` / name appears in route path → path param.
  * Defaults to query if not classified.

Flask/Django: less info at signature level — most params come from
URL conf, not the function. We still emit the names.

Spring/JAX-RS: `@PathVariable`, `@RequestParam`, `@RequestHeader`,
`@RequestBody` annotations on parameters.

ASP.NET: `[FromBody]`, `[FromRoute]`, `[FromQuery]`, `[FromHeader]`.
"""

from __future__ import annotations

import ast as stdlib_ast
from dataclasses import dataclass, field
from typing import Any, Literal

from ..ast.python import _literal_value, annotation_name

ParamLocation = Literal["query", "path", "header", "body", "auth_dep"]


@dataclass
class HandlerParam:
    """One classified parameter from a handler signature."""

    name: str
    location: ParamLocation
    type: str | None = None
    required: bool = True
    default: Any | None = None
    schema_ref: str | None = None  # class name when type is a user-defined model


@dataclass
class HandlerSignature:
    """Classified parameters + handler-level metadata."""

    params: list[HandlerParam] = field(default_factory=list)
    body: HandlerParam | None = None
    return_type: str | None = None
    docstring: str | None = None


# ── Python (FastAPI / Flask / Django) ─────────────────────────────────────


# FastAPI-specific markers we recognise on parameter defaults.
_FASTAPI_BODY_MARKERS = {"Body", "Form", "File"}
_FASTAPI_PATH_MARKER = "Path"
_FASTAPI_QUERY_MARKER = "Query"
_FASTAPI_HEADER_MARKER = "Header"
_FASTAPI_COOKIE_MARKER = "Cookie"
_FASTAPI_DEPENDS_MARKER = "Depends"

# Primitive annotation names that mean "query unless explicitly tagged."
_PRIMITIVES = {"integer", "number", "string", "boolean", "array", "object", "null"}


def read_python_signature(
    func: stdlib_ast.FunctionDef | stdlib_ast.AsyncFunctionDef,
    *,
    framework: Literal["fastapi", "flask", "django"],
    path_param_names: set[str] | None = None,
) -> HandlerSignature:
    """Classify a Python function's parameters.

    `path_param_names` should be derived from the route path — names
    that match are classified as `path` params even without explicit
    `Path(...)` marker.
    """
    sig = HandlerSignature(docstring=_first_docstring_line(func))
    path_param_names = path_param_names or set()

    args = func.args
    all_args = list(args.args) + list(args.kwonlyargs)
    defaults_offset = len(args.args) - len(args.defaults)
    defaults = ([None] * defaults_offset) + list(args.defaults) + list(args.kw_defaults or [])

    for i, arg in enumerate(all_args):
        if arg.arg in ("self", "cls"):
            continue
        default = defaults[i] if i < len(defaults) else None
        param = _classify_python_param(
            arg, default, framework=framework, path_param_names=path_param_names
        )
        if param.location == "body":
            sig.body = param
        sig.params.append(param)

    sig.return_type = annotation_name(func.returns)
    return sig


def _classify_python_param(
    arg: stdlib_ast.arg,
    default: stdlib_ast.expr | None,
    *,
    framework: str,
    path_param_names: set[str],
) -> HandlerParam:
    name = arg.arg
    type_name = annotation_name(arg.annotation)

    # FastAPI: inspect the default value for `Path(...)`, `Body(...)` etc.
    if framework == "fastapi":
        marker = _fastapi_marker(default)
        if marker == _FASTAPI_DEPENDS_MARKER:
            return HandlerParam(name=name, location="auth_dep", type=type_name)
        if marker in _FASTAPI_BODY_MARKERS:
            return HandlerParam(
                name=name, location="body", type=type_name,
                required=_is_required(default),
                default=_default_value(default),
                schema_ref=_class_name_if_user_type(type_name),
            )
        if marker == _FASTAPI_PATH_MARKER:
            return HandlerParam(name=name, location="path", type=type_name, required=True)
        if marker == _FASTAPI_QUERY_MARKER:
            return HandlerParam(
                name=name, location="query", type=type_name,
                required=_is_required(default),
                default=_default_value(default),
            )
        if marker in (_FASTAPI_HEADER_MARKER, _FASTAPI_COOKIE_MARKER):
            return HandlerParam(
                name=name,
                location="header" if marker == _FASTAPI_HEADER_MARKER else "query",
                type=type_name,
                required=_is_required(default),
            )

        # No marker → classify by type + name.
        if name in path_param_names:
            return HandlerParam(name=name, location="path", type=type_name, required=True)
        if type_name and type_name not in _PRIMITIVES:
            # User-defined Pydantic class → body
            return HandlerParam(
                name=name, location="body", type=type_name,
                required=default is None,
                schema_ref=type_name,
            )
        return HandlerParam(
            name=name, location="query", type=type_name,
            required=default is None,
            default=_default_value(default),
        )

    # Flask / Django: parameters are mostly path params from URL conf.
    if name in path_param_names:
        return HandlerParam(name=name, location="path", type=type_name, required=True)
    return HandlerParam(name=name, location="query", type=type_name, required=False)


def _fastapi_marker(default: stdlib_ast.expr | None) -> str | None:
    """Returns "Body", "Path", "Query", ... or None."""
    if default is None or not isinstance(default, stdlib_ast.Call):
        return None
    func = default.func
    if isinstance(func, stdlib_ast.Name):
        return func.id
    if isinstance(func, stdlib_ast.Attribute):
        return func.attr
    return None


def _is_required(default: stdlib_ast.expr | None) -> bool:
    """A FastAPI `Body(...)` / `Query(...)` is required when the first
    positional arg is `...` (Ellipsis).
    """
    if default is None or not isinstance(default, stdlib_ast.Call):
        return True
    args = default.args
    if not args:
        return False
    first = args[0]
    return isinstance(first, stdlib_ast.Constant) and first.value is Ellipsis


def _default_value(default: stdlib_ast.expr | None) -> Any:
    """Resolve a function-arg default to a literal value, or None when
    unknown.

    Handles two shapes:
      * Bare literal: `page: int = 1` → 1, `q: str | None = None` → None.
      * FastAPI marker call: `status: str = Query("active")` →
        "active" (the marker's first positional arg).
    """
    if default is None:
        return None
    if isinstance(default, stdlib_ast.Call):
        args = default.args
        if not args:
            return None
        return _literal_value(args[0])
    return _literal_value(default)


def _class_name_if_user_type(type_name: str | None) -> str | None:
    if type_name is None or type_name in _PRIMITIVES:
        return None
    return type_name


def _first_docstring_line(
    func: stdlib_ast.FunctionDef | stdlib_ast.AsyncFunctionDef,
) -> str | None:
    doc = stdlib_ast.get_docstring(func)
    if not doc:
        return None
    for line in doc.splitlines():
        line = line.strip()
        if line:
            return line
    return None


# ── Java (Spring / JAX-RS) ────────────────────────────────────────────────


def read_java_signature(
    method_node: Any, source_bytes: bytes
) -> HandlerSignature:
    """Java handler signature via tree-sitter."""
    from ..ast.java import method_parameters

    sig = HandlerSignature()
    raw_params = method_parameters(method_node, source_bytes)
    for raw in raw_params:
        name = raw.get("name") or ""
        type_name = raw.get("type")
        annotations = raw.get("annotations") or []

        # Look for annotations that classify the parameter.
        location: ParamLocation = "query"
        schema_ref: str | None = None
        required = True
        default: Any | None = None
        for ann in annotations:
            ann_name = (ann.get("name") or "")
            kwargs = ann.get("kwargs") or {}
            if ann_name == "PathVariable":
                location = "path"
            elif ann_name == "RequestParam":
                location = "query"
                if "required" in kwargs:
                    required = bool(kwargs["required"])
                if "defaultValue" in kwargs:
                    default = kwargs["defaultValue"]
            elif ann_name == "RequestHeader":
                location = "header"
            elif ann_name == "RequestBody":
                location = "body"
                schema_ref = type_name
            elif ann_name in ("FormParam", "QueryParam"):
                location = "query"
            elif ann_name == "PathParam":
                location = "path"
            elif ann_name == "HeaderParam":
                location = "header"

        if location == "body" and schema_ref is None:
            schema_ref = type_name

        param = HandlerParam(
            name=name, location=location, type=type_name,
            required=required, default=default, schema_ref=schema_ref,
        )
        sig.params.append(param)
        if location == "body":
            sig.body = param
    return sig


# ── C# (ASP.NET) ──────────────────────────────────────────────────────────


def read_csharp_signature(
    method_node: Any, source_bytes: bytes
) -> HandlerSignature:
    from ..ast.csharp import method_parameters

    sig = HandlerSignature()
    for raw in method_parameters(method_node, source_bytes):
        name = raw.get("name") or ""
        type_name = raw.get("type")
        annotations = raw.get("annotations") or []

        location: ParamLocation = "query"
        schema_ref: str | None = None
        for ann in annotations:
            ann_name = ann.get("name") or ""
            if ann_name == "FromBody":
                location = "body"
                schema_ref = type_name
            elif ann_name == "FromRoute":
                location = "path"
            elif ann_name == "FromQuery":
                location = "query"
            elif ann_name == "FromHeader":
                location = "header"
            elif ann_name == "FromForm":
                location = "body"
                schema_ref = type_name

        if location == "query" and type_name and type_name not in (
            "string", "int", "long", "bool", "double", "decimal", "float",
            "Guid", "DateTime", "DateOnly", "TimeOnly",
        ) and not type_name.endswith("?"):
            # User-defined type with no [From*] → ASP.NET defaults to body for
            # complex types in [ApiController]-decorated classes.
            location = "body"
            schema_ref = type_name

        param = HandlerParam(
            name=name, location=location, type=type_name,
            schema_ref=schema_ref,
        )
        sig.params.append(param)
        if location == "body":
            sig.body = param
    return sig
