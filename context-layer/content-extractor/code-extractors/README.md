# code-extractors

Per-framework deterministic extractors. Each subfolder is one extractor;
the orchestrator runs the subset that matches frameworks detected by
`../framework-extractor/`.

## Layout

```
code-extractors/
├── code_extractors/        ← importable package (interfaces + catalog)
│   ├── interfaces.py       ICodeExtractor (Protocol)
│   ├── models.py           ExtractionBundle, ExtractorTelemetry
│   └── catalog.py          EXTRACTOR_CATALOG — what each extractor handles
│
├── python-ast/             hand-rolled FastAPI/Flask AST extractor
├── python-fastapi/         testing-agent port
├── python-flask/           ...
├── python-django/
├── java-spring/
├── java-jaxrs/
├── csharp-aspnet/
├── nextjs-app/
├── nextjs-pages/
├── react-router/
├── vue-router/
├── angular-router/
├── sveltekit/
├── nuxt/
├── remix/
├── ember/
├── qwik/
├── astro/
├── preact-router/
├── solidstart/
├── openapi-file/
├── markdown-apispec/
├── package-json/
├── pyproject/
├── pom-xml/
├── csproj/
└── conventions/
```

## How extractors get picked

1. The orchestrator runs `framework-extractor/` first when `--codebase`
   is set. That writes `output/sources/framework-detection.json` with
   a `recommendedExtractors` list.
2. The orchestrator reads that list and runs only matching extractors.
3. Toggle the auto-pick with env:
   * `ONLY=python-ast,python-fastapi` — override, run only these
   * `SKIP_FRAMEWORK_DETECTION=1` — run every extractor (legacy behaviour)
   * `SKIP=python-django` — drop a single extractor

## Adding a new extractor

1. Drop a folder under `code-extractors/<your-name>/` with an
   `extract.py` (thin shim that delegates to whatever class does the
   real work — see `python-fastapi/extract.py` as a template).
2. Add a row to `code_extractors/catalog.py:EXTRACTOR_CATALOG`:
   ```python
   "your-name": ExtractorMetadata(
       name="your-name",
       language="python",            # or typescript / java / ...
       frameworks=("your-framework",),
       file_extensions=(".py",),
       summary="One-line description.",
   ),
   ```
3. That's it — the orchestrator auto-discovers the folder and the
   framework-extractor reads the catalog to decide when to run it.

## Interface

Every extractor (whether a testing-agent port or hand-rolled) satisfies
`ICodeExtractor`:

```python
class ICodeExtractor(Protocol):
    name: str
    discovery_tier: str
    file_globs: tuple[str, ...]
    supported_frameworks: tuple[str, ...]

    def supports(self, file: Path, content: str) -> bool: ...
    def extract(self, file: Path, content: str) -> ExtractionBundle: ...
```

Wrappers that delegate to `testing_agent` framework extractors satisfy
this automatically — those classes already have the right shape.
