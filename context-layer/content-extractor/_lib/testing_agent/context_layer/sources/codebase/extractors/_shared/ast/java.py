"""Java-specific AST helpers atop tree-sitter.

Knows how to walk Java's grammar:
  * `class_declaration` → class node
  * `annotation` / `marker_annotation` → `@Get` / `@RequestMapping(...)`
  * `method_declaration` → handler function
  * `formal_parameter` → typed parameter

Returns None / empty when tree-sitter isn't installed. Callers should
handle gracefully.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Iterator

from .tree_sitter_loader import (
    find_children_of_type,
    find_descendants_of_type,
    node_text,
    parse_cached,
)


def parse(path: Path, content: str) -> tuple[Any | None, bytes]:
    """Returns `(tree_root_node, source_bytes)` or `(None, source_bytes)`
    when tree-sitter Java isn't available.
    """
    tree = parse_cached("java", path, content)
    source_bytes = content.encode("utf-8")
    return (tree.root_node if tree else None), source_bytes


def iter_classes(root: Any) -> Iterator[Any]:
    """Yield every `class_declaration` node in the tree."""
    yield from find_descendants_of_type(root, "class_declaration")


def class_name(class_node: Any, source: bytes) -> str | None:
    for c in class_node.children:
        if c.type == "identifier":
            return node_text(c, source)
    return None


def class_annotations(class_node: Any) -> list[Any]:
    """Annotations directly attached to a class (modifiers)."""
    out: list[Any] = []
    for mod in find_children_of_type(class_node, "modifiers"):
        out.extend(
            a for a in mod.children
            if a.type in ("annotation", "marker_annotation")
        )
    return out


def iter_methods(class_node: Any) -> Iterator[Any]:
    """Yield method_declaration nodes inside a class."""
    body = next(
        (c for c in class_node.children if c.type == "class_body"),
        None,
    )
    if body is None:
        return
    yield from find_descendants_of_type(body, "method_declaration")


def method_annotations(method_node: Any) -> list[Any]:
    out: list[Any] = []
    for mod in find_children_of_type(method_node, "modifiers"):
        out.extend(
            a for a in mod.children
            if a.type in ("annotation", "marker_annotation")
        )
    return out


def method_name(method_node: Any, source: bytes) -> str | None:
    for c in method_node.children:
        if c.type == "identifier":
            return node_text(c, source)
    return None


def annotation_name(annotation_node: Any, source: bytes) -> str | None:
    """`@GetMapping("/x")` → `"GetMapping"`. `@GET` → `"GET"`."""
    for c in annotation_node.children:
        if c.type == "identifier":
            return node_text(c, source)
        if c.type == "scoped_identifier":  # e.g. annotations in nested namespace
            tail = c.children[-1] if c.children else None
            if tail is not None:
                return node_text(tail, source)
    return None


def annotation_kwargs(annotation_node: Any, source: bytes) -> dict[str, Any]:
    """Extract annotation arguments as a dict of literal values.

    `@RequestMapping(value = "/x", method = RequestMethod.GET)` →
    `{"value": "/x", "method": "RequestMethod.GET"}`. Single-positional
    `@Path("/x")` becomes `{"value": "/x"}` (positional → value).
    """
    out: dict[str, Any] = {}
    args = next(
        (c for c in annotation_node.children if c.type == "annotation_argument_list"),
        None,
    )
    if args is None:
        return out
    for child in args.children:
        if child.type == "element_value_pair":
            kw_name = node_text(child.children[0], source)
            value_node = next(
                (n for n in child.children if n.type not in ("identifier", "=")),
                None,
            )
            out[kw_name] = _literal_value(value_node, source) if value_node else None
        elif child.type in ("string_literal", "decimal_integer_literal",
                            "field_access", "identifier"):
            # Bare positional value — convention: bind to "value".
            out.setdefault("value", _literal_value(child, source))
    return out


def method_parameters(method_node: Any, source: bytes) -> list[dict[str, Any]]:
    """Return `[{name, type, annotations}, ...]` for each formal parameter."""
    params_node = next(
        (c for c in method_node.children if c.type == "formal_parameters"),
        None,
    )
    if params_node is None:
        return []
    out: list[dict[str, Any]] = []
    for p in find_children_of_type(params_node, "formal_parameter"):
        param_info: dict[str, Any] = {"annotations": []}
        for c in p.children:
            if c.type == "modifiers":
                for a in c.children:
                    if a.type in ("annotation", "marker_annotation"):
                        param_info["annotations"].append({
                            "name": annotation_name(a, source),
                            "kwargs": annotation_kwargs(a, source),
                        })
            elif c.type in ("type_identifier", "generic_type", "integral_type",
                            "floating_point_type", "boolean_type", "void_type",
                            "scoped_type_identifier"):
                param_info["type"] = node_text(c, source)
            elif c.type == "identifier":
                param_info["name"] = node_text(c, source)
        out.append(param_info)
    return out


# ── private ───────────────────────────────────────────────────────────────


def _literal_value(node: Any, source: bytes) -> Any:
    """Best-effort literal resolution for annotation argument values."""
    if node is None:
        return None
    if node.type == "string_literal":
        text = node_text(node, source)
        return text.strip('"\'')
    if node.type in ("decimal_integer_literal", "hex_integer_literal"):
        try:
            return int(node_text(node, source), 0)
        except (TypeError, ValueError):
            return node_text(node, source)
    if node.type in ("true", "false"):
        return node.type == "true"
    if node.type in ("field_access", "identifier", "scoped_identifier"):
        return node_text(node, source)
    if node.type == "element_value_array_initializer":
        return [_literal_value(c, source) for c in node.children
                if c.type not in ("{", "}", ",")]
    return node_text(node, source)
