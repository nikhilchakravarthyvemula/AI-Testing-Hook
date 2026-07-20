"""db-schema-llm — LLM-driven DB schema extractor.

Catches what the deterministic SQLAlchemy parser (../deterministic/) can't:
  * Django ORM models
  * Prisma / TypeORM / Sequelize / Drizzle entities
  * Raw migration SQL (Alembic, Knex, Flyway, Liquibase)
  * schema.sql / create_tables.sql dumps
  * SQLModel, Pony, peewee, …

Approach: shell out to the agentic-harness `ask.py` in free-agent mode
with bash/grep/read_file tools, and a strict prompt telling the LLM to
write a JSON file at a known path. We read it back, normalize, write
`output/db-schema/llm.json`.

Pairs with `../deterministic/extract.py` (the SQLAlchemy AST parser).
The db-schema orchestrator (`../extract.py`) runs both, reads back
`deterministic.json` + `llm.json`, and merges by lowercased table name
into `output/db-schema/bundle.json` (the file the indexer reads).

Designed to be framework-agnostic — same code works on any of the
100+ stacks the testing-harness might target.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

# ── paths ─────────────────────────────────────────────────────────────────

# This file: <repo>/context-layer/content-extractor/code-extractors/db-schema/llm/extract.py
# parents: [0]=llm/ [1]=db-schema/ [2]=code-extractors/ [3]=content-extractor/
#          [4]=context-layer/ [5]=<repo>
REPO_ROOT = Path(__file__).resolve().parents[5]
OUT_FILE  = REPO_ROOT / "output" / "db-schema" / "llm.json"
ASK_PY    = REPO_ROOT / "testo" / "harness" / "bin" / "ask.py"
AGENTIC_PY = REPO_ROOT / "context-layer" / "content-extractor" / "_lib" / ".venv" / "bin" / "python"

# Where the LLM is asked to write its findings. The agent is told to
# pass exactly this path to `write_file` — we read it back when done.
LLM_RAW_OUTPUT = REPO_ROOT / "output" / "db-schema" / "llm-raw.json"

DEFAULT_TIMEOUT_S = 600    # 10 min ceiling; agent typically takes 1-3 min
DEFAULT_MAX_TURNS = 40


# ── prompt ─────────────────────────────────────────────────────────────────

PROMPT_TEMPLATE = """You are a DATABASE SCHEMA EXTRACTOR.

Target codebase:
  {target}

Your job:
  1. Use bash, grep, glob, and read_file to find database schema definitions.
     Look in (priority order):
       a. ORM model files (SQLAlchemy, Django, SQLModel, Pony, peewee, Tortoise,
          Prisma `schema.prisma`, TypeORM entities, Sequelize models, Drizzle).
       b. Migration files (Alembic, Django migrations, Knex, Prisma migrations,
          Flyway `V*.sql`, Liquibase `changelog.xml`).
       c. Raw SQL files (`schema.sql`, `create_tables.sql`, `init.sql`).
  2. For EVERY table you find, capture: name, source file, the ORM/framework
     it was declared with, every column (name + type + constraints), primary
     key, foreign keys, unique constraints, indexes, and (when easy) ORM
     relationships.
  3. When you have enough evidence, call write_file with this exact path:
     {output_path}
  4. The file MUST be valid JSON matching this schema EXACTLY. Do not add
     prose, markdown fences, or commentary.

Schema:
{{
  "tables": [
    {{
      "table": "<snake_case_table_name>",
      "className": "<model class name>" | null,
      "sourceFile": "<repo-relative path>",
      "framework": "sqlalchemy" | "django" | "sqlmodel" | "prisma" | "typeorm" |
                   "sequelize" | "drizzle" | "peewee" | "tortoise" |
                   "sql-migration" | "raw-sql" | "other",
      "columns": [
        {{
          "name": "<col_name>",
          "type": "<column type, normalized: integer | varchar(255) | text | boolean | timestamp | uuid | jsonb | ...>",
          "primaryKey": true|false,
          "nullable": true|false,
          "unique": true|false,
          "indexed": true|false,
          "default": "<literal or function name or null>",
          "foreignKeys": ["other_table.id", ...]
        }}
      ],
      "relationships": [
        {{ "name": "<ORM rel name>", "target": "<other class or table>", "kind": "one_to_many" | "many_to_one" | "many_to_many" | "one_to_one" }}
      ]
    }}
  ]
}}

