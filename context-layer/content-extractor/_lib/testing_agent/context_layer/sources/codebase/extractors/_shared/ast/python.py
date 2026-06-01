"""Python AST wrapper — uses stdlib `ast` (no tree-sitter for Python).

Stdlib `ast` is preferred for Python because it knows about scoping,
decorators as call expressions, and type annotations as first-class
nodes. Tree-sitter-python loses those distinctions.

Per-file caching: `parse_cached(path, content)` returns the same AST
across multiple calls within an extraction run.
"""

from __future__ import annotations

import ast as stdlib_ast
from pathlib import Path
from typing import Any, Iterator


# Module-level cache keyed by (path, content_hash) so different files
# at the same logical path (test fixtures, multiple in-memory parses)
# don't return stale trees. Reset by `clear_cache()` on a new run.
_AST_CACHE: dict[tuple[Path, int], stdlib_ast.Module] = {}


def parse_cached(path: Path, content: str) -> stdlib_ast.Module | None:
    """Parse + memoise. Returns None on syntax error (extractors absorb)."""
    key = (path, hash(content))
    if key in _AST_CACHE:
        return _AST_CACHE[key]
    try:
        tree = stdlib_ast.parse(content, filename=str(path))
    except SyntaxError:
        return None
    _AST_CACHE[key] = tree
    return tree


def clear_cache() -> None:
    """Reset between runs so different repos don't share cached trees."""
    _AST_CACHE.clear()


# ── decorator / call inspection ───────────────────────────────────────────


def decorator_call_attr(decorator: stdlib_ast.expr) -> tuple[str, str] | None:
    """For `@app.get("/x")` → returns `("app", "get")`. Returns None
    when the decorator isn't an attribute call.
    """
    if not isinstance(decorator, stdlib_ast.Call):
        return None
    func = decorator.func
    if not isinstance(func, stdlib_ast.Attribute):
        return None
    if not isinstance(func.value, stdlib_ast.Name):
        return None
    return (func.value.id, func.attr)


def decorator_call_kwargs(decorator: stdlib_ast.expr) -> dict[str, Any]:
    """Extract kwargs from a decorator call as a literal-resolved dict.

    Non-literal values (variables, function calls) are dropped — we
    only emit fields we can verify. The first positional arg is treated
    as `"path"` for FastAPI/Flask-style decorators.
    """
    if not isinstance(decorator, stdlib_ast.Call):
        return {}
    out: dict[str, Any] = {}
    for i, arg in enumerate(decorator.args):
        value = _literal_value(arg)
        if value is None:
            continue
        if i == 0:
            out["path"] = value
        else:
            out[f"_positional_{i}"] = value
    for kw in decorator.keywords:
        if kw.arg is None:
            continue
        value = _literal_value(kw.value)
        if value is not None:
            out[kw.arg] = value
    return out


def _literal_value(node: stdlib_ast.expr) -> Any:
    """Resolve a literal expression to its Python value. Returns None
    when the expression can't be reduced statically.
    """
    if isinstance(node, stdlib_ast.Constant):
        v = node.value
        # `...` (Ellipsis) is FastAPI's "required" marker, not a real value;
        # don't emit it as data. Bytes aren't JSON-safe — encode to str.
        if v is Ellipsis:
            return None
        if isinstance(v, bytes):
            return v.decode("utf-8", errors="replace")
        return v
    if isinstance(node, stdlib_ast.List):
        items = [_literal_value(e) for e in node.elts]
        return items if all(i is not None or e_is_none(e) for i, e in zip(items, node.elts)) else None
    if isinstance(node, stdlib_ast.Tuple):
        # JSON has no tuple — emit a list for serializability.
        return [_literal_value(e) for e in node.elts]
    if isinstance(node, stdlib_ast.Set):
        # JSON has no set — emit a list.
        return [_literal_value(e) for e in node.elts]
    if isinstance(node, stdlib_ast.Dict):
        out: dict[Any, Any] = {}
        for k, v in zip(node.keys, node.values):
            if k is None:
                continue
            key_val = _literal_value(k)
            val_val = _literal_value(v)
            if key_val is None:
                continue
            out[key_val] = val_val
        return out
    if isinstance(node, stdlib_ast.Attribute):
        # e.g. status.HTTP_201_CREATED → return the attribute path as string
        return _attribute_path(node)
    if isinstance(node, stdlib_ast.Name):
        return node.id
    return None


def e_is_none(node: stdlib_ast.expr) -> bool:
    return isinstance(node, stdlib_ast.Constant) and node.value is None


def _attribute_path(node: stdlib_ast.Attribute) -> str:
    parts: list[str] = []
    current: stdlib_ast.expr = node
    while isinstance(current, stdlib_ast.Attribute):
        parts.append(current.attr)
        current = current.value
    if isinstance(current, stdlib_ast.Name):
        parts.append(current.id)
    return ".".join(reversed(parts))


# ── function discovery ────────────────────────────────────────────────────


def function_decorators(
    tree: stdlib_ast.Module,
) -> Iterator[tuple[stdlib_ast.FunctionDef | stdlib_ast.AsyncFunctionDef, list[stdlib_ast.expr]]]:
    """Yield `(function_node, decorators)` pairs for every function/method
    in the module — top-level + class-bound.
    """
    for node in stdlib_ast.walk(tree):
        if isinstance(node, (stdlib_ast.FunctionDef, stdlib_ast.AsyncFunctionDef)):
            yield node, list(node.decorator_list)


