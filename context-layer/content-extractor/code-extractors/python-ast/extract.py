"""Deterministic Python code extractor.

Walks a target Python codebase, parses every .py file via stdlib `ast`,
and emits one JSON file describing every file, class, function, import,
route decorator, and ORM model.

No LLM. No third-party deps (just stdlib).
DiscoveryTier: AST (confidence 0.90).

Usage:
    python3 extract.py /path/to/target

Env vars:
    OUT_FILE       defaults to <repo-root>/output/code-extractors/python-ast.json
    SKIP_DIRS      comma-separated. Default: .git,.venv,node_modules,__pycache__,dist,build,.pytest_cache
"""
from __future__ import annotations

import ast
import json
import os
import re
import sys
import time
from pathlib import Path

# ── config ─────────────────────────────────────────────────────────────────

REPO_ROOT = Path(__file__).resolve().parents[4]
DEFAULT_OUT = REPO_ROOT / "output" / "code-extractors" / "python-ast.json"

SKIP_DIRS = set(
    os.environ.get(
        "SKIP_DIRS",
        ".git,.venv,venv,node_modules,__pycache__,dist,build,.pytest_cache,.mypy_cache,.ruff_cache,site-packages,egg-info",
    ).split(",")
)

# Frameworks we recognize via decorator pattern.
_FASTAPI_VERBS = {"get", "post", "put", "patch", "delete", "options", "head"}
_FLASK_ROUTE_RE = re.compile(r"^route$")
_FASTAPI_IMPORT_RE = re.compile(r"\bfrom\s+fastapi\b|\bimport\s+fastapi\b")
_FLASK_IMPORT_RE = re.compile(r"\bfrom\s+flask\b|\bimport\s+flask\b")
_PYDANTIC_BASE = {"BaseModel", "BaseSettings"}
_ORM_BASE = {"Model", "Base", "DeclarativeBase"}


# ── helpers ────────────────────────────────────────────────────────────────

def should_skip(p: Path) -> bool:
    return any(part in SKIP_DIRS for part in p.parts)


def docstring_first_line(node: ast.AST) -> str | None:
    doc = ast.get_docstring(node)
    if not doc:
        return None
    first = doc.strip().splitlines()[0]
    return first[:160] if first else None


def annotation_to_str(node: ast.AST | None) -> str | None:
    if node is None:
        return None
    try:
        return ast.unparse(node)
    except Exception:
        return None


def decorator_to_attr(dec: ast.AST) -> tuple[str | None, str | None]:
    """Return (object, method) for decorators like `@app.get` or `@router.post`.

    For `@app.get(...)` this returns ("app", "get").
    For `@route(...)` this returns (None, "route").
    For `@module.deeper.method` this returns ("module.deeper", "method").
    """
    target = dec.func if isinstance(dec, ast.Call) else dec
    if isinstance(target, ast.Attribute):
        obj_parts = []
        cur = target.value
        while isinstance(cur, ast.Attribute):
            obj_parts.append(cur.attr)
            cur = cur.value
        if isinstance(cur, ast.Name):
            obj_parts.append(cur.id)
        return (".".join(reversed(obj_parts)) or None, target.attr)
    if isinstance(target, ast.Name):
        return (None, target.id)
    return (None, None)


def decorator_first_string_arg(dec: ast.AST) -> str | None:
    if not isinstance(dec, ast.Call):
        return None
    for arg in dec.args:
        if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
            return arg.value
    return None


def decorator_kw_methods(dec: ast.AST) -> list[str] | None:
    """For Flask's `@app.route('/foo', methods=['GET', 'POST'])` → ['GET','POST']."""
    if not isinstance(dec, ast.Call):
        return None
    for kw in dec.keywords:
        if kw.arg == "methods" and isinstance(kw.value, ast.List):
            return [
                el.value.upper()
                for el in kw.value.elts
                if isinstance(el, ast.Constant) and isinstance(el.value, str)
            ]
    return None


def function_signature(fn: ast.FunctionDef | ast.AsyncFunctionDef) -> dict:
    args = fn.args
    return {
        "positional": [{"name": a.arg, "annotation": annotation_to_str(a.annotation)} for a in args.args],
        "kwonly":     [{"name": a.arg, "annotation": annotation_to_str(a.annotation)} for a in args.kwonlyargs],
        "vararg":     args.vararg.arg if args.vararg else None,
        "kwarg":      args.kwarg.arg  if args.kwarg  else None,
        "returns":    annotation_to_str(fn.returns),
    }


# ── cross-file context (router prefixes) ──────────────────────────────────

