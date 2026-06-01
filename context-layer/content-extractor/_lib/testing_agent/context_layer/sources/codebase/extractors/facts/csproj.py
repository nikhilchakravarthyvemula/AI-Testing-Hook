"""`.csproj` (and `.fsproj`/`.vbproj`) fact extractor.

Emits target framework (e.g. net8.0) and ASP.NET backend marker when
detected.
"""

from __future__ import annotations

import re
from pathlib import Path

from .....models import DiscoveryTier, FrameworkFact
from ...framework_port import Extractor, ExtractionOutput
from .._shared.provenance import provenance


_TARGET_FRAMEWORK_RE = re.compile(
    r"<TargetFramework>(?P<tfm>[^<]+)</TargetFramework>"
)
_TARGET_FRAMEWORKS_RE = re.compile(
    r"<TargetFrameworks>(?P<tfms>[^<]+)</TargetFrameworks>"
)
# ASP.NET marker: `<Project Sdk="Microsoft.NET.Sdk.Web">`.
_ASPNET_SDK_RE = re.compile(r"""Sdk\s*=\s*["']Microsoft\.NET\.Sdk\.Web["']""")
_PACKAGE_REFERENCE_RE = re.compile(
    r"""<PackageReference\s+Include\s*=\s*["'](?P<pkg>[^"']+)["']
        (?:\s+Version\s*=\s*["'](?P<version>[^"']+)["'])?
    """,
    re.VERBOSE,
)
_TEST_PACKAGES = ("xunit", "NUnit", "MSTest.TestFramework")


class CsprojFactsExtractor:
    """Facts from .csproj / .fsproj / .vbproj."""

    name: str = "csproj_facts"
    discovery_tier: DiscoveryTier = DiscoveryTier.CODE_REGEX
    file_globs: tuple[str, ...] = ("*.csproj", "*.fsproj", "*.vbproj")

    def supports(self, file: Path, content: str) -> bool:
        return "<Project" in content

    def extract(self, file: Path, content: str) -> ExtractionOutput:
        prov = provenance(
            source_file=file,
            content=content,
            discovery_tier=self.discovery_tier,
            extracted_by=self.name,
        )
        facts: list[FrameworkFact] = []

        m = _TARGET_FRAMEWORK_RE.search(content)
        if m:
            facts.append(FrameworkFact(
                kind="target_framework", key=m.group("tfm").strip(), provenance=prov,
            ))
        else:
            ms = _TARGET_FRAMEWORKS_RE.search(content)
            if ms:
                # Multi-targeting — first one wins, rest are co-targets.
                tfms = [t.strip() for t in ms.group("tfms").split(";") if t.strip()]
                for i, tfm in enumerate(tfms):
                    facts.append(FrameworkFact(
                        kind="target_framework" if i == 0 else "target_framework_alt",
                        key=tfm,
                        provenance=prov,
                    ))

        if _ASPNET_SDK_RE.search(content):
            facts.append(FrameworkFact(
                kind="backend_framework",
                key="aspnet",
                provenance=prov,
            ))

        for pkg_match in _PACKAGE_REFERENCE_RE.finditer(content):
            pkg = pkg_match.group("pkg")
            version = pkg_match.group("version")
            for tp in _TEST_PACKAGES:
                if pkg.lower() == tp.lower():
                    facts.append(FrameworkFact(
                        kind="test_framework", key=tp, value=version, provenance=prov,
                    ))

        return ExtractionOutput(framework_facts=facts)
