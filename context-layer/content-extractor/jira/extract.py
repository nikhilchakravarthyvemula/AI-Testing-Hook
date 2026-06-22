"""jira — content-extractor source for Jira issues (acceptance criteria,
descriptions). Fetches via REST, hands text to the shared kg-gen engine,
writes output/jira/bundle.json at tier docs_extracted.

Env (gate = JIRA_BASE_URL):
  JIRA_BASE_URL    e.g. https://yourco.atlassian.net   (required)
  JIRA_TOKEN       API token / PAT                      (required)
  JIRA_EMAIL       account email → Basic auth (Cloud); omit for Bearer PAT
  JIRA_PROJECT     project key (else JIRA_JQL)          (optional)
  JIRA_JQL         explicit JQL (default: project=<key> ORDER BY updated DESC)
  JIRA_MAX         max issues (default 50)
"""
from __future__ import annotations

import os
import sys
import urllib.parse
from pathlib import Path

_HERE = Path(__file__).resolve().parent
REPO_ROOT = _HERE.parents[2]
sys.path.insert(0, str(_HERE.parent / "_lib"))
from doc_kg import auth_header, http_get_json, run_over_docs, write_skip  # noqa: E402

SOURCE_ID = "jira"
OUT_DIR = REPO_ROOT / "output" / SOURCE_ID


def _adf_to_text(node) -> str:
    """Flatten Atlassian Document Format (description as JSON) to plain text."""
    if isinstance(node, str):
        return node
    if isinstance(node, dict):
        if node.get("type") == "text":
            return node.get("text", "")
        return " ".join(_adf_to_text(c) for c in node.get("content", []) or [])
    if isinstance(node, list):
        return " ".join(_adf_to_text(c) for c in node)
    return ""


def main() -> int:
    base = os.environ.get("JIRA_BASE_URL")
    token = os.environ.get("JIRA_TOKEN")
    if not base:
        return write_skip(OUT_DIR, SOURCE_ID, "JIRA_BASE_URL env var not set")
    if not token:
        return write_skip(OUT_DIR, SOURCE_ID, "JIRA_TOKEN env var not set")

    base = base.rstrip("/")
    headers = auth_header(token, os.environ.get("JIRA_EMAIL"))
    jql = os.environ.get("JIRA_JQL")
    if not jql:
        proj = os.environ.get("JIRA_PROJECT")
        jql = f"project={proj} ORDER BY updated DESC" if proj else "ORDER BY updated DESC"
    max_results = int(os.environ.get("JIRA_MAX", "50"))
    url = (f"{base}/rest/api/3/search?jql={urllib.parse.quote(jql)}"
           f"&maxResults={max_results}&fields=summary,description,issuetype,status")

    try:
        data = http_get_json(url, headers)
    except Exception as e:
        return write_skip(OUT_DIR, SOURCE_ID, f"Jira fetch failed: {e}")

    docs = []
    for issue in data.get("issues", []):
        f = issue.get("fields", {}) or {}
        key = issue.get("key")
        text = " \n".join(filter(None, [
            f.get("summary"),
            _adf_to_text(f.get("description")),
        ]))
        if not text.strip():
            continue
        docs.append({
            "id": key,
            "title": f.get("summary"),
            "url": f"{base}/browse/{key}",
            "text": text,
        })
    return run_over_docs(SOURCE_ID, OUT_DIR, docs, {"jira": base, "jql": jql})


if __name__ == "__main__":
    sys.exit(main())
