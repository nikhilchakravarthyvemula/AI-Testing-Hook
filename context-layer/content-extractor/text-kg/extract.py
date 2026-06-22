"""text-kg — content-extractor source for UNSTRUCTURED docs.

Reads local docs (markdown / txt / pdf) under TEXT_KG_SOURCE, extracts a
knowledge graph (entities + (subject,predicate,object) triples), and writes
output/text-kg/bundle.json at tier `docs_extracted` (0.55). The same engine
is reused by the jira/ and confluence/ connectors (they hand text to
`extract_triples`).

Engine:
  1. Preferred: kg-gen (DSPy + LiteLLM) — `KGGen.generate(cluster=True)`.
  2. Fallback (kg-gen not importable, e.g. on py3.14): a dependency-free
     HTTP POST to the SAME OpenAI-compatible endpoint the harness uses,
     with a triple-extraction prompt. Identical output shape either way.

Backend: resolved by `_lib/llm_backend.py` (one key/model for the whole repo).
Caching: per-document by content hash → output/text-kg/.cache/<sha>.json,
so re-runs don't re-spend tokens (kg-gen is nondeterministic + costs money).

Gate: TEXT_KG_SOURCE must be set (the orchestrator also gates on it). Without
it this writes a skipped bundle and exits 0.
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

_HERE = Path(__file__).resolve().parent
REPO_ROOT = _HERE.parents[2]            # text-kg → content-extractor → context-layer → repo
sys.path.insert(0, str(_HERE.parent / "_lib"))
from llm_backend import resolve_backend  # noqa: E402

SOURCE_ID = "text-kg"
TIER = "docs_extracted"
CONFIDENCE = 0.55
OUT_DIR = REPO_ROOT / "output" / SOURCE_ID
BUNDLE_FILE = OUT_DIR / "bundle.json"
# Cache lives OUTSIDE the bundle dir so the content-extractor's per-session
# wipe of output/text-kg/ doesn't blow away cached (paid) extractions.
CACHE_DIR = REPO_ROOT / "output" / ".kg-cache" / SOURCE_ID
DOC_EXTS = {".md", ".markdown", ".txt", ".rst", ".pdf"}
MAX_CHARS = int(os.environ.get("TEXT_KG_MAX_CHARS", "12000"))   # per doc, keeps prompts bounded


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _write_bundle(obj: dict) -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    BUNDLE_FILE.write_text(json.dumps(obj, indent=2))


def _skip(reason: str) -> int:
    _write_bundle({"sourceId": SOURCE_ID, "skipped": reason, "extractedAt": _now()})
    print(f"[{SOURCE_ID}] skipped — {reason}", flush=True)
    return 0


# ── document loading ────────────────────────────────────────────────────────

def _read_pdf(path: Path) -> str:
    try:
        import pypdf  # noqa
    except Exception:
        print(f"[{SOURCE_ID}] pypdf not installed — skipping {path.name}", flush=True)
        return ""
    try:
        reader = pypdf.PdfReader(str(path))
        return "\n".join((pg.extract_text() or "") for pg in reader.pages)
    except Exception as e:
        print(f"[{SOURCE_ID}] pdf parse failed for {path.name}: {e}", flush=True)
        return ""


def _load_docs(root: Path) -> list[dict]:
    paths = [root] if root.is_file() else sorted(
        p for p in root.rglob("*") if p.is_file() and p.suffix.lower() in DOC_EXTS
    )
    docs = []
    for p in paths:
        text = _read_pdf(p) if p.suffix.lower() == ".pdf" else p.read_text(errors="replace")
        text = (text or "").strip()
        if not text:
            continue
        docs.append({
            "sourceFile": str(p),
            "text": text[:MAX_CHARS],
            "chars": len(text),
            "contentHash": hashlib.sha256(text.encode("utf-8", "replace")).hexdigest()[:16],
        })
    return docs


# ── extraction engines ──────────────────────────────────────────────────────

def _extract_kggen(text: str, backend: dict, context: str) -> dict | None:
    """kg-gen path. Returns None on ANY failure (import OR runtime) so the
    caller falls back to the dependency-free HTTP path."""
    if os.environ.get("TEXT_KG_NO_KGGEN") == "1":
        return None
    try:
        from kg_gen import KGGen
        # Point LiteLLM (kg-gen's transport) at the shared OpenAI-compatible endpoint.
        os.environ.setdefault("OPENAI_API_KEY", backend["api_key"])
        os.environ.setdefault("OPENAI_API_BASE", backend["base_url"])
        os.environ.setdefault("OPENAI_BASE_URL", backend["base_url"])
        kg = KGGen(model=backend["litellm_model"], temperature=0.0, api_key=backend["api_key"])
        g = kg.generate(input_data=text, context=context)
        try:
            g = kg.cluster(g, context=context)   # merge synonymous entities/relations
        except Exception:
            pass
        entities = [{"name": e, "type": "concept"} for e in sorted(getattr(g, "entities", []) or [])]
        triples = [{"subject": s, "predicate": p, "object": o} for (s, p, o) in (getattr(g, "relations", []) or [])]
        return {"entities": entities, "triples": triples, "engine": "kg-gen"}
    except Exception as e:
        print(f"[text-kg] kg-gen path failed ({e}); using HTTP fallback", flush=True)
        return None


_SYS = (
    "You extract a knowledge graph from text about a web application and its QA notes. "
    "Respond with ONLY a single JSON object, no markdown fences, no commentary: "
    '{"entities":[{"name":str,"type":str}],"triples":[{"subject":str,"predicate":str,"object":str}]}. '
    "Prefer concrete app concepts: pages, routes, API endpoints, user actions, fields, rules."
)


def _coerce_json(content: str) -> dict:
    """Pull a JSON object out of a model reply that may include <think> blocks,
    markdown fences, or surrounding prose (reasoning models like MiniMax-M2.7)."""
    import re
    content = re.sub(r"<think>.*?</think>", "", content, flags=re.S | re.I)
    m = re.search(r"```(?:json)?\s*(\{.*\})\s*```", content, flags=re.S)
    if m:
        try:
            return json.loads(m.group(1))
        except Exception:
            pass
    # scan for the first balanced {...} that parses
    start = content.find("{")
    while start != -1:
        depth = 0
        for i in range(start, len(content)):
            c = content[i]
            if c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(content[start:i + 1])
                    except Exception:
                        break
        start = content.find("{", start + 1)
    return {"entities": [], "triples": []}


def _extract_http(text: str, backend: dict) -> dict:
    """Dependency-free fallback: POST to {base_url}/chat/completions."""
    body = json.dumps({
        "model": backend["model"],
        "temperature": 0.0,
        "messages": [
            {"role": "system", "content": _SYS},
            {"role": "user", "content": "Text:\n" + text},
        ],
    }).encode()
    req = urllib.request.Request(
        backend["base_url"].rstrip("/") + "/chat/completions",
        data=body,
        headers={"Authorization": f"Bearer {backend['api_key']}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=180) as resp:
        data = json.loads(resp.read())
    msg = data["choices"][0]["message"]
    content = msg.get("content") or msg.get("reasoning_content") or ""
    parsed = _coerce_json(content)
    return {
        "entities": parsed.get("entities", []),
        "triples": parsed.get("triples", []),
        "engine": "http-fallback",
    }


def extract_triples(text: str, backend: dict, context: str = "web app behavior & QA notes") -> dict:
    """Triples for one document — kg-gen if available, else HTTP fallback."""
    out = _extract_kggen(text, backend, context)
    if out is not None:
        return out
    return _extract_http(text, backend)


# ── main ─────────────────────────────────────────────────────────────────────

def main() -> int:
    src = os.environ.get("TEXT_KG_SOURCE")
    if not src:
        return _skip("TEXT_KG_SOURCE env var not set")
    root = Path(src).expanduser()
    if not root.exists():
        return _skip(f"TEXT_KG_SOURCE path does not exist: {root}")

    docs = _load_docs(root)
    if not docs:
        return _skip(f"no md/txt/pdf documents under {root}")

    backend = resolve_backend()
    print(f"[{SOURCE_ID}] backend={backend['backend']} model={backend['model']} "
          f"base_url={backend['base_url']} · {len(docs)} doc(s)", flush=True)

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    all_entities: dict[str, dict] = {}
    all_triples: list[dict] = []
    engines = set()
    t0 = time.time()

    for i, doc in enumerate(docs, 1):
        cache_file = CACHE_DIR / f"{doc['contentHash']}.json"
        if cache_file.exists():
            res = json.loads(cache_file.read_text())
            print(f"[{SOURCE_ID}] {i}/{len(docs)} {Path(doc['sourceFile']).name} — cache hit", flush=True)
        else:
            try:
                res = extract_triples(doc["text"], backend)
            except Exception as e:
                print(f"[{SOURCE_ID}] {i}/{len(docs)} {Path(doc['sourceFile']).name} — FAILED: {e}", flush=True)
                continue
            cache_file.write_text(json.dumps(res))
            print(f"[{SOURCE_ID}] {i}/{len(docs)} {Path(doc['sourceFile']).name} — "
                  f"{len(res['triples'])} triple(s) via {res['engine']}", flush=True)
        engines.add(res.get("engine", "?"))
        for e in res.get("entities", []):
            name = (e.get("name") or "").strip()
            if name:
                all_entities.setdefault(name.lower(), {"name": name, "type": e.get("type") or "concept"})
        for t in res.get("triples", []):
            if t.get("subject") and t.get("predicate") and t.get("object"):
                all_triples.append({**t, "sourceFile": doc["sourceFile"]})

    bundle = {
        "sourceId": SOURCE_ID,
        "discoveryTier": TIER,
        "confidence": CONFIDENCE,
        "extractedAt": _now(),
        "target": {"source": str(root)},
        "stats": {
            "documents": len(docs),
            "entities": len(all_entities),
            "triples": len(all_triples),
            "backend": backend["backend"],
            "model": backend["model"],
            "engines": sorted(engines),
            "durationMs": int((time.time() - t0) * 1000),
        },
        "facts": {
            "documents": [{k: d[k] for k in ("sourceFile", "contentHash", "chars")} for d in docs],
            "entities": list(all_entities.values()),
            "triples": all_triples,
        },
    }
    _write_bundle(bundle)
    print(f"[{SOURCE_ID}] wrote {BUNDLE_FILE.relative_to(REPO_ROOT)} "
          f"({len(all_entities)} entities, {len(all_triples)} triples)", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