def scan_include_router_prefixes(files: list[tuple[Path, str]]) -> dict[str, str]:
    """Scan likely-entrypoint files for `app.include_router(name.router, prefix=...)`.

    Returns {moduleName: prefix} so per-route extraction can join correctly.
    Supports both literal and f-string prefixes (`f"{settings.API_V1_STR}/users"`).
    """
    file_prefixes: dict[str, str] = {}
    entry_re = re.compile(r"/(main|app|server|__init__|api)\.py$")
    include_re = re.compile(
        r"include_router\s*\(\s*([\w_.]+)[^)]*?prefix\s*=\s*(f)?['\"]([^'\"]+)['\"]"
    )
    # Build a lookup: variable references to literal string values.
    # Match both module-top-level assignments AND class-member annotations
    # (Pydantic Settings pattern: `API_V1_STR: str = "/app/v1"`).
    string_consts = {}
    for path, content in files:
        for m in re.finditer(
            r"^[ \t]*(\w+)\s*(?::\s*[\w\[\], ]+)?\s*=\s*['\"]([^'\"]+)['\"]",
            content,
            re.MULTILINE,
        ):
            # First wins (so module-level takes priority over deeper scopes)
            string_consts.setdefault(m.group(1), m.group(2))

    for path, content in files:
        if not entry_re.search(str(path)):
            continue
        for m in include_re.finditer(content):
            module_name = m.group(1).split(".")[0]
            is_fstring = bool(m.group(2))
            raw = m.group(3)
            if is_fstring:
                resolved = re.sub(
                    r"\{([^}]+)\}",
                    lambda v: string_consts.get(v.group(1).strip().split(".")[-1], f"<?{v.group(1)}?>"),
                    raw,
                )
                if "<?" in resolved:
                    continue  # couldn't resolve
                file_prefixes[module_name] = resolved
            else:
                file_prefixes[module_name] = raw
    return file_prefixes


# ── per-file extraction ────────────────────────────────────────────────────

def extract_one_file(file: Path, content: str, prefix_for_module: dict[str, str]) -> dict:
    rel = str(file.relative_to(TARGET))
    out = {
        "path": rel,
        "imports": [],
        "classes": [],
        "functions": [],
        "endpoints": [],
        "models": [],
    }
    try:
        tree = ast.parse(content, filename=str(file))
    except SyntaxError as e:
        out["parseError"] = f"{e.msg} at line {e.lineno}"
        return out

    # Imports
    for node in ast.iter_child_nodes(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                out["imports"].append({"module": alias.name, "asname": alias.asname})
        elif isinstance(node, ast.ImportFrom):
            module = node.module or ""
            for alias in node.names:
                out["imports"].append(
                    {"module": f"{module}.{alias.name}" if module else alias.name, "asname": alias.asname, "fromImport": True}
                )

    # Local APIRouter(prefix="...") to layer on top of cross-file prefix
    local_prefix = ""
    for m in re.finditer(r"APIRouter\s*\([^)]*?prefix\s*=\s*['\"]([^'\"]+)['\"]", content):
        local_prefix = m.group(1)
        break

    # Module-name for cross-file lookup
    module_name = file.stem  # filename without extension
    cross_prefix = prefix_for_module.get(module_name, "")

    is_fastapi = bool(_FASTAPI_IMPORT_RE.search(content))
    is_flask = bool(_FLASK_IMPORT_RE.search(content))

    # Walk the tree for classes + functions
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef):
            base_names = [annotation_to_str(b) or "" for b in node.bases]
            framework = None
            if any(name.split(".")[-1] in _PYDANTIC_BASE for name in base_names):
                framework = "pydantic"
            elif any(name.split(".")[-1] in _ORM_BASE for name in base_names):
                framework = "orm"
            cls = {
                "name":     node.name,
                "bases":    base_names,
                "line":     node.lineno,
                "endLine":  getattr(node, "end_lineno", node.lineno),
                "doc":      docstring_first_line(node),
                "methods":  [child.name for child in node.body if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef))],
            }
            out["classes"].append(cls)
            if framework:
                out["models"].append({
                    "name":      node.name,
                    "kind":      framework,
                    "line":      node.lineno,
                    "fields":    [
                        {"name": stmt.target.id, "annotation": annotation_to_str(stmt.annotation)}
                        for stmt in node.body
                        if isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name)
                    ],
                })

        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            fn = {
                "name":      node.name,
                "line":      node.lineno,
                "endLine":   getattr(node, "end_lineno", node.lineno),
                "isAsync":   isinstance(node, ast.AsyncFunctionDef),
                "doc":       docstring_first_line(node),
                "signature": function_signature(node),
                "decorators":[ast.unparse(d) for d in node.decorator_list if not isinstance(d, ast.Call)] +
                             [ast.unparse(d.func) for d in node.decorator_list if isinstance(d, ast.Call)],
            }
            out["functions"].append(fn)

            # Backend route decorator detection
            for dec in node.decorator_list:
                obj, method = decorator_to_attr(dec)
                if method is None:
                    continue
                m_lower = method.lower()

                # FastAPI / generic: @app.get("/path") / @router.post("/path")
                if is_fastapi and m_lower in _FASTAPI_VERBS:
                    raw_path = decorator_first_string_arg(dec)
                    if raw_path is not None:
                        full = (cross_prefix + local_prefix + raw_path).replace("//", "/")
                        out["endpoints"].append({
                            "method":    m_lower.upper(),
                            "path":      full,
                            "framework": "fastapi",
                            "handler":   {"file": rel, "function": node.name, "line": dec.lineno},
                            "decoratorRaw": ast.unparse(dec),
                        })
                # Flask: @app.route("/path", methods=["GET"])
                elif is_flask and _FLASK_ROUTE_RE.match(m_lower):
                    raw_path = decorator_first_string_arg(dec)
                    methods = decorator_kw_methods(dec) or ["GET"]
                    if raw_path is not None:
                        for http_method in methods:
                            out["endpoints"].append({
                                "method":    http_method,
                                "path":      raw_path,
                                "framework": "flask",
                                "handler":   {"file": rel, "function": node.name, "line": dec.lineno},
                                "decoratorRaw": ast.unparse(dec),
                            })
                # Flask short form: @app.get("/path") (Flask 2+)
                elif is_flask and m_lower in _FASTAPI_VERBS:
                    raw_path = decorator_first_string_arg(dec)
                    if raw_path is not None:
                        out["endpoints"].append({
                            "method":    m_lower.upper(),
                            "path":      raw_path,
                            "framework": "flask",
                            "handler":   {"file": rel, "function": node.name, "line": dec.lineno},
                            "decoratorRaw": ast.unparse(dec),
                        })

    return out


