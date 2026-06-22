"""Shared helpers for doc-derived content-extractor sources (jira, confluence).

Reuses text-kg's extraction engine + the shared backend resolver, and gives
the REST connectors a common bundle writer, auth header builder, HTML-strip,
and content-hash cache — so jira/ and confluence/ stay tiny.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

_HERE = Path(__file__).resolve().parent
REPO_ROOT = _HERE.parents[2]            # _lib → content-extractor → context-layer → repo
sys.path.insert(0, str(_HERE))                       # llm_backend
sys.path.insert(0, str(_HERE.parent / "text-kg"))    # extract_triples
from llm_backend import resolve_backend              # noqa: E402
from extract import extract_triples                   # noqa: E402  (text-kg/extract.py)

TIER = "docs_extracted"
CONFIDENCE = 0.55


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def auth_header(token: str, email: str | None) -> dict:
    """Atlassian Cloud → Basic(email:token); Server/DC PAT → Bearer token."""
    if email:
        raw = base64.b64encode(f"{email}:{token}".encode()).decode()
        return {"Authorization": f"Basic {raw}"}
    return {"Authorization": f"Bearer {token}"}


def http_get_json(url: str, headers: dict) -> dict:
    req = urllib.request.Request(url, headers={**headers, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read())


def strip_html(html: str) -> str:
    text = re.sub(r"<[^>]+>", " ", html or "")
    text = re.sub(r"&[a-z]+;", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def write_bundle(out_dir: Path, source_id: str, target: dict, docs: list[dict],
                 entities: dict, triples: list[dict], engines: set, t0: float) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    bundle = {
        "sourceId": source_id,
        "discoveryTier": TIER,
        "confidence": CONFIDENCE,
        "extractedAt": now(),
        "target": target,
        "stats": {
            "documents": len(docs), "entities": len(entities), "triples": len(triples),
            "engines": sorted(engines), "durationMs": int((time.time() - t0) * 1000),
        },
        "facts": {
            "documents": [{k: d.get(k) for k in ("id", "title", "url", "contentHash")} for d in docs],
            "entities": list(entities.values()),
            "triples": triples,
        },
    }
    (out_dir / "bundle.json").write_text(json.dumps(bundle, indent=2))
    return out_dir / "bundle.json"


def write_skip(out_dir: Path, source_id: str, reason: str) -> int:
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "bundle.json").write_text(json.dumps({"sourceId": source_id, "skipped": reason, "extractedAt": now()}, indent=2))
    print(f"[{source_id}] skipped — {reason}", flush=True)
    return 0


def run_over_docs(source_id: str, out_dir: Path, docs: list[dict], target: dict) -> int:
    """docs = [{id, title, url, text}]. Extract triples (cached by content hash),
    merge, write the bundle. Shared by jira + confluence."""
    if not docs:
        return write_skip(out_dir, source_id, "no documents fetched")
    backend = resolve_backend()
    print(f"[{source_id}] backend={backend['backend']} model={backend['model']} · {len(docs)} doc(s)", flush=True)
    # Cache outside the bundle dir (survives the per-session output wipe).
    cache_dir = REPO_ROOT / "output" / ".kg-cache" / source_id
    cache_dir.mkdir(parents=True, exist_ok=True)

    entities: dict[str, dict] = {}
    triples: list[dict] = []
    engines: set = set()
    t0 = time.time()
    for i, d in enumerate(docs, 1):
        d["contentHash"] = hashlib.sha256((d.get("text") or "").encode("utf-8", "replace")).hexdigest()[:16]
        cache_file = cache_dir / f"{d['contentHash']}.json"
        if cache_file.exists():
            res = json.loads(cache_file.read_text())
        else:
            try:
                res = extract_triples(d.get("text", ""), backend)
            except Exception as e:
                print(f"[{source_id}] {i}/{len(docs)} {d.get('id')} — FAILED: {e}", flush=True)
                continue
            cache_file.write_text(json.dumps(res))
        engines.add(res.get("engine", "?"))
        for e in res.get("entities", []):
            name = (e.get("name") or "").strip()
            if name:
                entities.setdefault(name.lower(), {"name": name, "type": e.get("type") or "concept"})
        for t in res.get("triples", []):
            if t.get("subject") and t.get("predicate") and t.get("object"):
                triples.append({**t, "sourceDoc": d.get("id"), "url": d.get("url")})
        print(f"[{source_id}] {i}/{len(docs)} {d.get('id')} — {len(res.get('triples', []))} triple(s)", flush=True)

    path = write_bundle(out_dir, source_id, target, docs, entities, triples, engines, t0)
    print(f"[{source_id}] wrote {path.relative_to(REPO_ROOT)} ({len(entities)} entities, {len(triples)} triples)", flush=True)
    return 0
