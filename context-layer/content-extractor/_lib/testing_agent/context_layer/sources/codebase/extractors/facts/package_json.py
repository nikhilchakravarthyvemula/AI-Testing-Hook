"""`package.json` fact extractor.

Reads dependencies + devDependencies and emits:
  * `frontend_framework` — first recognised framework dep + its version
  * `build_tool` — vite, webpack, parcel, esbuild, turbopack
  * `test_framework` — jest, vitest, mocha, playwright, cypress
  * `package_manager` — pnpm | yarn | npm (heuristic: lockfile-aware
    extractors live elsewhere; here we just record `packageManager` field
    when present)
  * `framework_dep` — every recognised top-level framework dep that
    didn't win the `frontend_framework` slot (so consumers can see
    "this repo has both react and vue").
"""

from __future__ import annotations

import json
from pathlib import Path

from .....models import DiscoveryTier, FrameworkFact
from ...framework_port import Extractor, ExtractionOutput
from .._shared.provenance import provenance


# Order matters — first match wins for `frontend_framework`.
_FRAMEWORK_PRIORITY: tuple[tuple[str, str], ...] = (
    ("@angular/core", "angular"),
    ("next", "nextjs"),
    ("nuxt", "nuxt"),
    ("@sveltejs/kit", "sveltekit"),
    ("svelte", "svelte"),
    ("@remix-run/react", "remix"),
    ("astro", "astro"),
    ("@builder.io/qwik", "qwik"),
    ("@builder.io/qwik-city", "qwik"),
    ("solid-js", "solid"),
    ("@solidjs/start", "solidstart"),
    ("vue", "vue"),
    ("react", "react"),
    ("preact", "preact"),
    ("ember-source", "ember"),
)
_BUILD_TOOLS = ("vite", "webpack", "parcel", "esbuild", "turbopack", "rollup")
_TEST_FRAMEWORKS = (
    "vitest", "jest", "mocha", "ava", "playwright", "@playwright/test",
    "cypress", "@cypress/cli", "qunit",
)


class PackageJSONFactsExtractor:
    """Extracts framework / build / test facts from `package.json`."""

    name: str = "package_json_facts"
    discovery_tier: DiscoveryTier = DiscoveryTier.AST  # JSON parse is real
    file_globs: tuple[str, ...] = ("package.json",)

    def supports(self, file: Path, content: str) -> bool:
        # Top-level only; ignore vendored package.jsons inside dependencies.
        if file.name != "package.json":
            return False
        return "node_modules" not in file.parts

    def extract(self, file: Path, content: str) -> ExtractionOutput:
        try:
            doc = json.loads(content)
        except json.JSONDecodeError:
            return ExtractionOutput()
        if not isinstance(doc, dict):
            return ExtractionOutput()

        prov = provenance(
            source_file=file,
            content=content,
            discovery_tier=self.discovery_tier,
            extracted_by=self.name,
        )

        deps = _union_deps(doc)
        facts: list[FrameworkFact] = []

        # Pick a single primary frontend framework.
        primary: str | None = None
        for dep, name in _FRAMEWORK_PRIORITY:
            if dep in deps:
                if primary is None:
                    primary = name
                    facts.append(FrameworkFact(
                        kind="frontend_framework",
                        key=name,
                        value=deps[dep],
                        provenance=prov,
                    ))
                else:
                    # Co-installed frameworks — record as secondary.
                    facts.append(FrameworkFact(
                        kind="framework_dep",
                        key=name,
                        value=deps[dep],
                        provenance=prov,
                    ))

        for tool in _BUILD_TOOLS:
            if tool in deps:
                facts.append(FrameworkFact(
                    kind="build_tool", key=tool, value=deps[tool], provenance=prov,
                ))

        for tf in _TEST_FRAMEWORKS:
            if tf in deps:
                facts.append(FrameworkFact(
                    kind="test_framework", key=tf, value=deps[tf], provenance=prov,
                ))

        # `packageManager` field — npm@9 onward (Corepack).
        pm = doc.get("packageManager")
        if isinstance(pm, str) and "@" in pm:
            pm_name, _, pm_version = pm.partition("@")
            facts.append(FrameworkFact(
                kind="package_manager",
                key=pm_name,
                value=pm_version,
                provenance=prov,
            ))

        return ExtractionOutput(framework_facts=facts)


def _union_deps(doc: dict) -> dict[str, str]:
    out: dict[str, str] = {}
    for key in ("dependencies", "devDependencies", "peerDependencies"):
        section = doc.get(key)
        if isinstance(section, dict):
            out.update({str(k): str(v) for k, v in section.items()})
    return out
