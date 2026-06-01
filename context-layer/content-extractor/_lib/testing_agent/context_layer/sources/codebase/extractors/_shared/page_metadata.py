"""Page-metadata extraction — title, description, primary heading, Open Graph.

Two patterns recognised:

1. **HTML-style markup** — `<title>`, `<meta name="description">`,
   `<meta property="og:*">`, first `<h1>`. Works for any framework
   where markup appears in source.

2. **Next.js metadata export** — `export const metadata = { title: "...",
   description: "..." }` in a `page.tsx` / `layout.tsx`. Parsed via
   permissive regex; nested expressions / dynamic functions are ignored.

`ssg_hint` derivation (Next.js-specific):
  * `export const dynamic = "force-static"` → "static"
  * `export const dynamic = "force-dynamic"` → "dynamic"
  * `export const revalidate = N` → "isr"
  * Otherwise None (let the extractor leave it unset).
"""

from __future__ import annotations

import re
from typing import Literal

SSGHint = Literal["static", "dynamic", "isr", "client"]


# ── HTML / markup patterns ─────────────────────────────────────────────────


_TITLE_TAG_RE = re.compile(
    r"""<title\b[^>]*>(?P<text>[^<{]+?)</title>""",
    re.IGNORECASE | re.DOTALL,
)
_META_RE = re.compile(
    r"""<meta\b(?P<attrs>[^>]+?)/?>""",
    re.IGNORECASE | re.DOTALL,
)
_FIRST_H1_RE = re.compile(
    r"""<h1\b[^>]*>(?P<text>[^<{]+?)</h1>""",
    re.IGNORECASE | re.DOTALL,
)

# Next.js / Nuxt metadata export. Permissive — captures the object literal
# and we regex-extract title/description out of it.
_NEXT_METADATA_RE = re.compile(
    r"""export\s+const\s+metadata\s*[:=].*?\{(?P<body>.*?)\}""",
    re.DOTALL,
)
# Inside the metadata object body, the title/description fields.
_KV_STRING_RE = re.compile(
    r"""(?P<key>[A-Za-z_]+)\s*:\s*["'](?P<value>[^"']+)["']"""
)

_NEXT_DYNAMIC_RE = re.compile(
    r"""export\s+const\s+dynamic\s*=\s*["'](?P<v>force-static|force-dynamic|auto|error)["']"""
)
_NEXT_REVALIDATE_RE = re.compile(r"""export\s+const\s+revalidate\s*=\s*\d""")
_USE_CLIENT_RE = re.compile(r"""^['"]use client['"]\s*;?""")


def extract_page_metadata(content: str) -> dict[str, str | None]:
    """Return `{page_title, meta_description, primary_heading, og_*}`.

    Every key is present in the result; values are None when the
    extractor couldn't find them. Consumers can splat this dict directly
    into a `UIRoute(**meta, ...)` construction.
    """
    title = _first_clean_match(_TITLE_TAG_RE, content, "text")
    primary_heading = _first_clean_match(_FIRST_H1_RE, content, "text")
    meta_description, og_title, og_description, og_image = _parse_meta_tags(content)

    # Fall back to Next.js metadata export when HTML didn't match.
    if not title or not meta_description:
        next_meta = _parse_next_metadata_export(content)
        title = title or next_meta.get("title")
        meta_description = meta_description or next_meta.get("description")
        og_title = og_title or next_meta.get("openGraph_title")
        og_description = og_description or next_meta.get("openGraph_description")
        og_image = og_image or next_meta.get("openGraph_image")

    return {
        "page_title": title,
        "meta_description": meta_description,
        "primary_heading": primary_heading,
        "og_title": og_title,
        "og_description": og_description,
        "og_image": og_image,
    }


def extract_ssg_hint(content: str) -> SSGHint | None:
    """Next.js routing hints derived from top-level exports / directives."""
    # `'use client'` at the top of the file → fully client-side.
    head = content.lstrip()
    if _USE_CLIENT_RE.match(head):
        return "client"
    dyn = _NEXT_DYNAMIC_RE.search(content)
    if dyn:
        v = dyn.group("v")
        if v == "force-static":
            return "static"
        if v == "force-dynamic":
            return "dynamic"
    if _NEXT_REVALIDATE_RE.search(content):
        return "isr"
    return None


# ── helpers ────────────────────────────────────────────────────────────────


def _first_clean_match(
    pattern: re.Pattern[str], content: str, group: str
) -> str | None:
    for m in pattern.finditer(content):
        text = " ".join(m.group(group).split())
        # Skip JSX-templated content that slipped past the regex's `[^<{]` guard.
        if "{" in text or "}" in text:
            continue
        if not text:
            continue
        return text
    return None


def _parse_meta_tags(
    content: str,
) -> tuple[str | None, str | None, str | None, str | None]:
    """Walk all `<meta>` tags; return `(description, og:title, og:description, og:image)`."""
    description = og_title = og_description = og_image = None
    for match in _META_RE.finditer(content):
        attrs = _parse_meta_attrs(match.group("attrs"))
        name = (attrs.get("name") or "").lower()
        prop = (attrs.get("property") or "").lower()
        value = attrs.get("content")
        if not value:
            continue
        if name == "description" and not description:
            description = value
        elif prop == "og:title" and not og_title:
            og_title = value
        elif prop == "og:description" and not og_description:
            og_description = value
        elif prop == "og:image" and not og_image:
            og_image = value
    return description, og_title, og_description, og_image


_ATTR_RE = re.compile(
    r"""(?P<name>[A-Za-z_:][A-Za-z0-9_:\-]*)\s*=\s*(?:"(?P<dq>[^"]*)"|'(?P<sq>[^']*)')"""
)


def _parse_meta_attrs(blob: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for m in _ATTR_RE.finditer(blob):
        out[m.group("name")] = m.group("dq") if m.group("dq") is not None else m.group("sq")
    return out


def _parse_next_metadata_export(content: str) -> dict[str, str]:
    """Extract title / description / openGraph fields from `export const metadata`."""
    out: dict[str, str] = {}
    m = _NEXT_METADATA_RE.search(content)
    if not m:
        return out
    body = m.group("body")
    for kv in _KV_STRING_RE.finditer(body):
        key = kv.group("key")
        value = kv.group("value")
        # Map plain keys.
        if key in ("title", "description") and key not in out:
            out[key] = value
        # OpenGraph fields appear as `title`/`description` inside a nested
        # object; we capture both, the first hit wins. To detect "this
        # title is og:title", look for the nearest `openGraph:` keyword
        # before this position.
        before = body[: kv.start()]
        in_og = before.rfind("openGraph") > before.rfind("title:") - 1 and "openGraph" in before
        if in_og:
            og_key = f"openGraph_{key}"
            if og_key not in out:
                out[og_key] = value
    return out
