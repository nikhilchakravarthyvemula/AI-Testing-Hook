"""db-schema extractor — pulls SQLAlchemy table definitions from Python source.

Targets the classic SQLAlchemy 1.x declarative pattern (still the most
common in Python codebases as of 2024):

    class User(Base):
        __tablename__ = "users"
        id    = Column(Integer, primary_key=True, index=True)
        email = Column(String, nullable=False, unique=True)
        ...
        role  = relationship("Role", back_populates="users")

Also handles SQLAlchemy 2.x typed style:

    class User(Base):
        __tablename__ = "users"
        id:    Mapped[int]    = mapped_column(primary_key=True)
        email: Mapped[str]    = mapped_column(unique=True)

Output goes to `output/db-schema/deterministic.json`. The top-level
db-schema orchestrator at `../extract.py` then merges this with the
LLM extractor's output into `output/db-schema/bundle.json`. The
indexer reads the merged bundle.

Walks .py files only. Skips vendored dirs (.venv, node_modules, etc).
Outputs uniform JSON regardless of source.
"""
from __future__ import annotations

import ast
import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Optional

# ── config ─────────────────────────────────────────────────────────────────

# deterministic/ → db-schema/ → code-extractors/ → content-extractor/ → context-layer/ → repo
REPO_ROOT = Path(__file__).resolve().parents[5]
DEFAULT_OUT = REPO_ROOT / "output" / "db-schema" / "deterministic.json"

_PRUNE_DIRS = frozenset({
    ".git", ".venv", "venv", "node_modules", "__pycache__",
    ".pytest_cache", ".mypy_cache", "dist", "build", "target",
    ".gradle", ".idea", ".vscode", ".next", ".turbo",
    "coverage", ".cache", "bin", "obj", "vendor", "out", "output",
})

# Heuristic — only parse files that look likely to declare a model.
_SQLALCHEMY_IMPORT_RE = "sqlalchemy"


# ── AST walker ─────────────────────────────────────────────────────────────


def _iter_py_files(root: Path):
    for p in root.rglob("*.py"):
        if any(part in _PRUNE_DIRS for part in p.parts):
            continue
        yield p


def _file_uses_sqlalchemy(content: str) -> bool:
    # Cheap text check; full AST parse only when this passes.
    return _SQLALCHEMY_IMPORT_RE in content


def _const(node: ast.AST) -> Any:
    """Best-effort literal evaluation. Returns the literal value or None."""
    try:
        return ast.literal_eval(node)
    except Exception:
        return None


def _expr_str(node: Optional[ast.AST]) -> str:
    """Render an AST expression back to source for diagnostic display."""
    if node is None:
        return ""
    try:
        return ast.unparse(node)
    except Exception:
        return ast.dump(node)


def _is_column_call(node: ast.AST) -> bool:
    """True if this is a `Column(...)` or `mapped_column(...)` call."""
    if not isinstance(node, ast.Call):
        return False
    fn = node.func
    if isinstance(fn, ast.Name) and fn.id in ("Column", "mapped_column"):
        return True
    if isinstance(fn, ast.Attribute) and fn.attr in ("Column", "mapped_column"):
        return True
    return False


def _is_relationship_call(node: ast.AST) -> bool:
    if not isinstance(node, ast.Call):
        return False
    fn = node.func
    if isinstance(fn, ast.Name) and fn.id == "relationship":
        return True
    if isinstance(fn, ast.Attribute) and fn.attr == "relationship":
        return True
    return False


def _parse_column_call(call: ast.Call) -> dict[str, Any]:
    """Extract column type + kwargs from a `Column(...)` call."""
    args = list(call.args)
    col_type: Optional[str] = None

    # Column(Type, ForeignKey("..."), nullable=False, ...)
    # The TYPE is the first non-ForeignKey positional arg.
    foreign_keys: list[str] = []
    for arg in args:
        if isinstance(arg, ast.Call):
            fn_name = arg.func.id if isinstance(arg.func, ast.Name) else (
                arg.func.attr if isinstance(arg.func, ast.Attribute) else ""
            )
            if fn_name == "ForeignKey":
                if arg.args:
                    fk_target = _const(arg.args[0])
                    if isinstance(fk_target, str):
                        foreign_keys.append(fk_target)
                continue
            # Type with args, e.g. String(255), Numeric(10, 2)
            if col_type is None:
                col_type = _expr_str(arg)
                continue
        if col_type is None:
            col_type = _expr_str(arg)

    kwargs: dict[str, Any] = {}
    for kw in call.keywords:
        kwargs[kw.arg or "**unpacked"] = _const(kw.value) if _const(kw.value) is not None else _expr_str(kw.value)

    return {
        "type": col_type,
        "primaryKey":  bool(kwargs.get("primary_key", False)),
        "nullable":    kwargs.get("nullable", True),
        "unique":      bool(kwargs.get("unique", False)),
        "indexed":     bool(kwargs.get("index", False)),
        "default":     _stringify_value(kwargs.get("default")),
        "serverDefault": _stringify_value(kwargs.get("server_default")),
        "onUpdate":    _stringify_value(kwargs.get("onupdate")),
        "foreignKeys": foreign_keys,
        "autoincrement": kwargs.get("autoincrement"),
        "comment":     kwargs.get("comment"),
    }


def _stringify_value(v):
    """Make a value JSON-serialisable + short."""
    if v is None or isinstance(v, (str, int, float, bool)):
        return v
    return str(v)[:120]


