"""DeterministicFrameworkDetector — v1 detector, no LLM.

Signals it consumes (in order of weight):
  1. Manifest files in the repo root or one level down. Strong signal.
       pyproject.toml / setup.py            → python
       package.json (+ dependencies field)  → node + framework lookup
       pom.xml                              → java + maven
       *.csproj                             → csharp + dotnet
       Gemfile                              → ruby
       go.mod                               → go
  2. File extensions across the tree (bounded walk).
  3. Convention-based directory layout (app/ for next, pages/ for nextjs-pages).
  4. Lightweight import sniff on a small file sample (~20 files per language).

It does NOT execute any code, install dependencies, or call LLMs.
Runs in seconds on million-line repos.

Recommended-extractor resolution lives outside this class — the
orchestrator does it using EXTRACTOR_CATALOG + the detection result.
"""

from __future__ import annotations

import json
import re
import time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

from .models import (
    DetectedFramework,
    DetectedLanguage,
    DetectionSignal,
    FrameworkDetectionResult,
    SignalKind,
)


# ── language / extension table ────────────────────────────────────────────


_EXTENSION_TO_LANGUAGE: dict[str, str] = {
    ".py": "python",
    ".ts": "typescript", ".tsx": "typescript",
    ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
    ".vue": "typescript",
    ".svelte": "typescript",
    ".astro": "typescript",
    ".java": "java",
    ".kt": "kotlin", ".kts": "kotlin",
    ".cs": "csharp",
    ".rb": "ruby",
    ".go": "go",
    ".rs": "rust",
    ".php": "php",
    ".swift": "swift",
}


_MANIFEST_TO_LANGUAGE: dict[str, str] = {
    "pyproject.toml": "python",
    "setup.py": "python",
    "requirements.txt": "python",
    "package.json": "javascript",
    "pom.xml": "java",
    "build.gradle": "java",
    "build.gradle.kts": "kotlin",
    "Gemfile": "ruby",
    "go.mod": "go",
    "Cargo.toml": "rust",
    "composer.json": "php",
    "Package.swift": "swift",
}


# ── framework signal table ────────────────────────────────────────────────
#
# {framework_id: (language, signals_to_check)}
# `signals_to_check` is interpreted by the detector — currently:
#   "manifest_dep:<name>"  — package.json dep / pyproject dep / pom dependency
#   "import:<pattern>"     — regex against a sampled file's first 100 lines
#   "dir:<path>"           — path exists under the target

_FRAMEWORK_SIGNALS: dict[str, dict] = {
    # Python backends
    "fastapi": {"language": "python", "checks": ["manifest_dep:fastapi", "import:^\\s*(from|import)\\s+fastapi"]},
    "flask":   {"language": "python", "checks": ["manifest_dep:flask",   "import:^\\s*(from|import)\\s+flask"]},
    "django":  {"language": "python", "checks": ["manifest_dep:django",  "import:^\\s*(from|import)\\s+django",
                                                  "dir:manage.py"]},
    # Java backends
    "spring":      {"language": "java", "checks": ["manifest_dep:spring-boot-starter",
                                                    "import:^\\s*import\\s+org\\.springframework"]},
    "spring-boot": {"language": "java", "checks": ["manifest_dep:spring-boot-starter"]},
    "jaxrs":       {"language": "java", "checks": ["manifest_dep:javax.ws.rs",
                                                    "import:^\\s*import\\s+jakarta\\.ws\\.rs"]},
    # .NET
    "aspnet":      {"language": "csharp", "checks": ["import:^\\s*using\\s+Microsoft\\.AspNetCore"]},
    "aspnet-core": {"language": "csharp", "checks": ["import:^\\s*using\\s+Microsoft\\.AspNetCore"]},
    # Frontend
    "nextjs":      {"language": "typescript", "checks": ["manifest_dep:next",
                                                          "dir:next.config.js", "dir:next.config.mjs",
                                                          "dir:app/layout.tsx", "dir:pages/_app.tsx"]},
    "react":       {"language": "typescript", "checks": ["manifest_dep:react"]},
    "preact":      {"language": "typescript", "checks": ["manifest_dep:preact"]},
    "vue":         {"language": "typescript", "checks": ["manifest_dep:vue"]},
    "nuxt":        {"language": "typescript", "checks": ["manifest_dep:nuxt", "dir:nuxt.config.ts"]},
    "sveltekit":   {"language": "typescript", "checks": ["manifest_dep:@sveltejs/kit", "dir:svelte.config.js"]},
    "angular":     {"language": "typescript", "checks": ["manifest_dep:@angular/core", "dir:angular.json"]},
    "remix":       {"language": "typescript", "checks": ["manifest_dep:@remix-run/react"]},
    "solidstart":  {"language": "typescript", "checks": ["manifest_dep:@solidjs/start"]},
    "qwik":        {"language": "typescript", "checks": ["manifest_dep:@builder.io/qwik"]},
    "astro":       {"language": "typescript", "checks": ["manifest_dep:astro", "dir:astro.config.mjs"]},
    "ember":       {"language": "javascript", "checks": ["manifest_dep:ember-source"]},
    # Specs
    "openapi":     {"language": "yaml", "checks": ["dir:openapi.json", "dir:openapi.yaml",
                                                    "dir:api/openapi.json", "dir:swagger.yaml"]},
    # "markdown-api" is detected from presence of *.md with apispec markers — handled below.
}


