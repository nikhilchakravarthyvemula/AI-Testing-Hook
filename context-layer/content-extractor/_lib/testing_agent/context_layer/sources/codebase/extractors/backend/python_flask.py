"""Flask endpoint extractor.

Two route patterns:
  * `@app.route("/path", methods=["GET", "POST"])` — methods explicit
  * `@app.route("/path")` — defaults to GET (Flask's behaviour)
  * `@app.<method>("/path")` — shortcut for `@app.route(..., methods=[method])`
  * Blueprint variant: `@bp.route(...)` — same shapes, different object

We don't track Blueprint prefixes via `app.register_blueprint(bp, url_prefix=...)`
because that's cross-file resolution. Consumers reconcile.
"""

from __future__ import annotations

import re
from pathlib import Path

from .....models import APIEndpoint, DiscoveryTier, method_is_idempotent
from ...framework_port import Extractor, ExtractionOutput
from .._shared.backend_common import normalise_path_params
from .._shared.provenance import provenance


_FLASK_IMPORT_RE = re.compile(r"\bfrom\s+flask\b|\bimport\s+flask\b")

# @<obj>.route("path") with optional methods=[...] anywhere in the call.
_ROUTE_DECORATOR_RE = re.compile(
    r"""@\s*(?P<obj>[A-Za-z_][A-Za-z0-9_]*)\.route
        \s*\(\s*["'](?P<path>[^"']+)["']
        (?P<rest>[^)]*)
        \)
    """,
    re.VERBOSE,
)

# @<obj>.<method>("path") — Flask 2+ shortcut for the common verbs.
_METHOD_DECORATOR_RE = re.compile(
    r"""@\s*(?P<obj>[A-Za-z_][A-Za-z0-9_]*)\.(?P<method>get|post|put|patch|delete)
        \s*\(\s*["'](?P<path>[^"']+)["']
    """,
    re.VERBOSE,
)

_METHODS_KW_RE = re.compile(r"""methods\s*=\s*\[([^\]]*)\]""")
_QUOTED_RE = re.compile(r"""["']([A-Z]+)["']""")

_DEF_AFTER_DECORATOR_RE = re.compile(
    r"""(?:async\s+)?def\s+(?P<name>[A-Za-z_][A-Za-z0-9_]*)\s*\("""
)


class PythonFlaskExtractor:
    """Flask endpoint extraction. Tier=code_regex."""

    name: str = "python_flask"
    discovery_tier: DiscoveryTier = DiscoveryTier.CODE_REGEX
    file_globs: tuple[str, ...] = ("*.py",)

    def supports(self, file: Path, content: str) -> bool:
        return file.suffix == ".py" and bool(_FLASK_IMPORT_RE.search(content))

    def extract(self, file: Path, content: str) -> ExtractionOutput:
        endpoints: list[APIEndpoint] = []
        lines = content.splitlines()
        seen_positions: set[int] = set()

        for match in _ROUTE_DECORATOR_RE.finditer(content):
            seen_positions.add(match.start())
            path = normalise_path_params(match.group("path"))
            methods = _parse_methods(match.group("rest")) or ["GET"]
            line_start = content[:match.start()].count("\n") + 1
            handler = _find_following_handler(lines, line_start)

            for method in methods:
                endpoints.append(
                    APIEndpoint(
                        method=method,
                        path=path,
                        operation_id=handler,
                        idempotent_hint=method_is_idempotent(method),
                        provenance=provenance(
                            source_file=file,
                            content=content,
                            discovery_tier=self.discovery_tier,
                            extracted_by=self.name,
                            source_line_start=line_start,
                        ),
                    )
                )

        for match in _METHOD_DECORATOR_RE.finditer(content):
            if match.start() in seen_positions:
                continue
            method = match.group("method").upper()
            path = normalise_path_params(match.group("path"))
            line_start = content[:match.start()].count("\n") + 1
            handler = _find_following_handler(lines, line_start)
            endpoints.append(
                APIEndpoint(
                    method=method,
                    path=path,
                    operation_id=handler,
                    provenance=provenance(
                        source_file=file,
                        content=content,
                        discovery_tier=self.discovery_tier,
                        extracted_by=self.name,
                        source_line_start=line_start,
                    ),
                )
            )

        return ExtractionOutput(endpoints=endpoints)


def _parse_methods(call_rest: str) -> list[str]:
    """Pull the `methods=["GET", "POST"]` strings out of the rest of the call."""
    m = _METHODS_KW_RE.search(call_rest)
    if not m:
        return []
    return [s.upper() for s in _QUOTED_RE.findall(m.group(1))]


def _find_following_handler(lines: list[str], decorator_line: int) -> str | None:
    i = decorator_line
    while i < len(lines):
        stripped = lines[i].lstrip()
        if not stripped or stripped.startswith("#"):
            i += 1
            continue
        if stripped.startswith("@"):
            i += 1
            continue
        m = _DEF_AFTER_DECORATOR_RE.match(stripped)
        if m:
            return m.group("name")
        return None
    return None