# ── top-level walker ───────────────────────────────────────────────────────

def walk_python(root: Path) -> list[Path]:
    return [
        p
        for p in root.rglob("*.py")
        if p.is_file() and not should_skip(p.relative_to(root))
    ]


def main():
    # Accept the target via argv OR the shared TARGET_CODEBASE env var so
    # this extractor plugs into the content-extractor orchestrator without
    # special casing.
    raw_target = sys.argv[1] if len(sys.argv) >= 2 else os.environ.get("TARGET_CODEBASE")
    if not raw_target:
        print(
            "usage: extract.py /path/to/target  (or set TARGET_CODEBASE=...)",
            file=sys.stderr,
        )
        sys.exit(2)
    global TARGET
    TARGET = Path(raw_target).resolve()
    if not TARGET.is_dir():
        print(f"target not a directory: {TARGET}", file=sys.stderr)
        sys.exit(2)

    out_path = Path(os.environ.get("OUT_FILE", DEFAULT_OUT))
    out_path.parent.mkdir(parents=True, exist_ok=True)

    t0 = time.time()
    py_files = walk_python(TARGET)
    print(f"[ast-extract] scanning {len(py_files)} Python files under {TARGET}", flush=True)

    # Load all contents once (cross-file prefix discovery needs the whole set)
    file_contents: list[tuple[Path, str]] = []
    for p in py_files:
        try:
            file_contents.append((p, p.read_text(encoding="utf-8", errors="replace")))
        except Exception as e:
            print(f"  ! could not read {p}: {e}", file=sys.stderr)

    # Pass 1 — discover cross-file router prefixes
    prefix_for_module = scan_include_router_prefixes(file_contents)
    if prefix_for_module:
        print(f"[ast-extract] cross-file prefixes: {prefix_for_module}", flush=True)

    # Pass 2 — extract per file
    files_out = []
    endpoints_out = []
    classes_out = []
    functions_out = []
    models_out = []

    for path, content in file_contents:
        file_data = extract_one_file(path, content, prefix_for_module)
        files_out.append(file_data)
        for ep in file_data["endpoints"]:
            endpoints_out.append({**ep, "sourceFile": file_data["path"]})
        for cl in file_data["classes"]:
            classes_out.append({**cl, "sourceFile": file_data["path"]})
        for fn in file_data["functions"]:
            functions_out.append({**fn, "sourceFile": file_data["path"]})
        for m in file_data["models"]:
            models_out.append({**m, "sourceFile": file_data["path"]})

    elapsed = round(time.time() - t0, 2)

    bundle = {
        "sourceId": "python-ast",
        "discoveryTier": "ast",
        "confidence": 0.90,
        "extractedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "extractedBy": "context-layer/content-extractor/code-extractors/python-ast/extract.py",
        "target": str(TARGET),
        "stats": {
            "filesScanned": len(py_files),
            "filesReadable": len(file_contents),
            "endpoints": len(endpoints_out),
            "classes": len(classes_out),
            "functions": len(functions_out),
            "models": len(models_out),
            "crossFilePrefixes": prefix_for_module,
            "elapsedSec": elapsed,
        },
        "files": files_out,
        "endpoints": endpoints_out,
        "classes": classes_out,
        "functions": functions_out,
        "models": models_out,
    }

    out_path.write_text(json.dumps(bundle, indent=2))
    print(f"[ast-extract] wrote {out_path} ({out_path.stat().st_size // 1024} KB)", flush=True)
    print(f"[ast-extract] stats: {bundle['stats']}", flush=True)


if __name__ == "__main__":
    main()
