"""Convention-detection extractor.

Sniffs which test-id attribute the codebase uses (`data-testid` vs
`data-test` vs `data-cy`) by counting occurrences across all the
frontend files the runner visits. Highest-count attribute wins; emit a
`test_id_attr` fact.

This extractor is special: it's invoked once per file (like the
others) but accumulates state across files. Because runner invocations
are stateless per call, we count via class state and emit on every
call — consumers should dedup on `(kind, key)`. The doc's "no
deduplication" stance applies; the final, highest-count fact is the
truth.

For v1 simplicity, we just emit the count-as-value on every JSX/Vue/
Svelte file. Consumers reconcile by picking the highest count.
"""

from __future__ import annotations

from pathlib import Path

from .....models import DiscoveryTier, FrameworkFact
from ...framework_port import Extractor, ExtractionOutput
from .._shared.provenance import provenance


_MARKUP_EXTS = frozenset({".tsx", ".jsx", ".svelte", ".vue", ".astro"})
_CANDIDATE_ATTRS = ("data-testid", "data-test", "data-cy", "data-qa")


class ConventionsExtractor:
    """Records candidate test-ID attribute counts per file.

    Emits one `test_id_attr_count` fact per attribute that appears in
    the file. Consumers aggregate by `key` and pick the highest count
    as the project's convention.
    """

    name: str = "conventions"
    discovery_tier: DiscoveryTier = DiscoveryTier.CODE_REGEX
    file_globs: tuple[str, ...] = ("*.tsx", "*.jsx", "*.svelte", "*.vue", "*.astro")

    def supports(self, file: Path, content: str) -> bool:
        if file.suffix not in _MARKUP_EXTS:
            return False
        return any(attr in content for attr in _CANDIDATE_ATTRS)

    def extract(self, file: Path, content: str) -> ExtractionOutput:
        prov = provenance(
            source_file=file,
            content=content,
            discovery_tier=self.discovery_tier,
            extracted_by=self.name,
        )
        facts: list[FrameworkFact] = []
        for attr in _CANDIDATE_ATTRS:
            count = content.count(attr)
            if count:
                facts.append(FrameworkFact(
                    kind="test_id_attr_count",
                    key=attr,
                    value=str(count),
                    provenance=prov,
                ))
        return ExtractionOutput(framework_facts=facts)
