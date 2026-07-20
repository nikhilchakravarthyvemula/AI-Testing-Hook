"""EXTRACTOR_CATALOG — what each code-extractor handles.

The framework-detector uses this to decide which extractors to run
after detecting a codebase's languages/frameworks. Without the catalog
the orchestrator can't make a principled "this extractor applies" call.

Adding a new extractor:
  1. Drop a folder under code-extractors/<name>/extract.py
  2. Add a row here describing what it handles.

The catalog is data, not behaviour — keep it imports-free so it can
load instantly without pulling openharness / pydantic.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ExtractorMetadata:
    """Static description of one code-extractor.

    name                Folder name under code-extractors/. Must match
                        the wrapper's source_id.
    language            Primary language the extractor parses.
    frameworks          Framework ids this extractor handles. The
                        framework-detector matches against these.
    file_extensions     Hint for the framework-detector: if NONE of
                        these extensions are present in the target,
                        the extractor can be skipped without even
                        reading its supports() implementation.
    summary             One-liner shown in `testo scan --list-extractors`.
    """

    name: str
    language: str
    frameworks: tuple[str, ...]
    file_extensions: tuple[str, ...]
    summary: str


# Order doesn't matter — dict lookup by name.
EXTRACTOR_CATALOG: dict[str, ExtractorMetadata] = {
    # ── Backend (Python) ────────────────────────────────────────────────
    "python-ast": ExtractorMetadata(
        name="python-ast",
        language="python",
        frameworks=("fastapi", "flask"),
        file_extensions=(".py",),
        summary="Hand-rolled Python AST extractor — endpoints, classes, models, cross-file router prefixes.",
    ),
    # db-schema is special: it's a code-extractor (static SQLAlchemy AST +
    # opt-in LLM over ORM/migration/SQL files) but not framework-specific, so
    # it uses the `*any` wildcard — recommended whenever any language is
    # detected. Its own orchestrator (code-extractors/db-schema/extract.py)
    # runs two sub-extractors and writes output/db-schema/bundle.json (a
    # dedicated indexer slot), not the usual output/code-extractors/<id>.json.
    "db-schema": ExtractorMetadata(
        name="db-schema",
        language="sql",
        frameworks=("*any",),
        file_extensions=(".py", ".sql", ".prisma"),
        summary="Database schema from SQLAlchemy AST (+ opt-in LLM for Django/Prisma/TypeORM/raw SQL). Set DBSCHEMA_LLM=1 for the LLM pass.",
    ),

    "python-fastapi": ExtractorMetadata(
        name="python-fastapi", language="python",
        frameworks=("fastapi",), file_extensions=(".py",),
        summary="FastAPI endpoints via decorator AST scan (testing-agent port).",
    ),
    "python-flask": ExtractorMetadata(
        name="python-flask", language="python",
        frameworks=("flask",), file_extensions=(".py",),
        summary="Flask endpoints via decorator AST scan.",
    ),
    "python-django": ExtractorMetadata(
        name="python-django", language="python",
        frameworks=("django",), file_extensions=(".py",),
        summary="Django URLconf + ViewSet extraction.",
    ),

    # ── Backend (JVM) ───────────────────────────────────────────────────
    "java-spring": ExtractorMetadata(
        name="java-spring", language="java",
        frameworks=("spring", "spring-boot"), file_extensions=(".java",),
        summary="Spring @RequestMapping / @RestController endpoints.",
    ),
    "java-jaxrs": ExtractorMetadata(
        name="java-jaxrs", language="java",
        frameworks=("jaxrs",), file_extensions=(".java",),
        summary="JAX-RS @Path endpoints.",
    ),

    # ── Backend (.NET) ──────────────────────────────────────────────────
    "csharp-aspnet": ExtractorMetadata(
        name="csharp-aspnet", language="csharp",
        frameworks=("aspnet", "aspnet-core"), file_extensions=(".cs",),
        summary="ASP.NET MVC/Web API controllers.",
    ),

    # ── Frontend (React family) ─────────────────────────────────────────
    "nextjs-app": ExtractorMetadata(
        name="nextjs-app", language="typescript",
        frameworks=("nextjs",), file_extensions=(".ts", ".tsx", ".js", ".jsx"),
        summary="Next.js App Router routes + server actions + forms.",
    ),
    "nextjs-pages": ExtractorMetadata(
        name="nextjs-pages", language="typescript",
        frameworks=("nextjs",), file_extensions=(".ts", ".tsx", ".js", ".jsx"),
        summary="Next.js Pages Router routes.",
    ),
    "react-router": ExtractorMetadata(
        name="react-router", language="typescript",
        frameworks=("react",), file_extensions=(".ts", ".tsx", ".js", ".jsx"),
        summary="react-router <Route> declarations.",
    ),
    "preact-router": ExtractorMetadata(
        name="preact-router", language="typescript",
        frameworks=("preact",), file_extensions=(".ts", ".tsx", ".js", ".jsx"),
        summary="preact-router <Route> declarations.",
    ),
    "remix": ExtractorMetadata(
        name="remix", language="typescript",
        frameworks=("remix",), file_extensions=(".ts", ".tsx"),
        summary="Remix file-system routes.",
    ),

    # ── Frontend (Vue / Svelte / others) ────────────────────────────────
    "vue-router": ExtractorMetadata(
        name="vue-router", language="typescript",
        frameworks=("vue",), file_extensions=(".vue", ".ts", ".js"),
        summary="Vue Router route declarations.",
    ),
    "nuxt": ExtractorMetadata(
        name="nuxt", language="typescript",
        frameworks=("nuxt",), file_extensions=(".vue", ".ts"),
        summary="Nuxt file-system routes.",
    ),
    "sveltekit": ExtractorMetadata(
        name="sveltekit", language="typescript",
        frameworks=("sveltekit",), file_extensions=(".svelte", ".ts", ".js"),
        summary="SvelteKit file-system routes.",
    ),
    "angular-router": ExtractorMetadata(
        name="angular-router", language="typescript",
        frameworks=("angular",), file_extensions=(".ts",),
        summary="Angular RouterModule / loadChildren declarations.",
    ),
    "solidstart": ExtractorMetadata(
        name="solidstart", language="typescript",
        frameworks=("solidstart",), file_extensions=(".tsx", ".jsx", ".ts"),
        summary="SolidStart file-system routes.",
    ),
    "qwik": ExtractorMetadata(
        name="qwik", language="typescript",
        frameworks=("qwik",), file_extensions=(".tsx", ".ts"),
        summary="Qwik routes.",
    ),
    "astro": ExtractorMetadata(
        name="astro", language="typescript",
        frameworks=("astro",), file_extensions=(".astro",),
        summary="Astro file-system routes.",
    ),
    "ember": ExtractorMetadata(
        name="ember", language="javascript",
        frameworks=("ember",), file_extensions=(".js", ".ts"),
        summary="Ember router map declarations.",
    ),

    # ── Specs (API descriptions) ────────────────────────────────────────
    "openapi-file": ExtractorMetadata(
        name="openapi-file", language="yaml",
        frameworks=("openapi",), file_extensions=(".yaml", ".yml", ".json"),
        summary="OpenAPI/Swagger spec files.",
    ),
    "markdown-apispec": ExtractorMetadata(
        name="markdown-apispec", language="markdown",
        frameworks=("markdown-api",), file_extensions=(".md",),
        summary="API specs embedded in Markdown docs.",
    ),

    # ── Per-language manifest facts (not framework-specific) ────────────
    "package-json": ExtractorMetadata(
        name="package-json", language="javascript",
        frameworks=("*node",), file_extensions=("package.json",),
        summary="npm dependencies + scripts.",
    ),
    "pyproject": ExtractorMetadata(
        name="pyproject", language="python",
        frameworks=("*python",), file_extensions=("pyproject.toml",),
        summary="pyproject.toml dependencies + tooling config.",
    ),
    "pom-xml": ExtractorMetadata(
        name="pom-xml", language="java",
        frameworks=("*maven",), file_extensions=("pom.xml",),
        summary="Maven dependencies.",
    ),
    "csproj": ExtractorMetadata(
        name="csproj", language="csharp",
        frameworks=("*dotnet",), file_extensions=(".csproj",),
        summary=".csproj dependencies.",
    ),
    "conventions": ExtractorMetadata(
        name="conventions", language="multi",
        frameworks=("*conventions",),
        file_extensions=(".tsx", ".jsx", ".svelte", ".vue", ".astro"),
        summary="Detect naming + file-organisation conventions (testid attr, etc.).",
    ),
}


__all__ = ["EXTRACTOR_CATALOG", "ExtractorMetadata"]
