"""confluence — content-extractor source for Confluence pages. Fetches page
bodies via REST, hands text to the shared kg-gen engine, writes
output/confluence/bundle.json at tier docs_extracted.

Env (gate = CONFLUENCE_BASE_URL):
  CONFLUENCE_BASE_URL   e.g. https://yourco.atlassian.net   (required)
  CONFLUENCE_TOKEN      API token / PAT                     (required)
  CONFLUENCE_EMAIL      account email → Basic auth (Cloud); omit for Bearer PAT
  CONFLUENCE_SPACE      space key                           (optional)
  CONFLUENCE_MAX        max pages (default 50)
"""
from __future__ import annotations

import os
import sys
import urllib.parse
from pathlib import Path

_HERE = Path(__file__).resolve().parent
REPO_ROOT = _HERE.parents[2]
sys.path.insert(0, str(_HERE.parent / "_lib"))
from doc_kg import auth_header, http_get_json, strip_html, run_over_docs, write_skip  # noqa: E402

SOURCE_ID = "confluence"
OUT_DIR = REPO_ROOT / "output" / SOURCE_ID


def main() -> int:
    base = os.environ.get("CONFLUENCE_BASE_URL")
    token = os.environ.get("CONFLUENCE_TOKEN")
    if not base:
        return write_skip(OUT_DIR, SOURCE_ID, "CONFLUENCE_BASE_URL env var not set")
    if not token:
        return write_skip(OUT_DIR, SOURCE_ID, "CONFLUENCE_TOKEN env var not set")

    base = base.rstrip("/")
    headers = auth_header(token, os.environ.get("CONFLUENCE_EMAIL"))
    space = os.environ.get("CONFLUENCE_SPACE")
    limit = int(os.environ.get("CONFLUENCE_MAX", "50"))
    # Cloud REST: /wiki/rest/api/content ; Server: /rest/api/content. Try Cloud first.
    q = {"expand": "body.storage", "limit": str(limit)}
    if space:
        q["spaceKey"] = space
    qs = urllib.parse.urlencode(q)

    data = None
    for prefix in ("/wiki/rest/api/content", "/rest/api/content"):
        try:
            data = http_get_json(f"{base}{prefix}?{qs}", headers)
            break
        except Exception:
            continue
    if data is None:
        return write_skip(OUT_DIR, SOURCE_ID, "Confluence fetch failed (tried /wiki/rest and /rest)")

    docs = []
    for page in data.get("results", []):
        body = (((page.get("body") or {}).get("storage") or {}).get("value")) or ""
        text = " \n".join(filter(None, [page.get("title"), strip_html(body)]))
        if not text.strip():
            continue
        pid = page.get("id")
        docs.append({
            "id": pid,
            "title": page.get("title"),
            "url": f"{base}/wiki/spaces/{space or ''}/pages/{pid}",
            "text": text,
        })
    return run_over_docs(SOURCE_ID, OUT_DIR, docs, {"confluence": base, "space": space})


if __name__ == "__main__":
    sys.exit(main())
