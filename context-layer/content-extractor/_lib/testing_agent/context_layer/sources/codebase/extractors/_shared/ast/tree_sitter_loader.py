"""Lazy tree-sitter parser loader.

`get_parser(lang)` returns a memoised `tree_sitter.Parser` for a
language string. The grammar import is lazy + try/except so a missing
language dep doesn't break the rest of extraction.

Languages currently wired: `java`, `csharp`. Add a `case` block per
new language; keep imports inside the case so the cost is only paid
when that language is actually used.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Literal

LanguageName = Literal["java", "csharp"]


_PARSER_CACHE: dict[LanguageName, Any] = {}


class TreeSitterUnavailable(Exception):
    """Raised when a requested language's grammar can't be loaded."""


def get_parser(lang: LanguageName) -> Any:
    """Memoised `tree_sitter.Parser` for `lang`. Raises `TreeSitterUnavailable`
    when the grammar package isn't installed.
    """
    if lang in _PARSER_CACHE:
        return _PARSER_CACHE[lang]

    try:
        import tree_sitter
    except ImportError as exc:
        raise TreeSitterUnavailable(
            "tree-sitter package not installed; "
            "run `pip install tree-sitter tree-sitter-java tree-sitter-c-sharp`"
        ) from exc

    grammar: Any
    if lang == "java":
        try:
            import tree_sitter_java  # type: ignore[import-not-found]
        except ImportError as exc:
            raise TreeSitterUnavailable("tree-sitter-java not installed") from exc
        grammar = tree_sitter_java.language()
    elif lang == "csharp":
        try:
            import tree_sitter_c_sharp  # type: ignore[import-not-found]
        except ImportError as exc:
            raise TreeSitterUnavailable("tree-sitter-c-sharp not installed") from exc
        grammar = tree_sitter_c_sharp.language()
    else:
        raise TreeSitterUnavailable(f"unsupported tree-sitter language: {lang}")

    parser = tree_sitter.Parser(tree_sitter.Language(grammar))
    _PARSER_CACHE[lang] = parser
    return parser


# Per-file parse cache, keyed by (lang, path, content_hash). Hashing
# content avoids stale trees when test fixtures share the same path.
_TREE_CACHE: dict[tuple[LanguageName, Path, int], Any] = {}


def parse_cached(lang: LanguageName, path: Path, content: str) -> Any | None:
    """Parse + memoise. Returns None when the language isn't available."""
    key = (lang, path, hash(content))
    if key in _TREE_CACHE:
        return _TREE_CACHE[key]
    try:
        parser = get_parser(lang)
    except TreeSitterUnavailable:
        return None
    tree = parser.parse(content.encode("utf-8"))
    _TREE_CACHE[key] = tree
    return tree


def clear_cache() -> None:
    """Reset between runs so different repos don't share cached trees."""
    _TREE_CACHE.clear()


# ── walk + query helpers (used by java.py / csharp.py) ────────────────────


def walk_pre(node: Any):
    """Pre-order traversal, yielding every node."""
    stack = [node]
    while stack:
        current = stack.pop()
        yield current
        # Children iterator on tree-sitter nodes is forward-only; copy.
        children = list(current.children)
        stack.extend(reversed(children))


def node_text(node: Any, source_bytes: bytes) -> str:
    """Extract the source text covered by `node`."""
    return source_bytes[node.start_byte : node.end_byte].decode("utf-8", errors="replace")


def find_children_of_type(node: Any, type_name: str) -> list[Any]:
    """Direct children whose `.type` matches `type_name`."""
    return [c for c in node.children if c.type == type_name]


def find_descendants_of_type(node: Any, type_name: str) -> list[Any]:
    """Any descendant whose `.type` matches `type_name`."""
    return [n for n in walk_pre(node) if n.type == type_name]