# Dirs not worth walking.
_PRUNE_DIRS = frozenset({
    ".git", ".venv", "venv", "node_modules", "__pycache__",
    ".pytest_cache", ".mypy_cache", "dist", "build", "target",
    ".gradle", ".idea", ".vscode",
    ".next", ".turbo", "coverage", ".cache",
    "bin", "obj", "vendor", "out", "output",
})

_MAX_WALK_FILES = 50_000   # safety: don't enumerate a 10M-file monorepo
_IMPORT_SAMPLE_LINES = 100
_IMPORT_SAMPLE_PER_LANG = 20


# ── detector ──────────────────────────────────────────────────────────────


class DeterministicFrameworkDetector:
    """Implements `IFrameworkExtractor` using only filesystem signals."""

    name = "deterministic"
    confidence_floor = 0.30

    def detect(self, target: Path) -> FrameworkDetectionResult:
        """Walk the target, compute language + framework confidences, return result."""
        target = target.resolve()
        if not target.is_dir():
            raise ValueError(f"target is not a directory: {target}")

        started = time.monotonic()

        all_files = self._walk_bounded(target)
        manifest_files = self._find_manifests(target, all_files)
        manifest_deps = self._read_manifest_dependencies(manifest_files)

        languages = self._score_languages(all_files, manifest_files)
        frameworks = self._score_frameworks(target, all_files, manifest_deps)

        result = FrameworkDetectionResult(
            target=str(target),
            detector_name=self.name,
            detected_at=datetime.now(tz=timezone.utc),
            duration_ms=(time.monotonic() - started) * 1000,
            languages=languages,
            frameworks=frameworks,
            # recommended_extractors filled in by the orchestrator using
            # EXTRACTOR_CATALOG — the detector doesn't know about it.
            recommended_extractors=[],
        )
        return result

    # ── internals ─────────────────────────────────────────────────────────

    def _walk_bounded(self, target: Path) -> list[Path]:
        out: list[Path] = []
        for p in target.rglob("*"):
            if len(out) >= _MAX_WALK_FILES:
                break
            if any(part in _PRUNE_DIRS for part in p.parts):
                continue
            if p.is_file():
                out.append(p)
        return out

    def _find_manifests(self, target: Path, files: list[Path]) -> list[Path]:
        manifests = []
        for path in files:
            # Only treat as manifest if it's in root or one level deep.
            try:
                rel = path.relative_to(target)
            except ValueError:
                continue
            depth = len(rel.parts)
            if depth > 3:  # root/<repo>/manifest.toml is depth 1
                continue
            if path.name in _MANIFEST_TO_LANGUAGE:
                manifests.append(path)
            elif path.suffix == ".csproj":
                manifests.append(path)
        return manifests

    def _read_manifest_dependencies(self, manifests: list[Path]) -> set[str]:
        """Return the union of dep-names across recognised manifests.

        Best-effort — parses JSON cleanly; for TOML / XML uses simple
        substring scans (good enough for "is dependency X declared?").
        """
        deps: set[str] = set()
        for mp in manifests:
            try:
                text = mp.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue
            if mp.name == "package.json":
                try:
                    pkg = json.loads(text)
                except json.JSONDecodeError:
                    continue
                for k in ("dependencies", "devDependencies", "peerDependencies"):
                    deps.update(pkg.get(k) or {})
            elif mp.name == "pyproject.toml":
                # Very loose — extract anything that looks like a dep name from [tool.poetry.dependencies]
                # or [project] dependencies = [ "name>=..." ].
                deps.update(self._sniff_python_deps(text))
            elif mp.name == "requirements.txt":
                for line in text.splitlines():
                    name = re.split(r"[<>=!\s;]", line.strip(), maxsplit=1)[0]
                    if name and not name.startswith("#"):
                        deps.add(name.lower())
            elif mp.name == "pom.xml":
                deps.update(re.findall(r"<artifactId>\s*([^<]+?)\s*</artifactId>", text))
            elif mp.suffix == ".csproj":
                deps.update(re.findall(r'<PackageReference\s+Include="([^"]+)"', text))
        return {d.lower() for d in deps}

    @staticmethod
    def _sniff_python_deps(text: str) -> set[str]:
        names: set[str] = set()
        # quoted dep specs like "fastapi>=0.100"
        for m in re.finditer(r'["\']([a-zA-Z0-9_.-]+)\s*(?:[<>=!~]|$)', text):
            n = m.group(1).lower()
            if n and not n.startswith("--") and "/" not in n:
                names.add(n)
        return names

    def _score_languages(
        self,
        files: list[Path],
        manifest_files: list[Path],
    ) -> list[DetectedLanguage]:
        counts: dict[str, int] = defaultdict(int)
        for f in files:
            lang = _EXTENSION_TO_LANGUAGE.get(f.suffix.lower())
            if lang:
                counts[lang] += 1

        manifest_langs: dict[str, list[Path]] = defaultdict(list)
        for mp in manifest_files:
            lang = _MANIFEST_TO_LANGUAGE.get(mp.name) or (
                "csharp" if mp.suffix == ".csproj" else None
            )
            if lang:
                manifest_langs[lang].append(mp)

        langs: list[DetectedLanguage] = []
        for lang, file_count in counts.items():
            signals = [DetectionSignal(
                kind=SignalKind.FILE_EXTENSION,
                value=f"{file_count} files",
                weight=min(1.0, file_count / 20.0),  # 20+ files → max weight
            )]
            for mp in manifest_langs.get(lang, []):
                signals.append(DetectionSignal(
                    kind=SignalKind.MANIFEST_FILE,
                    value=mp.name,
                    weight=0.9,
                    source_file=str(mp),
                ))
            # Language confidence = highest single signal weight, capped.
            confidence = min(1.0, max(s.weight for s in signals))
            langs.append(DetectedLanguage(
                name=lang, file_count=file_count, signals=signals, confidence=confidence,
            ))

        langs.sort(key=lambda L: -L.confidence)
        return langs

    def _score_frameworks(
        self,
        target: Path,
        files: list[Path],
        manifest_deps: set[str],
    ) -> list[DetectedFramework]:
        frameworks: list[DetectedFramework] = []
        # Group files by language for import sniffing.
        by_lang: dict[str, list[Path]] = defaultdict(list)
        for f in files:
            lang = _EXTENSION_TO_LANGUAGE.get(f.suffix.lower())
            if lang:
                by_lang[lang].append(f)
        # Cap per-language sample to keep this fast.
        for lang in by_lang:
            by_lang[lang] = by_lang[lang][:_IMPORT_SAMPLE_PER_LANG]

        for fw_id, spec in _FRAMEWORK_SIGNALS.items():
            signals = self._collect_framework_signals(
                fw_id=fw_id, language=spec["language"],
                checks=spec["checks"], target=target,
                lang_sample=by_lang.get(spec["language"], []),
                manifest_deps=manifest_deps,
            )
            if not signals:
                continue
            # Framework confidence = max single signal (matches detector_confidence_floor).
            confidence = max(s.weight for s in signals)
            if confidence < self.confidence_floor:
                continue
            frameworks.append(DetectedFramework(
                name=fw_id, language=spec["language"],
                signals=signals, confidence=confidence,
            ))

        frameworks.sort(key=lambda F: -F.confidence)
        return frameworks

    def _collect_framework_signals(
        self,
        *,
        fw_id: str,
        language: str,
        checks: list[str],
        target: Path,
        lang_sample: list[Path],
        manifest_deps: set[str],
    ) -> list[DetectionSignal]:
        signals: list[DetectionSignal] = []
        for chk in checks:
            kind, _, value = chk.partition(":")
            if kind == "manifest_dep":
                dep = value.lower()
                if dep in manifest_deps or any(d.startswith(dep) for d in manifest_deps):
                    signals.append(DetectionSignal(
                        kind=SignalKind.MANIFEST_DEP, value=dep, weight=0.95,
                    ))
            elif kind == "dir":
                p = target / value
                if p.exists():
                    signals.append(DetectionSignal(
                        kind=SignalKind.CONFIG_FILE if p.is_file() else SignalKind.DIRECTORY_LAYOUT,
                        value=value, weight=0.75,
                        source_file=str(p),
                    ))
            elif kind == "import":
                pattern = re.compile(value, re.MULTILINE)
                hits = self._import_sniff_count(pattern, lang_sample)
                if hits:
                    signals.append(DetectionSignal(
                        kind=SignalKind.IMPORT_STATEMENT,
                        value=f"{hits} file(s) match {value!r}",
                        weight=min(0.85, 0.4 + 0.1 * hits),
                    ))
        return signals

    @staticmethod
    def _import_sniff_count(pattern: re.Pattern, files: Iterable[Path]) -> int:
        n = 0
        for f in files:
            try:
                with f.open("r", encoding="utf-8", errors="ignore") as fh:
                    head = "".join(line for _, line in zip(range(_IMPORT_SAMPLE_LINES), fh))
            except OSError:
                continue
            if pattern.search(head):
                n += 1
        return n


__all__ = ["DeterministicFrameworkDetector"]