def function_docstring(func: stdlib_ast.FunctionDef | stdlib_ast.AsyncFunctionDef) -> str | None:
    """First non-empty line of the function's docstring. None when no docstring."""
    doc = stdlib_ast.get_docstring(func)
    if not doc:
        return None
    for line in doc.splitlines():
        line = line.strip()
        if line:
            return line
    return None


# ── annotation / type-hint inspection ─────────────────────────────────────


_PRIMITIVE_TYPE_MAP = {
    "int": "integer",
    "float": "number",
    "bool": "boolean",
    "str": "string",
    "bytes": "string",
    "list": "array",
    "tuple": "array",
    "set": "array",
    "frozenset": "array",
    "dict": "object",
    "None": "null",
}


# Pydantic / stdlib types that map to "string" with a known JSON-Schema format.
# Drives `annotation_format()` so the body generator can pick the right sample.
_FORMAT_HINTS = {
    "EmailStr": "email",
    "HttpUrl": "uri",
    "AnyHttpUrl": "uri",
    "AnyUrl": "uri",
    "PostgresDsn": "uri",
    "UUID": "uuid",
    "UUID1": "uuid",
    "UUID3": "uuid",
    "UUID4": "uuid",
    "UUID5": "uuid",
    "date": "date",
    "datetime": "date-time",
    "time": "time",
    "IPv4Address": "ipv4",
    "IPv6Address": "ipv6",
    "SecretStr": "password",
}


def annotation_name(annotation: stdlib_ast.expr | None) -> str | None:
    """`int` → "integer"; `str` → "string"; `User` → "User";
    `list[Foo]` → "array"; `dict[str, X]` → "object"; unknown → None.

    Unwraps `Optional[X]`, `X | None`, and `Union[X, None]` to return X's
    mapped name. Pydantic format-typed strings (EmailStr, HttpUrl, UUID,
    SecretStr, date, datetime) map to "string" / "integer" — pair with
    `annotation_format()` for the JSON-Schema format hint.
    """
    if annotation is None:
        return None
    inner = _unwrap_optional(annotation)
    name = _bare_name(inner)
    if name is None:
        return None
    if name in _FORMAT_HINTS:
        # date/datetime/time stay string in JSON Schema.
        return "string"
    return _PRIMITIVE_TYPE_MAP.get(name, name)


def annotation_format(annotation: stdlib_ast.expr | None) -> str | None:
    """JSON-Schema-style format hint for the annotation, when one applies.

    `Optional[EmailStr]` → "email"; `UUID` → "uuid"; `int` → None.
    Returns None when no known format hint matches.
    """
    if annotation is None:
        return None
    name = _bare_name(_unwrap_optional(annotation))
    if name is None:
        return None
    return _FORMAT_HINTS.get(name)


def _unwrap_optional(node: stdlib_ast.expr) -> stdlib_ast.expr:
    """Strip `Optional[X]` / `Union[X, None]` / `X | None` down to X.

    Leaves multi-non-None unions alone (we can't pick one inner type
    confidently — the caller will see the outer name and treat it as
    a custom type).
    """
    # `Optional[X]` → X
    if isinstance(node, stdlib_ast.Subscript):
        base = _bare_name(node.value)
        if base == "Optional":
            return node.slice
        if base == "Union":
            inner = _union_non_none(node.slice)
            if inner is not None:
                return inner
    # `X | None` → X
    if isinstance(node, stdlib_ast.BinOp) and isinstance(node.op, stdlib_ast.BitOr):
        for primary, other in ((node.left, node.right), (node.right, node.left)):
            if _is_none_literal(other):
                return primary
    return node


def _union_non_none(slice_node: stdlib_ast.expr) -> stdlib_ast.expr | None:
    """For `Union[X, None]` return X; for `Union[X, Y]` return None (ambiguous)."""
    elts: list[stdlib_ast.expr] = []
    if isinstance(slice_node, stdlib_ast.Tuple):
        elts = list(slice_node.elts)
    else:
        elts = [slice_node]
    non_none = [e for e in elts if not _is_none_literal(e)]
    return non_none[0] if len(non_none) == 1 else None


def _is_none_literal(node: stdlib_ast.expr) -> bool:
    if isinstance(node, stdlib_ast.Constant) and node.value is None:
        return True
    if isinstance(node, stdlib_ast.Name) and node.id in ("None", "NoneType"):
        return True
    return False


def _bare_name(node: stdlib_ast.expr) -> str | None:
    """Strip subscripts: `list[int]` → "list". Returns None for complex types."""
    if isinstance(node, stdlib_ast.Name):
        return node.id
    if isinstance(node, stdlib_ast.Constant):
        if isinstance(node.value, str):
            return node.value  # forward-reference string
        if node.value is None:
            return "None"
    if isinstance(node, stdlib_ast.Subscript):
        return _bare_name(node.value)
    if isinstance(node, stdlib_ast.Attribute):
        return _attribute_path(node).rsplit(".", 1)[-1]
    return None