def _parse_relationship_call(call: ast.Call) -> dict[str, Any]:
    target = None
    if call.args:
        target = _const(call.args[0])
    kwargs = {kw.arg: (_const(kw.value) if _const(kw.value) is not None else _expr_str(kw.value)) for kw in call.keywords if kw.arg}
    return {
        "target":      target,
        "backPopulates": kwargs.get("back_populates"),
        "backRef":     kwargs.get("backref"),
        "cascade":     kwargs.get("cascade"),
        "uselist":     kwargs.get("uselist"),
        "secondary":   kwargs.get("secondary"),
    }


def _column_assignment(stmt: ast.stmt) -> Optional[tuple[str, ast.Call]]:
    """If stmt is `name = Column(...)` or `name: Type = mapped_column(...)`,
    return (name, call) else None."""
    # plain assignment: name = Column(...)
    if isinstance(stmt, ast.Assign) and len(stmt.targets) == 1 \
       and isinstance(stmt.targets[0], ast.Name) and _is_column_call(stmt.value):
        return stmt.targets[0].id, stmt.value
    # annotated assignment: name: Mapped[T] = mapped_column(...)
    if isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name) \
       and stmt.value is not None and _is_column_call(stmt.value):
        return stmt.target.id, stmt.value
    return None


def _relationship_assignment(stmt: ast.stmt) -> Optional[tuple[str, ast.Call]]:
    if isinstance(stmt, ast.Assign) and len(stmt.targets) == 1 \
       and isinstance(stmt.targets[0], ast.Name) and _is_relationship_call(stmt.value):
        return stmt.targets[0].id, stmt.value
    if isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name) \
       and stmt.value is not None and _is_relationship_call(stmt.value):
        return stmt.target.id, stmt.value
    return None


def _extract_tables_from_module(tree: ast.Module, source_file: Path) -> list[dict]:
    tables: list[dict] = []

    for node in tree.body:
        if not isinstance(node, ast.ClassDef):
            continue

        # Find __tablename__ — strongest signal this is a model.
        tablename: Optional[str] = None
        for sub in node.body:
            if isinstance(sub, ast.Assign) and len(sub.targets) == 1 \
               and isinstance(sub.targets[0], ast.Name) and sub.targets[0].id == "__tablename__":
                t = _const(sub.value)
                if isinstance(t, str):
                    tablename = t
                break

        if not tablename:
            continue   # not a SQLAlchemy table

        columns: list[dict] = []
        relationships: list[dict] = []
        for sub in node.body:
            col = _column_assignment(sub)
            if col:
                name, call = col
                meta = _parse_column_call(call)
                meta["name"] = name
                columns.append(meta)
                continue
            rel = _relationship_assignment(sub)
            if rel:
                name, call = rel
                meta = _parse_relationship_call(call)
                meta["name"] = name
                relationships.append(meta)

        tables.append({
            "table":     tablename,
            "className": node.name,
            "sourceFile": str(source_file.relative_to(REPO_ROOT) if str(source_file).startswith(str(REPO_ROOT)) else source_file),
            "sourceLine": node.lineno,
            "columns":   columns,
            "relationships": relationships,
            "primaryKeyColumns": [c["name"] for c in columns if c.get("primaryKey")],
            "uniqueColumns":     [c["name"] for c in columns if c.get("unique")],
            "indexedColumns":    [c["name"] for c in columns if c.get("indexed")],
        })

    return tables


# ── runner ─────────────────────────────────────────────────────────────────


def main() -> int:
    raw_target = sys.argv[1] if len(sys.argv) >= 2 else os.environ.get("TARGET_CODEBASE")
    if not raw_target:
        print("usage: extract.py /path/to/target  (or TARGET_CODEBASE=...)", file=sys.stderr)
        return 2
    target = Path(raw_target).resolve()
    if not target.is_dir():
        print(f"target is not a directory: {target}", file=sys.stderr)
        return 2

    started = time.monotonic()
    files_scanned = 0
    files_parsed = 0
    tables_total: list[dict] = []
    errors: list[dict] = []

    for path in _iter_py_files(target):
        files_scanned += 1
        try:
            content = path.read_text(encoding="utf-8", errors="ignore")
        except OSError as exc:
            errors.append({"file": str(path), "error": f"read: {exc}"})
            continue
        if not _file_uses_sqlalchemy(content):
            continue
        files_parsed += 1
        try:
            tree = ast.parse(content, filename=str(path))
        except SyntaxError as exc:
            errors.append({"file": str(path), "error": f"parse: {exc.msg}"})
            continue
        tables_total.extend(_extract_tables_from_module(tree, path))

    out_path = Path(os.environ.get("OUT_FILE", DEFAULT_OUT))
    out_path.parent.mkdir(parents=True, exist_ok=True)

    bundle = {
        "sourceId":      "db-schema",
        "discoveryTier": "ast",
        "confidence":    0.90,
        "extractor":     {"name": "db-schema", "discoveryTier": "ast", "fileGlobs": ["*.py"]},
        "target":        str(target),
        "stats": {
            "filesScanned":         files_scanned,
            "filesParsed":          files_parsed,
            "tablesFound":          len(tables_total),
            "totalColumns":         sum(len(t["columns"]) for t in tables_total),
            "totalRelationships":   sum(len(t["relationships"]) for t in tables_total),
            "elapsedSec":           round(time.monotonic() - started, 3),
        },
        "tables": tables_total,
        "errors": errors,
    }
    out_path.write_text(json.dumps(bundle, indent=2, default=str))

    print(
        f"[db-schema] tables={len(tables_total)} "
        f"columns={bundle['stats']['totalColumns']} "
        f"relationships={bundle['stats']['totalRelationships']} "
        f"(files: scanned={files_scanned} parsed={files_parsed} errors={len(errors)}) "
        f"→ {out_path.relative_to(REPO_ROOT)}",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
