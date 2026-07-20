# Deterministic Python code extractor

Walks a target Python codebase, parses every `.py` file via the stdlib `ast`
module, and emits a JSON file describing every file, class, function,
import, and route decorator it finds.

**No LLM.** No third-party dependencies (just stdlib).
DiscoveryTier: `ast` (confidence 0.90).

## What it extracts

For each `.py` file in the target:
- **Module-level imports** (`import X`, `from X import Y`)
- **Classes** — name, base classes, methods, decorators, line range, docstring first line
- **Functions** — name, signature (positional/kwarg names + type annotations), decorators, async-or-not, line range, docstring first line
- **Backend route decorators** — `@app.get("/foo")`, `@router.post("/bar")`,
  `@app.route("/baz", methods=["GET", "POST"])` (FastAPI + Flask conventions)
- **Cross-file router mounts** — `app.include_router(users.router, prefix="/api/v1")`
  including f-string prefix resolution (`prefix=f"{settings.API_V1_STR}/users"`)
- **Pydantic / ORM models** — classes inheriting from `BaseModel`, `Model`, `Base`
- **Package metadata** — reads `pyproject.toml` / `setup.cfg` for project info

## What it does NOT do

- LLM-driven semantic clustering (that's graphify's job)
- TypeScript / JavaScript / Java / C# (just Python in this v1)
- Type-inference beyond what's annotated
- Cross-call graph construction

## Output shape

`output/sources/codebase-ast.json`:

```json
{
  "sourceId": "codebase-ast",
  "discoveryTier": "ast",
  "confidence": 0.90,
  "extractedAt": "ISO",
  "target": "/abs/path/to/your/codebase",
  "stats": { "filesScanned": 142, "endpoints": 37, "classes": 89, "functions": 412 },
  "files": [...],
  "endpoints": [
    {
      "method": "GET",
      "path": "/app/v1/me",
      "handler": { "file": "backend/.../auth.py", "function": "read_user_me", "line": 171 },
      "framework": "fastapi",
      "provenance": { ... }
    }
  ],
  "classes": [...],
  "functions": [...],
  "models": [...]
}
```

## Usage

```bash
cd context-layer/content-extractor/code-extractors/python-ast
python3 extract.py /path/to/target/codebase
# → writes output/sources/codebase-ast.json
```

## Why deterministic when graphify exists?

| | graphify | this extractor |
|---|---|---|
| Source language | any (via LSP) | Python only (v1) |
| Method | LLM-driven | stdlib `ast` |
| Cost | $0.10–0.50 per run | $0 |
| Reproducible | mostly | fully |
| Catches semantic relationships | yes (LLM infers) | no (only explicit) |
| Catches every decorator | yes | yes |

Both run in parallel. The Knowledge Synthesizer picks the higher-confidence
source per fact and surfaces disagreements as flags.
