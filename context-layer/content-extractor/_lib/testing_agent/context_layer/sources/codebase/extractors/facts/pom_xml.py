"""Maven `pom.xml` fact extractor.

Emits Spring Boot version, Java backend dependencies, and build-tool facts.
We use regex rather than the `xml` module to keep the v1 implementation
minimal and resilient to namespace declarations / comments.
"""

from __future__ import annotations

import re
from pathlib import Path

from .....models import DiscoveryTier, FrameworkFact
from ...framework_port import Extractor, ExtractionOutput
from .._shared.provenance import provenance


_DEPENDENCY_RE = re.compile(
    r"""<dependency>\s*
        <groupId>(?P<group>[^<]+)</groupId>\s*
        <artifactId>(?P<artifact>[^<]+)</artifactId>
        (?:\s*<version>(?P<version>[^<]+)</version>)?
    """,
    re.VERBOSE | re.DOTALL,
)

# Map groupId/artifactId → emitted (kind, key).
_FRAMEWORK_DEPS: tuple[tuple[str, str, str, str], ...] = (
    ("org.springframework.boot", "spring-boot-starter-web", "backend_framework", "spring-boot"),
    ("org.springframework.boot", "spring-boot-starter", "backend_framework", "spring-boot"),
    ("javax.ws.rs", "javax.ws.rs-api", "backend_framework", "jaxrs"),
    ("jakarta.ws.rs", "jakarta.ws.rs-api", "backend_framework", "jaxrs"),
    ("org.glassfish.jersey.core", "jersey-server", "backend_framework", "jersey"),
)
_TEST_DEPS = ("junit", "testng", "spring-boot-starter-test")


class PomXMLFactsExtractor:
    """Facts from Maven `pom.xml`."""

    name: str = "pom_xml_facts"
    discovery_tier: DiscoveryTier = DiscoveryTier.CODE_REGEX
    file_globs: tuple[str, ...] = ("pom.xml",)

    def supports(self, file: Path, content: str) -> bool:
        return file.name == "pom.xml" and "<dependency>" in content

    def extract(self, file: Path, content: str) -> ExtractionOutput:
        prov = provenance(
            source_file=file,
            content=content,
            discovery_tier=self.discovery_tier,
            extracted_by=self.name,
        )

        facts: list[FrameworkFact] = [FrameworkFact(
            kind="build_tool", key="maven", provenance=prov,
        )]

        primary_emitted = False
        for match in _DEPENDENCY_RE.finditer(content):
            group = match.group("group").strip()
            artifact = match.group("artifact").strip()
            version = (match.group("version") or "").strip()

            for g, a, kind, label in _FRAMEWORK_DEPS:
                if group == g and artifact == a:
                    emit_kind = "backend_framework" if not primary_emitted else "framework_dep"
                    primary_emitted = primary_emitted or emit_kind == "backend_framework"
                    facts.append(FrameworkFact(
                        kind=emit_kind, key=label, value=version or None, provenance=prov,
                    ))

            if artifact in _TEST_DEPS:
                facts.append(FrameworkFact(
                    kind="test_framework", key=artifact, value=version or None, provenance=prov,
                ))

        return ExtractionOutput(framework_facts=facts)
