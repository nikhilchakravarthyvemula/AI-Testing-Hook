"""Shared helpers for backend HTTP framework extractors.

Backend frameworks differ enormously in syntax but converge on a few
patterns: a *base path* declared at module/class level, *method-level*
path fragments, and *path parameters* in some templating syntax. This
module factors out the cross-framework bits.
"""

from __future__ import annotations

import re


def join_paths(*segments: str) -> str:
    """Join URL path segments with exactly one `/` between them.

    `join_paths("/api", "users", "{id}")` → `"/api/users/{id}"`
    `join_paths("/api/", "/users")`       → `"/api/users"`
    `join_paths("", "/users")`            → `"/users"`
    `join_paths()`                         → `"/"`

    Always returns a leading `/`. Never a trailing `/` (except for the
    root). Empty segments are silently dropped.
    """
    cleaned = [s.strip("/") for s in segments if s and s.strip("/")]
    if not cleaned:
        return "/"
    return "/" + "/".join(cleaned)


# Common path-param syntaxes across frameworks:
#
#   FastAPI / Flask:   "/users/{id}"          (already canonical)
#   Spring / JAX-RS:   "/users/{id}"          (already canonical)
#   ASP.NET attribute: "/users/{id:int}"      (type suffix — strip)
#   Django:            "/users/<int:id>/"     (typed converter syntax)
#   Express-ish:       "/users/:id"           (colon prefix)
#
# Normalise everything to `{id}` so the catalog is uniform.

_DJANGO_PARAM_RE = re.compile(r"<(?:[a-zA-Z_]+:)?(?P<name>[a-zA-Z_][a-zA-Z0-9_]*)>")
_TYPED_BRACE_PARAM_RE = re.compile(r"\{(?P<name>[a-zA-Z_][a-zA-Z0-9_]*):[^}]*\}")
_COLON_PARAM_RE = re.compile(r":(?P<name>[a-zA-Z_][a-zA-Z0-9_]*)")


def normalise_path_params(path: str) -> str:
    """Convert framework-specific param syntax to canonical `{name}`.

    Idempotent: already-canonical paths pass through unchanged.
    """
    if not path:
        return path
    path = _DJANGO_PARAM_RE.sub(r"{\g<name>}", path)
    path = _TYPED_BRACE_PARAM_RE.sub(r"{\g<name>}", path)
    path = _COLON_PARAM_RE.sub(r"{\g<name>}", path)
    return path
