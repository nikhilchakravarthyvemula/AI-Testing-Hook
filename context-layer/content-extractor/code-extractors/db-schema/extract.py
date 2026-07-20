"""db-schema — code-extractor for database schemas (static source analysis).

Lives under code-extractors/ because it discovers facts purely from static
source (SQLAlchemy AST + an opt-in LLM pass over ORM/migration/SQL files) —
it never connects to a live database. The framework-detector recommends it
(catalog entry `db-schema`, wildcard `*any`) so it runs in stage 3 whenever a
codebase is present, gated on TARGET_CODEBASE like every other code-extractor.

Runs both sub-extractors and merges into a single bundle:

  deterministic/extract.py — fast SQLAlchemy AST parser (no LLM, no cost)
  llm/extract.py           — agentic catch-all (Django, Prisma, TypeORM,
                              raw SQL migrations, etc.) via MiniMax-M2.7

Both produce the same table shape; we merge by lowercased table name.
When both find the same table, the higher-tier (ast) wins for the
canonical column data and the LLM finding is kept as a corroborating
observation.

Output: output/db-schema/bundle.json   (the file the indexer reads)
Plus  : output/db-schema/deterministic.json   (raw deterministic output)
        output/db-schema/llm.json             (raw LLM output)
        output/db-schema/llm-raw.json         (the LLM's own JSON output)

Env gating: TARGET_CODEBASE is required (the stage-3 code-extractor guard in
run.mjs already enforces this). Without it, this still defends in depth by
writing a skipped bundle and exiting 0.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path


_HERE = Path(__file__).resolve().parent
# db-schema/ → code-extractors/ → content-extractor/ → context-layer/ → repo
REPO_ROOT = _HERE.parents[3]
OUT_DIR = REPO_ROOT / "output" / "db-schema"
BUNDLE_FILE = OUT_DIR / "bundle.json"

DETERMINISTIC_SCRIPT = _HERE / "deterministic" / "extract.py"
LLM_SCRIPT           = _HERE / "llm" / "extract.py"
PY_INTERPRETER       = REPO_ROOT / "context-layer" / "content-extractor" / "_lib" / ".venv" / "bin" / "python"

# Tier ranking — higher number wins when both extractors disagree.
_TIER_RANK = {"ast": 3, "code_regex": 2, "graph_extracted": 1, "code_only": 0}


def main() -> int:
    target = os.environ.get("TARGET_CODEBASE")
    if not target:
        # Same convention as the other primary sources — write a skipped
        # bundle, exit 0. The orchestrator gate should catch this earlier
        # but defend in depth.
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        BUNDLE_FILE.write_text(json.dumps({
            "sourceId": "db-schema",
            "skipped": "TARGET_CODEBASE env var not set",
            "tables": [],
            "stats": {"tablesFound": 0},
        }, indent=2))
        print("[db-schema] skipped — TARGET_CODEBASE not set", flush=True)
        return 0

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()

    # ── step 1: deterministic ─────────────────────────────────────────────
    det_bundle = _run_sub(DETERMINISTIC_SCRIPT, label="deterministic")

    # ── step 2: LLM ────────────────────────────────────────────────────────
    # The LLM step is opt-in via DBSCHEMA_LLM=1. It runs an agentic loop
    # (read_file/grep/write_file) that can grind for 10-30+ minutes on a
    # large codebase, often producing little incremental value over the
    # deterministic SQLAlchemy/SQL parser. Default off so `testo scan`
    # always terminates.
    if os.environ.get("DBSCHEMA_LLM", "0") == "1":
        llm_bundle = _run_sub(LLM_SCRIPT, label="llm")
    else:
        print("[db-schema] LLM enrichment skipped (set DBSCHEMA_LLM=1 to enable)", flush=True)
        llm_bundle = None

    # ── step 3: merge into bundle.json ────────────────────────────────────
    merged = _merge(det_bundle, llm_bundle)
    BUNDLE_FILE.write_text(json.dumps({
        "sourceId":      "db-schema",
        "discoveryTier": "ast",   # primary tier; LLM observations also recorded
        "extractedAt":   datetime.now(tz=timezone.utc).isoformat(),
        "target":        target,
        "durationMs":    round((time.monotonic() - started) * 1000, 1),
        "sources": {
            "deterministic": {"tables": len((det_bundle or {}).get("tables") or [])},
            "llm":           {"tables": len((llm_bundle or {}).get("tables") or [])},
        },
        "stats": {
            "tablesFound":       len(merged),
            "totalColumns":      sum(len(t.get("columns") or []) for t in merged),
            "totalRelationships": sum(len(t.get("relationships") or []) for t in merged),
            "frameworksSeen":    sorted({t.get("framework") or "other" for t in merged}),
        },
        "tables": merged,
    }, indent=2, default=str))

    print(
        f"[db-schema] merged: tables={len(merged)} "
        f"(deterministic={len((det_bundle or {}).get('tables') or [])} "
        f"llm={len((llm_bundle or {}).get('tables') or [])}) "
        f"→ {BUNDLE_FILE.relative_to(REPO_ROOT)}",
        flush=True,
    )
    return 0


# ── internals ──────────────────────────────────────────────────────────────


def _run_sub(script: Path, *, label: str) -> dict | None:
    """Run one sub-extractor, return its parsed JSON bundle (or None)."""
    if not script.is_file():
        print(f"[db-schema:{label}] script missing at {script} — skipping", flush=True)
        return None
    py = str(PY_INTERPRETER) if PY_INTERPRETER.is_file() else "python3"
    print(f"\n[db-schema] ━━━━━━━━━━━ {label} ━━━━━━━━━━━", flush=True)
    try:
        subprocess.run([py, str(script)], check=False)
    except Exception as exc:  # noqa: BLE001
        print(f"[db-schema:{label}] FAILED: {exc!r}", flush=True)
        return None

    # The sub-extractor writes its own JSON to a known path; read it back.
    out_path = OUT_DIR / f"{label}.json"
    if not out_path.is_file():
        print(f"[db-schema:{label}] no output at {out_path}", flush=True)
        return None
    try:
        return json.loads(out_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        print(f"[db-schema:{label}] unparseable output ({exc})", flush=True)
        return None


def _merge(det_bundle: dict | None, llm_bundle: dict | None) -> list[dict]:
    """Merge tables from both sources by lowercased table name."""
    by_table: dict[str, dict] = {}

    def absorb(bundle: dict | None, tier: str, source_id: str) -> None:
        if not bundle: return
        for t in (bundle.get("tables") or []):
            name = (t.get("table") or "").lower()
            if not name: continue
            existing = by_table.get(name)
            if existing is None:
                t = dict(t)
                t["_sources"] = [{"sourceId": source_id, "tier": tier}]
                by_table[name] = t
                continue
            # Record corroboration.
            existing.setdefault("_sources", []).append({"sourceId": source_id, "tier": tier})
            # Upgrade primary if this tier outranks the recorded one.
            current_tier = (existing.get("_sources") or [{}])[0].get("tier", "code_only")
            if _TIER_RANK.get(tier, -1) > _TIER_RANK.get(current_tier, -1):
                merged_sources = existing["_sources"]
                t = dict(t)
                t["_sources"] = merged_sources   # preserve audit trail
                by_table[name] = t

    absorb(det_bundle, "ast",             "deterministic")
    absorb(llm_bundle, "graph_extracted", "llm")
    return list(by_table.values())


if __name__ == "__main__":
    sys.exit(main())
