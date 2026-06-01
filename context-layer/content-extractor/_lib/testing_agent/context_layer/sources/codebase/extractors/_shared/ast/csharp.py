"""C#-specific AST helpers atop tree-sitter.

Grammar landmarks:
  * `class_declaration` — controller class
  * `attribute_list` containing `attribute` nodes — `[Route("/api")]`,
    `[HttpGet]`, etc.
  * `method_declaration` — controller actions
  * `parameter` inside `parameter_list`
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Iterator

from .tree_sitter_loader import (
    find_descendants_of_type,
    node_text,
    parse_cached,
)


def parse(path: Path, content: str) -> tuple[Any | None, bytes]:
    tree = parse_cached("csharp", path, content)
    source_bytes = content.encode("utf-8")
    return (tree.root_node if tree else None), source_bytes


def iter_classes(root: Any) -> Iterator[Any]:
    yield from find_descendants_of_type(root, "class_declaration")


def class_name(class_node: Any, source: bytes) -> str | None:
    for c in class_node.children:
        if c.type == "identifier":
            return node_text(c, source)
    return None


def class_attributes(class_node: Any) -> list[Any]:
    """Return `[Attribute]` children (the `attribute_list` siblings)."""
    out: list[Any] = []
    for c in class_node.children:
        if c.type == "attribute_list":
            out.extend(a for a in c.children if a.type == "attribute")
    return out


def iter_methods(class_node: Any) -> Iterator[Any]:
    body = next(
        (c for c in class_node.children if c.type == "declaration_list"),
        None,
    )
    if body is None:
        return
    yield from find_descendants_of_type(body, "method_declaration")


def method_attributes(method_node: Any) -> list[Any]:
    out: list[Any] = []
    for c in method_node.children:
        if c.type == "attribute_list":
            out.extend(a for a in c.children if a.type == "attribute")
    return out


def method_name(method_node: Any, source: bytes) -> str | None:
    # Method name is the identifier right before the parameter list.
    for c in method_node.children:
        if c.type == "identifier":
            return node_text(c, source)
    return None


def attribute_name(attr_node: Any, source: bytes) -> str | None:
    for c in attr_node.children:
        if c.type == "identifier":
            return node_text(c, source)
    return None


def attribute_kwargs(attr_node: Any, source: bytes) -> dict[str, Any]:
    """`[Route("/api/[controller]")]` → `{"value": "/api/[controller]"}`.
    `[HttpGet("{id:int}")]` → `{"value": "{id:int}"}`.
    """
    out: dict[str, Any] = {}
    args = next(
        (c for c in attr_node.children if c.type == "attribute_argument_list"),
        None,
    )
    if args is None:
        return out
    for arg in args.children:
        if arg.type != "attribute_argument":
            continue
        # name_equals child (e.g. `Name = "list"`) vs positional
        name_eq = next(
            (c for c in arg.children if c.type == "name_equals"),
            None,
        )
        value_node = next(
            (c for c in arg.children
             if c.type not in ("name_equals", "name_colon", ",", "(", ")")),
            None,
        )
        if value_node is None:
            continue
        if name_eq is not None:
            kw_name_node = next(
                (c for c in name_eq.children if c.type == "identifier"),
                None,
            )
            kw_name = node_text(kw_name_node, source) if kw_name_node else "value"
            out[kw_name] = _literal_value(value_node, source)
        else:
            out.setdefault("value", _literal_value(value_node, source))
    return out


def method_parameters(method_node: Any, source: bytes) -> list[dict[str, Any]]:
    """`[FromBody] UserDto dto` → `{name: "dto", type: "UserDto",
    annotations: [{name: "FromBody", kwargs: {}}]}`.
    """
    params_node = next(
        (c for c in method_node.children if c.type == "parameter_list"),
        None,
    )
    if params_node is None:
        return []
    out: list[dict[str, Any]] = []
    for p in params_node.children:
        if p.type != "parameter":
            continue
        info: dict[str, Any] = {"annotations": []}
        for c in p.children:
            if c.type == "attribute_list":
                for a in c.children:
                    if a.type == "attribute":
                        info["annotations"].append({
                            "name": attribute_name(a, source),
                            "kwargs": attribute_kwargs(a, source),
                        })
            elif c.type in (
                "predefined_type", "identifier", "generic_name",
                "nullable_type", "qualified_name", "array_type",
            ) and "type" not in info:
                info["type"] = node_text(c, source)
            elif c.type == "identifier":
                info["name"] = node_text(c, source)
        out.append(info)
    return out


# ── private ───────────────────────────────────────────────────────────────


def _literal_value(node: Any, source: bytes) -> Any:
    if node.type == "string_literal":
        return node_text(node, source).strip('"\'')
    if node.type in ("integer_literal", "real_literal"):
        try:
            text = node_text(node, source)
            return int(text) if "." not in text else float(text)
        except (TypeError, ValueError):
            return node_text(node, source)
    if node.type in ("true", "false"):
        return node.type == "true"
    return node_text(node, source)