Important rules:
  * Be EXHAUSTIVE — find every table, including join tables and views.
  * Normalize types — write `integer` not `Integer`/`INT`/`int4`.
  * If a column is foreign key, set foreignKeys=["other_table.column"].
  * Skip tables that don't actually exist (e.g. abstract base classes).
  * Don't invent tables; if you find none, return {{"tables": []}}.
  * Use 'sourceFile' RELATIVE to the target root, no leading slash.
  * After writing the JSON, reply with one short summary sentence.
"""


# ── main ───────────────────────────────────────────────────────────────────


def main() -> int:
    raw_target = sys.argv[1] if len(sys.argv) >= 2 else os.environ.get("TARGET_CODEBASE")
    if not raw_target:
        print("usage: extract.py /abs/path/to/target  (or TARGET_CODEBASE=...)", file=sys.stderr)
        return 2
    target = Path(raw_target).resolve()
    if not target.is_dir():
        print(f"target is not a directory: {target}", file=sys.stderr)
        return 2

    _assert_subprocess_available()

    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    if LLM_RAW_OUTPUT.exists():
        LLM_RAW_OUTPUT.unlink()   # stale-output guard

    started = time.monotonic()
    prompt = PROMPT_TEMPLATE.format(target=str(target), output_path=str(LLM_RAW_OUTPUT))
    exit_code = _invoke_agent(prompt)
    elapsed_ms = (time.monotonic() - started) * 1000.0

    bundle = _build_bundle(target=target, exit_code=exit_code, elapsed_ms=elapsed_ms)
    OUT_FILE.write_text(json.dumps(bundle, indent=2, default=str))

    print(
        f"[db-schema-llm] tables={len(bundle['tables'])} "
        f"columns={bundle['stats']['totalColumns']} "
        f"frameworks={bundle['stats']['frameworksSeen']} "
        f"(agent_exit={exit_code} took={int(elapsed_ms)}ms) "
        f"→ {OUT_FILE.relative_to(REPO_ROOT)}",
        flush=True,
    )
    return 0 if bundle['tables'] else 1


# ── internals ──────────────────────────────────────────────────────────────


def _assert_subprocess_available() -> None:
    if not ASK_PY.is_file():
        print(f"[db-schema-llm] ERROR: ask.py missing at {ASK_PY}", file=sys.stderr)
        sys.exit(2)
    if not AGENTIC_PY.is_file():
        print(
            f"[db-schema-llm] ERROR: agentic python interpreter missing at {AGENTIC_PY}\n"
            f"  (expected context-layer/content-extractor/_lib/.venv/ with openharness installed)",
            file=sys.stderr,
        )
        sys.exit(2)


def _invoke_agent(prompt: str) -> int:
    cmd = [str(AGENTIC_PY), str(ASK_PY), prompt, "--max-turns", str(DEFAULT_MAX_TURNS)]
    print(
        f"[db-schema-llm] invoking ask.py (max_turns={DEFAULT_MAX_TURNS}, "
        f"timeout={DEFAULT_TIMEOUT_S}s)…",
        flush=True,
    )
    try:
        completed = subprocess.run(  # noqa: S603
            cmd, env=os.environ.copy(), check=False, timeout=DEFAULT_TIMEOUT_S,
        )
        return completed.returncode
    except subprocess.TimeoutExpired:
        print(f"[db-schema-llm] TIMEOUT after {DEFAULT_TIMEOUT_S}s", file=sys.stderr, flush=True)
        return 124


def _build_bundle(*, target: Path, exit_code: int, elapsed_ms: float) -> dict:
    raw = _read_llm_output()
    tables = _normalize_tables(raw.get("tables") if raw else [])

    frameworks_seen = sorted({t["framework"] for t in tables if t.get("framework")})
    total_cols = sum(len(t.get("columns") or []) for t in tables)
    total_rels = sum(len(t.get("relationships") or []) for t in tables)

    return {
        "sourceId":      "db-schema-llm",
        "discoveryTier": "graph_extracted",  # LLM extraction → uses our graph_extracted tier
        "confidence":    0.65,
        "extractor": {
            "name": "db-schema-llm",
            "discoveryTier": "graph_extracted",
            "fileGlobs": ["any"],
            "approach": "agentic — bash/grep/read_file via agentic-harness",
        },
        "target":        str(target),
        "agent": {
            "exitCode":   exit_code,
            "durationMs": round(elapsed_ms, 1),
            "maxTurns":   DEFAULT_MAX_TURNS,
            "timeoutS":   DEFAULT_TIMEOUT_S,
            "rawOutput":  str(LLM_RAW_OUTPUT.relative_to(REPO_ROOT)),
        },
        "stats": {
            "tablesFound":       len(tables),
            "totalColumns":      total_cols,
            "totalRelationships": total_rels,
            "frameworksSeen":    frameworks_seen,
        },
        "tables": tables,
    }


def _read_llm_output() -> dict | None:
    if not LLM_RAW_OUTPUT.is_file():
        print(
            f"[db-schema-llm] no output file at {LLM_RAW_OUTPUT.name} — "
            f"LLM may have failed or skipped write_file step",
            file=sys.stderr, flush=True,
        )
        return None
    try:
        return json.loads(LLM_RAW_OUTPUT.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        print(f"[db-schema-llm] unparseable LLM output ({exc})", file=sys.stderr, flush=True)
        return None


# ── normalization ──────────────────────────────────────────────────────────


_VALID_FRAMEWORKS = {
    "sqlalchemy", "django", "sqlmodel", "prisma", "typeorm",
    "sequelize", "drizzle", "peewee", "tortoise",
    "sql-migration", "raw-sql", "other",
}


def _normalize_tables(items) -> list[dict]:
    """Sanitize LLM output. Drops invalid rows; coerces fields into our shape."""
    if not isinstance(items, list):
        return []

    out: list[dict] = []
    for raw in items:
        if not isinstance(raw, dict):
            continue
        table = (raw.get("table") or "").strip()
        if not table:
            continue
        framework = (raw.get("framework") or "other").lower()
        if framework not in _VALID_FRAMEWORKS:
            framework = "other"

        columns = _normalize_columns(raw.get("columns"))
        relationships = _normalize_relationships(raw.get("relationships"))

        out.append({
            "table":     table,
            "className": _str_or_none(raw.get("className")),
            "sourceFile": _str_or_none(raw.get("sourceFile")),
            "framework": framework,
            "columns":   columns,
            "relationships": relationships,
            "primaryKeyColumns": [c["name"] for c in columns if c.get("primaryKey")],
            "uniqueColumns":     [c["name"] for c in columns if c.get("unique")],
            "indexedColumns":    [c["name"] for c in columns if c.get("indexed")],
        })
    return out


def _normalize_columns(items) -> list[dict]:
    if not isinstance(items, list):
        return []
    out: list[dict] = []
    for raw in items:
        if not isinstance(raw, dict):
            continue
        name = (raw.get("name") or "").strip()
        if not name:
            continue
        out.append({
            "name":        name,
            "type":        _str_or_none(raw.get("type")),
            "primaryKey":  bool(raw.get("primaryKey", False)),
            "nullable":    bool(raw.get("nullable", True)),
            "unique":      bool(raw.get("unique", False)),
            "indexed":     bool(raw.get("indexed", False)),
            "default":     _str_or_none(raw.get("default")),
            "foreignKeys": [str(fk) for fk in (raw.get("foreignKeys") or []) if isinstance(fk, str)],
        })
    return out


def _normalize_relationships(items) -> list[dict]:
    if not isinstance(items, list):
        return []
    out: list[dict] = []
    for raw in items:
        if not isinstance(raw, dict):
            continue
        out.append({
            "name":   _str_or_none(raw.get("name")),
            "target": _str_or_none(raw.get("target")),
            "kind":   _str_or_none(raw.get("kind")),
        })
    return out


def _str_or_none(v) -> str | None:
    if v is None: return None
    s = str(v).strip()
    return s if s else None


if __name__ == "__main__":
    sys.exit(main())
