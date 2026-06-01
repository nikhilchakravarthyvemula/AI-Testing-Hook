"""Django URL conf extractor.

Detects routes in `urls.py` files via the `urlpatterns = [...]` list.
Patterns:

  * `path("users/", views.user_list, name="user-list")`            — Django 2+ `path()`
  * `path("users/<int:id>/", views.user_detail, name="user-detail")` — typed param
  * `re_path(r"^users/$", views.user_list)`                        — regex form
  * `url(r"^users/$", views.user_list)`                            — Django 1.x legacy

Method (GET/POST/etc.) isn't declared on the URL; it's the view's
concern. We default to GET and emit; consumers can correlate against
view definitions if they care.

Limitations (v1):
  * Class-based views aren't decomposed into per-method routes.
  * `include()` sub-routers are NOT followed — would require resolving
    the included module across files.
"""

from __future__ import annotations

import re
from pathlib import Path

from .....models import APIEndpoint, DiscoveryTier, method_is_idempotent
from ...framework_port import Extractor, ExtractionOutput
from .._shared.backend_common import normalise_path_params
from .._shared.provenance import provenance


_URLPATTERNS_RE = re.compile(r"\burlpatterns\s*=\s*\[")
_DJANGO_IMPORT_RE = re.compile(
    r"\bfrom\s+django\.urls\b|\bfrom\s+django\.conf\.urls\b"
)

# `path("path/", view, ...)` — handles both single and double quotes.
_PATH_CALL_RE = re.compile(
    r"""\bpath\s*\(\s*["'](?P<path>[^"']*)["']
        \s*,\s*(?P<view>[A-Za-z_][A-Za-z0-9_.]*)
    """,
    re.VERBOSE,
)
# `re_path(r"...", view, ...)` — strip leading `^` and trailing `$/?`.
_RE_PATH_CALL_RE = re.compile(
    r"""\bre_path\s*\(\s*r?["'](?P<path>[^"']*)["']
        \s*,\s*(?P<view>[A-Za-z_][A-Za-z0-9_.]*)
    """,
    re.VERBOSE,
)
# Legacy `url(r"...", view, ...)` — same as re_path.
_URL_CALL_RE = re.compile(
    r"""\burl\s*\(\s*r?["'](?P<path>[^"']*)["']
        \s*,\s*(?P<view>[A-Za-z_][A-Za-z0-9_.]*)
    """,
    re.VERBOSE,
)


class PythonDjangoExtractor:
    """Django URL conf extraction. Tier=code_regex."""

    name: str = "python_django"
    discovery_tier: DiscoveryTier = DiscoveryTier.CODE_REGEX
    file_globs: tuple[str, ...] = ("urls.py", "*urls*.py")

    def supports(self, file: Path, content: str) -> bool:
        if file.suffix != ".py":
            return False
        if not _URLPATTERNS_RE.search(content):
            return False
        return bool(_DJANGO_IMPORT_RE.search(content))

    def extract(self, file: Path, content: str) -> ExtractionOutput:
        endpoints: list[APIEndpoint] = []

        for match in _PATH_CALL_RE.finditer(content):
            endpoints.append(
                self._make_endpoint(file, content, match, kind="path")
            )
        for match in _RE_PATH_CALL_RE.finditer(content):
            endpoints.append(
                self._make_endpoint(file, content, match, kind="re_path")
            )
        for match in _URL_CALL_RE.finditer(content):
            endpoints.append(
                self._make_endpoint(file, content, match, kind="url")
            )

        return ExtractionOutput(endpoints=endpoints)

    def _make_endpoint(
        self, file: Path, content: str, match: re.Match[str], *, kind: str
    ) -> APIEndpoint:
        raw_path = match.group("path")
        # Django regex paths often have ^/$/? — strip them. Then add leading /.
        if kind in ("re_path", "url"):
            raw_path = raw_path.lstrip("^").rstrip("?").rstrip("$")
        path = normalise_path_params(raw_path)
        if not path.startswith("/"):
            path = "/" + path
        # Drop trailing slash (Django convention) for catalog uniformity.
        if path != "/" and path.endswith("/"):
            path = path[:-1]

        view_ref = match.group("view")
        # Take the last dotted segment as operation_id for readability.
        operation_id = view_ref.rsplit(".", 1)[-1]
        line_start = content[:match.start()].count("\n") + 1

        return APIEndpoint(
            method="GET",  # Django doesn't declare method at the URL conf level.
            path=path,
            operation_id=operation_id,
            idempotent_hint=method_is_idempotent("GET"),
            provenance=provenance(
                source_file=file,
                content=content,
                discovery_tier=self.discovery_tier,
                extracted_by=self.name,
                source_line_start=line_start,
            ),
        )
