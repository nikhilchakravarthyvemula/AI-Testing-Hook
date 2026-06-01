"""Decorator / annotation kwargs reader.

For Python frameworks (FastAPI, Flask, Django): walks `ast` decorator
nodes via `_shared/ast/python.py`.

For Java (Spring, JAX-RS) and C# (ASP.NET): callers pass already-parsed
tree-sitter annotation nodes + source bytes; this module just maps
them to a consistent shape.

Output shape:
    {
      "path": "/users/{id}",         # extracted from positional or value=
      "status_code": 201,             # FastAPI / Spring response status
      "response_model": "UserOut",    # FastAPI response_model class name
      "tags": ["users"],
      "deprecated": False,
      "summary": "Create user",
      ...
    }

Unknown / non-literal kwargs are dropped; consumers see what the
extractor was able to determine.
"""

from __future__ import annotations

import ast as stdlib_ast
from typing import Any, Literal

from ..ast.python import decorator_call_kwargs

Framework = Literal["fastapi", "flask", "django", "spring", "jaxrs", "aspnet"]


def read_python_decorator_kwargs(
    decorator: stdlib_ast.expr, framework: Framework
) -> dict[str, Any]:
    """Python decorator → kwargs dict. Per-framework normalization
    handled below (e.g. FastAPI's `status_code` vs Flask's `methods`).
    """
    raw = decorator_call_kwargs(decorator)
    return _normalize_python(raw, framework)


def _normalize_python(raw: dict[str, Any], framework: Framework) -> dict[str, Any]:
    """Apply per-framework conventions:

      * FastAPI: response_model is a class name (kept as string),
        status_code is int.
      * Flask: methods is a list of method strings; path is positional.
      * Django: name= maps to operation_id.
    """
    out = dict(raw)
    if framework == "fastapi":
        # Sometimes the path arrives via `path=` kwarg instead of positional.
        if "path" not in out and "url_path" in out:
            out["path"] = out.pop("url_path")
    elif framework == "django":
        # Django path/re_path: `name="user-list"` → operation_id hint.
        if "name" in out:
            out.setdefault("operation_id", out["name"])
    return out


def read_java_annotation_kwargs(
    annotation_node: Any, source_bytes: bytes
) -> dict[str, Any]:
    """Java annotation → kwargs dict.

    Lazy import — tree-sitter is optional.
    """
    from ..ast.java import annotation_kwargs

    return annotation_kwargs(annotation_node, source_bytes)


def read_csharp_attribute_kwargs(
    attribute_node: Any, source_bytes: bytes
) -> dict[str, Any]:
    """C# attribute → kwargs dict."""
    from ..ast.csharp import attribute_kwargs

    return attribute_kwargs(attribute_node, source_bytes)
