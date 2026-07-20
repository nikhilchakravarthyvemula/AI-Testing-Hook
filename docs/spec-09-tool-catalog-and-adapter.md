# Spec 09 — Concrete tool catalog + SubprocessStageTool design (implements spec-05)

_Target file when approved: `/Users/superalign/Documents/testing Harness/docs/spec-09-tool-catalog-and-adapter.md`. Registry: `testo/harness/agentic_harness/registry/tool_registry.py`. Adapter: new `agentic_harness/tools/subprocess_stage.py`. Arg models: new `agentic_harness/registry/stage_args.py`. Summarizers: new `agentic_harness/tools/summarizers.py`._

## 1. Tool catalog (20 tools)

Consolidations applied: 27 code extractors → one `scan.code_extractors` with an `only` list; text-kg/jira/confluence → one `scan.docs_kg` with a `source` discriminator; ui/perf generation+execution → one tool each (`test.ui`, `test.perf`) with a `run` flag, since generation and execution are literally the same `gen.mjs` entrypoint toggled by `--no-run`/`--run`.

| name | layer / tags | runtime | kind | entrypoint | duration | requires |
|---|---|---|---|---|---|---|
| `scan.login` | context / auth, interactive, human-in-loop | node | subprocess | `context-layer/content-extractor/crawler/login-once.mjs` (cwd `context-layer/content-extractor/crawler`) | minutes | — |
| `scan.crawler` | context / live, playwright, llm-optional | node | subprocess | `context-layer/content-extractor/crawler/extract.mjs` | tens-of-minutes | `scan.login` (soft, only for SSO apps) |
| `scan.graphify` (alias `graphify`) | context / code, llm | python | **inproc** | `testo/harness/agentic_harness/tools/graphify/tool.py` (existing `GraphifyTool`) | minutes | — |
| `scan.framework_detect` | context / code, static | python | subprocess | `context-layer/content-extractor/framework-detector/extract.py` | seconds | — |
| `scan.code_extractors` | context / code, static | python | subprocess (multi-spawn) | `context-layer/content-extractor/code-extractors/<id>/extract.py` via `_lib/run_extractor.py` | seconds | `scan.framework_detect` (soft — only when `only` omitted) |
| `scan.db_schema` | context / code, db, llm-optional | python | subprocess | `context-layer/content-extractor/code-extractors/db-schema/extract.py` | seconds (tens-of-minutes when `llm=true`) | — |
| `scan.docs_kg` | context / docs, kg-gen, llm | python | subprocess (entrypoint-by-source) | `context-layer/content-extractor/{text-kg,jira,confluence}/extract.py` | minutes | — |
| `index.build` | context / index | node | subprocess | `context-layer/indexer/index.mjs` | seconds | `scan.crawler`, `scan.graphify`, `scan.code_extractors`, `generate.mock_data` (all soft — missing sources tolerated) |
| `index.verify_api_spec` | context / index, llm-optional, **BLOCKED** | node | subprocess | `context-layer/indexer/verify/api-spec-verify.mjs` (**missing from checkout**) | seconds | `index.build` |
| `view.graph` | context / view | node | subprocess | `context-layer/graph-viewer/index.mjs` | seconds | `index.build` |
| `generate.mock_data` | generation / deterministic | node | subprocess | `context-layer/content-extractor/mock-data/extract.mjs` | seconds | `scan.crawler` |
| `generate.api_tests` | generation, execution / api, curl | python | **inproc** (migrated skill) | `generation-layer/api-test-generator/skill.py` | minutes | `index.build` (hard: `apis.json`), `generate.mock_data` (soft) |
| `generate.openapi_tests` | generation, execution / api, spec-driven | node | subprocess | `context-layer/content-extractor/crawler/openapi-test-gen.mjs` | minutes | `scan.crawler` (hard: `reports/openapi.json` + raw NDJSON) |
| `test.ui` | generation, execution / ui, playwright | node | subprocess | `generation-layer/ui-test-generator/gen.mjs` | minutes (seconds when `run=false`) | scenario.json; `scan.login` (soft, storageState auth) |
| `test.perf` | generation, execution / perf, jmeter | node | subprocess | `generation-layer/perf-test-generator/gen.mjs` | seconds (minutes when `run=true`) | scenario.json; JMeter on PATH for `run=true` |
| `generate.e2e_flows` | generation / e2e, playwright | node | subprocess | `context-layer/content-extractor/crawler/generator/e2e.mjs` | seconds | `scan.crawler` (hard), `scan.graphify` (soft) |
| `execute.api_replay` | execution / api, replay | bash | subprocess | `output/generation/api-tests/run-all.sh` (generated artifact) | minutes | `generate.api_tests` (hard: suite exists) |
| `report.allure` | report / allure | node | subprocess | `generation-layer/allure-reporter/build.mjs` | minutes | any of the three execute outputs (hard: at least one) |
| `report.pdf` | report / pdf, playwright | node | subprocess | `generation-layer/pdf-reporter/build-pdf.mjs` | minutes | any of the three execute outputs (hard: at least one) |
| `pipeline.run` | orchestration / spine, deterministic, **BLOCKED until P3** | node | subprocess | `testo/pipeline.mjs` (to be rebuilt) | tens-of-minutes | wraps everything above |

Two rows register as `blocked=<reason>`: `index.verify_api_spec` (entrypoint absent from this checkout — verified, only its output artifact survives) and `pipeline.run` (entrypoint must be rebuilt in P3). Blocked rows appear in `testo tools list` with the reason but are excluded from `build_toolbelt`.

## 2. Widened `ToolDefinition` (agentic_harness/models.py)

All new fields defaulted, so the existing `graphify` row is untouched (`frozen + extra="forbid"` stays safe). `source_path`/`tool_class`/`args_class` become `Optional` (subprocess rows do not use them).

```python
class ToolDefinition(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    name: str
    summary: str = ""
    # inproc (existing) — optional now
    source_path: Optional[Path] = None
    tool_class: Optional[str] = None
    args_class: Optional[str] = None
    # spec-09 widening
    kind: Literal["inproc", "subprocess"] = "inproc"
    runtime: Literal["python", "node", "bash"] = "python"   # bash added for run-all.sh
    entrypoint: Optional[Path] = None          # repo-relative; subprocess only
    interpreter: Optional[Path] = None         # override; defaults per runtime (sec. 3)
    cwd: Optional[Path] = None                 # default: repo root
    args_model: Optional[str] = None           # class name in registry/stage_args.py
    adapter_class: str = "SubprocessStageTool" # or a named subclass (sec. 3.6)
    tags: tuple[str, ...] = ()
    layer: Literal["context","generation","execution","report","orchestration"] = "context"
    duration_class: Literal["seconds","minutes","tens-of-minutes"] = "seconds"
    requires: tuple[str, ...] = ()             # advisory tool-name DAG (sec. 6)
    precondition_paths: tuple[str, ...] = ()   # hard fail-fast artifact checks
    expected_outputs: tuple[str, ...] = ()     # freshness guard + outputPaths
    fixed_env: dict[str, str] = Field(default_factory=dict)
    blocked: Optional[str] = None              # reason row cannot run yet
```

`ToolRegistry.load()` branches: `kind=="inproc"` → existing importlib path unchanged; `kind=="subprocess"` → `args_cls = getattr(stage_args, defn.args_model)`, `tool = getattr(subprocess_stage, defn.adapter_class)(defn, args_cls)`, and raise `ToolSourceMissingError` early if `blocked` or the resolved entrypoint is missing (except `execute.api_replay`, whose entrypoint is a generated artifact checked at execute-time).

## 3. `SubprocessStageTool(BaseTool)` adapter spec

New file `testo/harness/agentic_harness/tools/subprocess_stage.py`. Lifts graphify's proven subprocess loop (`testo/harness/agentic_harness/tools/graphify/tool.py:212-420`): line-streamed stdout, heartbeat log, silence-kill, freshness guard.

**Construction.** `SubprocessStageTool(definition: ToolDefinition, args_cls: type[BaseModel])` — sets `self.name = definition.name`, `self.description = definition.summary + " Requires: " + ", ".join(definition.requires)`, `self.input_model = args_cls`. `to_api_schema()` inherited from `BaseTool` — nested pydantic validation preserved (this is the in-process path, per spec-05 §2.5).

**Arg→invocation mapping.** Every field in a stage-args model declares its wire form via `json_schema_extra`:

```python
def EnvF(env, default=None, **kw):  return Field(default, json_schema_extra={"env": env}, **kw)
def ArgF(arg, default=None, **kw):  return Field(default, json_schema_extra={"arg": arg}, **kw)      # --arg <value>
def FlagF(arg, default=False, invert=False, **kw):                                                    # bare --flag
    return Field(default, json_schema_extra={"flag": arg, "invert": invert}, **kw)
def PosF(pos, default=None, **kw):  return Field(default, json_schema_extra={"positional": pos}, **kw)
```

**Env assembly.** `env = {**os.environ, **definition.fixed_env, **field_env}` — overlay on the full process env so ambient secrets (`MINIMAX_API_KEY`, `.env` auto-loaded by `call_tool.py:_load_repo_env`) flow through untouched. Rules: `None` field → env var NOT set (ambient value survives); `bool` → `"1"`/`"0"`; everything else → `str(value)`. Additionally the adapter always sets `RESULT_JSON=<scratch>/result-<name>-<ts>.json` (sec. 3.4).

**Interpreter pick.** `runtime=="node"` → `NODE_BIN` env or `"node"`. `runtime=="python"` → `definition.interpreter` resolved against repo root; default `context-layer/content-extractor/_lib/.venv/bin/python`; graphify-family rows override to `context-layer/content-extractor/graphify/.venv/bin/python`. `runtime=="bash"` → `"bash"`. Missing interpreter/entrypoint → spawn-stage failure (below).

**cwd.** `definition.cwd or REPO_ROOT`. Only `scan.login` sets `cwd=context-layer/content-extractor/crawler` (matches `npm run login`); every other script derives `REPO_ROOT` itself.

**Timeout/heartbeat defaults per `duration_class`** (all overridable via a `timeout_s` field on any args model; `scan.db_schema llm=true` and `test.perf run=true` bump their class at execute-time):

| duration_class | heartbeat log | silence-kill (no stdout/stderr) | hard wall-clock |
|---|---|---|---|
| seconds | 15 s | 120 s | 600 s |
| minutes | 15 s | 900 s (graphify's `GRAPHIFY_TIMEOUT_S` default) | 3600 s |
| tens-of-minutes | 30 s | 1800 s | 7200 s |

Kill = `proc.kill()` + `TOOL_ERROR` with `warnings:["killed after <n>s silence"]`, `metadata.timeout=true` — same semantics as `tool.py:310-319`.

**3.4 stdout capture → result-summary contract.** Full stdout+stderr are streamed to `output/tool-runs/<name>-<ts>.log` (never returned to the agent). The summary the agent sees is resolved by this ladder:

1. **`RESULT_JSON` file** — if the file at the env path exists and parses to an object with an `ok` key, it IS the summary. This is the convention wrapped scripts adopt over time (write your summary there as your last act).
2. **Last-JSON-line** — scan captured stdout from the last line backwards; first line parsing to a JSON object with an `ok` key wins.
3. **Per-tool summarizer** — `SUMMARIZERS[name](definition, exit_code, stdout_tail)` in `agentic_harness/tools/summarizers.py` reads the tool's known artifact (e.g. `bundle.json.stats`, `index.json`, `results.json`, or parses `[run-all] passed=P failed=F skipped=S`) and builds the envelope. **This is the P0 reality for all 24 scripts** — no leaf is modified; ladder rungs 1–2 simply take precedence once scripts adopt them.
4. **Synthesized fallback** — `{ok: exit==0, counts:{}, outputPaths:[existing expected_outputs], warnings:["no result summary emitted"]}`.

**Freshness guard** (lifted from `graphify/extract.mjs:95-113`): record `run_start` before spawn; after exit, any `expected_outputs` path with `mtime < run_start` is stale → `ok=false`, `warnings:["stale output: <path>"]` — unless the invocation was an explicit reuse mode (`scan.crawler reuse_existing=true`).

**Large payloads** (spec-05 guardrail): any field flagged `json_schema_extra={"payload": True}` (e.g. `scenario_inline`, `exempt_patterns`) is written to a temp file under the scratchpad and passed as a path arg/env — never argv JSON.

**Error mapping → `InvocationStatus`** (via `ToolResult` then `ToolService`, honesty guard `NOT_INVOKED` untouched — it remains agent-mode-only):

| condition | ToolResult | InvocationStatus | call_tool exit |
|---|---|---|---|
| interpreter/entrypoint missing, spawn raise, blocked row | is_error, `metadata.stage="spawn"` | EXCEPTION | 2 |
| precondition_paths missing | is_error, actionable message ("run scan.crawler first") | TOOL_ERROR | 1 |
| exit 0, summary.ok true, outputs fresh | ok | SUCCESS | 0 |
| exit 0 but summary.ok false OR stale outputs | is_error | TOOL_ERROR | 1 |
| nonzero exit | is_error, stderr tail ≤2000 chars | TOOL_ERROR | 1 |
| silence/wall kill | is_error, timeout metadata | TOOL_ERROR | 1 |

Every invocation appends one redacted row to `output/tool-runs.jsonl` (name, runtime, kind, mode, status, durationMs, args_hash, freshness_ok); fields matching `*password*|*token*|*bearer*|*api_key*` are redacted everywhere.

**3.6 Named subclasses** (same file, referenced by `adapter_class`):
- `CodeExtractorsStageTool` — resolves `only` (explicit list, else `framework-detection.json.recommendedExtractors`, else fail with "run scan.framework_detect first"), validates ids against the 27-id catalog, spawns `<venv-py> code-extractors/<id>/extract.py` per id sequentially, aggregates per-extractor summaries + rolled-up totals.
- `DocsKgStageTool` — overrides `resolve_entrypoint(args)`: `source=="text"` → `text-kg/extract.py`, `"jira"` → `jira/extract.py`, `"confluence"` → `confluence/extract.py`.
- `ApiReplayStageTool` — execute-time check that `output/generation/api-tests/curls/` exists; parses stdout for the `[run-all]` tally.

## 4. Result-summary envelope (standard, per spec-05 §6 — agents never receive megabyte bundles)

```json
{ "ok": true, "tool": "scan.crawler", "counts": { }, "outputPaths": ["output/crawler/bundle.json"],
  "durationMs": 812345, "warnings": [], "error": null }
```

`ToolResult.output = json.dumps(envelope)`; `metadata = {"summary": envelope, "exit_code": n, "log_path": "output/tool-runs/<...>.log"}`. Per-tool `counts` (sourced exactly from the artifacts named in the extraction):

| tool | counts keys (source) |
|---|---|
| `scan.login` | cookies, localStorageKeys, origins, timedOut (saved storageState) |
| `scan.crawler` | endpoints, pages, clickEdges, origins, intentsAnnotated, budgetExhausted, authUsed (bundle.json.stats + pool summary) |
| `scan.graphify` | nodes, edges, hyperedges, stepExitCodes{extract,clusterOnly,tree}, stale (graph.json / extract.mjs:129-133) |
| `scan.framework_detect` | languages[], frameworks[], recommendedExtractors[] (framework-detection.json) |
| `scan.code_extractors` | per-id {endpoints, routes, interactions, formFields, frameworkFacts, filesScanned, errorCount} + totals (each `<id>.json` telemetry) |
| `scan.db_schema` | tablesFound, totalColumns, totalRelationships, frameworksSeen[], sources{deterministic,llm}, llmEnabled (bundle stats) |
| `scan.docs_kg` | source, docCount/issueCount/pageCount, entityCount, tripleCount, cacheHits, skippedReason (bundle.json) |
| `index.build` | totalTopics, totalItems, per-topic {count, sources, error?}, sourcesSeen[] (index.json) |
| `index.verify_api_spec` | candidates, kept, dropped, bodiesFilled, hasPublishedSpec (verification.json) |
| `view.graph` | per-graph {nodes, edges, bytes, skipped?} (graphs-index.json) |
| `generate.mock_data` | endpointsWithSamples, requestSamples, responseSamples, endpointsWithPathParams (bundle.stats) |
| `generate.api_tests` | `ApiTestGeneratorResult` verbatim: curls_generated, curls_executed, passed, failed, skipped, login_succeeded (skill.py:89 — already the right shape) |
| `generate.openapi_tests` | opsTestableInSpec, prepared, executed, passed, tokenCaptured (manifest+results) |
| `test.ui` | stepsPassed, stepsTotal, vitalsWithinThreshold, vitalsTotal, loginOk, screenshots (results.json stats) |
| `test.perf` | samplers, executed, jmeterOnPath, samples, errorRatePct, p50/p95/p99, checks[] (results.json) |
| `generate.e2e_flows` | handlersIndexed, flows, api, auth, forms, totalTests, scanStats (\_index.json) |
| `execute.api_replay` | passed, failed, skipped, failed_tests[{name,status}] (stdout tally) |
| `report.allure` | api, ui, perf, sourcesSeen[], served=false, reportHtmlPath (build.mjs counts) |
| `report.pdf` | sections{api,ui,perf}, api_passed/api_total, ui_steps_passed/total, sizeKb (build-pdf logs) |
| `pipeline.run` | stages[{id,ok,exitCode,durationMs}], aborted, artifacts{...} (run-<ISO>.json shape) |

## 5. Per-tool input models (`agentic_harness/registry/stage_args.py`)

`GraphifyArgs` and `ApiTestGeneratorArgs` are reused **verbatim** from their existing files (inproc rows) — not redefined here. All others:

```python
class LoginArgs(BaseModel):
    """INTERACTIVE — opens a visible browser; a human must complete CAPTCHA/MFA."""
    model_config = ConfigDict(extra="forbid")
    base_url:       str = EnvF("BASE_URL", ...)                          # required
    login_email:    Optional[str] = EnvF("LOGIN_EMAIL")                  # ambient fallback
    login_password: Optional[str] = EnvF("LOGIN_PASSWORD")               # redacted in logs
    seed_path:      str = EnvF("SEED_PATH", "/")
    max_wait_ms:    int = EnvF("LOGIN_MAX_WAIT_MS", 300000)
    url_stable_ms:  int = EnvF("LOGIN_URL_STABLE_MS", 3000)

class CrawlerArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    base_url:        str = EnvF("BASE_URL", ...)                         # required
    login_email:     Optional[str] = EnvF("LOGIN_EMAIL")
    login_password:  Optional[str] = EnvF("LOGIN_PASSWORD")
    seed_paths:      Optional[str] = EnvF("SEED_PATHS")                  # csv
    reuse_existing:  bool = EnvF("SKIP_CRAWL", False)                    # True → "1", reuse output/crawler/
    llm:             bool = EnvF("CRAWLER_LLM", True)                    # False → "0", heuristics only
    headless:        bool = EnvF("HEADLESS", True)
    workers:         int = EnvF("CRAWL_WORKERS", 8, ge=1)
    budget_ms:       int = EnvF("CRAWL_BUDGET_MS", 600000)
    max_pages:       int = EnvF("MAX_INTERACT_PAGES", 200)
    max_depth:       int = EnvF("MAX_INTERACT_DEPTH", 5)
    safe_click_max_per_page: Optional[int] = EnvF("SAFE_CLICK_MAX_PER_PAGE")   # None = exhaustive
    destructive_click_regex: Optional[str] = EnvF("DESTRUCTIVE_CLICK_REGEX")   # None = built-in
    post_crawl_urls: Optional[str] = EnvF("POST_CRAWL_URLS")             # csv, e.g. "/logout"
    out_dir_name:    str = EnvF("CRAWLER_OUT_DIR_NAME", "crawler")
    login_email_selector:    Optional[str] = EnvF("LOGIN_EMAIL_SELECTOR")
    login_password_selector: Optional[str] = EnvF("LOGIN_PASSWORD_SELECTOR")
    login_submit_selector:   Optional[str] = EnvF("LOGIN_SUBMIT_SELECTOR")
    # MINIMAX_* / auth-state.json are ambient env / on-disk artifacts — inherited, not fields.

class FrameworkDetectArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    target_codebase: str = EnvF("TARGET_CODEBASE", ...)                  # required
    llm: Literal["auto", "always", "never"] = ArgF("--llm", "auto")

class CodeExtractorsArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    target_codebase: str = EnvF("TARGET_CODEBASE", ...)                  # required
    only: Optional[list[str]] = Field(None, description=(
        "Extractor source_ids to run (catalog.py: angular-router, astro, conventions, "
        "csharp-aspnet, csproj, ember, java-jaxrs, java-spring, markdown-apispec, "
        "nextjs-app, nextjs-pages, nuxt, openapi-file, package-json, pom-xml, "
        "preact-router, pyproject, python-ast, python-django, python-fastapi, "
        "python-flask, qwik, react-router, remix, solidstart, sveltekit, vue-router). "
        "None = use framework-detection recommendation."))
    skip: list[str] = Field(default_factory=list)

class DbSchemaArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    target_codebase: str = EnvF("TARGET_CODEBASE", ...)                  # required
    llm: bool = EnvF("DBSCHEMA_LLM", False)   # True → tens-of-minutes agentic pass (Django/Prisma/TypeORM)

class DocsKgArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source: Literal["text", "jira", "confluence"]                        # required; picks entrypoint
    # text
    source_dir: Optional[str] = EnvF("TEXT_KG_SOURCE")                   # required when source=text
    max_chars:  int = EnvF("TEXT_KG_MAX_CHARS", 12000)
    # jira
    jira_base_url: Optional[str] = EnvF("JIRA_BASE_URL")                 # required when source=jira
    jira_token:    Optional[str] = EnvF("JIRA_TOKEN")                    # ambient fallback; redacted
    jira_email:    Optional[str] = EnvF("JIRA_EMAIL")
    jira_project:  Optional[str] = EnvF("JIRA_PROJECT")
    jira_jql:      Optional[str] = EnvF("JIRA_JQL")
    # confluence
    confluence_base_url: Optional[str] = EnvF("CONFLUENCE_BASE_URL")     # required when source=confluence
    confluence_token:    Optional[str] = EnvF("CONFLUENCE_TOKEN")        # ambient fallback; redacted
    confluence_email:    Optional[str] = EnvF("CONFLUENCE_EMAIL")
    confluence_space:    Optional[str] = EnvF("CONFLUENCE_SPACE")
    max_items: int = 50   # → JIRA_MAX or CONFLUENCE_MAX per source (subclass maps)
    backend: Optional[str] = EnvF("TEXT_KG_BACKEND")                     # minimax|openai|kimi|ollama
    # @model_validator: per-source gate field (source_dir / jira_base_url / confluence_base_url)
    # must be set OR present in ambient env.

class IndexBuildArgs(BaseModel):        # no inputs — pure file→file over output/
    model_config = ConfigDict(extra="forbid")

class VerifyApiSpecArgs(BaseModel):     # row is blocked; shape reconstructed from artifact
    model_config = ConfigDict(extra="forbid")
    api_spec_json: str = "output/indexed_output/api-spec.json"
    llm: bool = EnvF("CRAWLER_LLM", True)   # UNCONFIRMED — re-verify when entrypoint restored

class GraphViewArgs(BaseModel):         # no inputs
    model_config = ConfigDict(extra="forbid")

class MockDataArgs(BaseModel):          # no inputs — deterministic file→file
    model_config = ConfigDict(extra="forbid")

class OpenapiTestsArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    execute:  bool = FlagF("--no-execute", True, invert=True)   # False emits --no-execute
    max_ops:  Optional[int] = ArgF("--max", ge=1)
    crawler_dir_name: str = EnvF("CRAWLER_OUT_DIR_NAME", "crawler")
    bearer:   Optional[str] = EnvF("TEST_BEARER")                # skips live token capture; redacted
    base_url: Optional[str] = EnvF("BASE_URL")

class UiTestArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    scenario: Optional[str] = PosF(0, description="Path to scenario.json")
    scenario_inline: Optional[dict] = Field(None, json_schema_extra={"payload": True},
        description="Inline scenario object; written to a temp file (temp-file guardrail).")
    run:            bool = FlagF("--no-run", True, invert=True)  # False = generate + node --check only
    base_url:       Optional[str] = ArgF("--url")
    output_dir:     str = ArgF("--output-dir", "output/generation/ui-tests")
    storage_state:  bool = FlagF("--storage-state", False)       # reuse output/crawler/auth-state.json
    login_email:    Optional[str] = EnvF("LOGIN_EMAIL")          # → child UI_LOGIN_EMAIL, never persisted
    login_password: Optional[str] = EnvF("LOGIN_PASSWORD")       # redacted
    # @model_validator: exactly one of scenario / scenario_inline.

class PerfTestArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    scenario: Optional[str] = PosF(0)
    scenario_inline: Optional[dict] = Field(None, json_schema_extra={"payload": True})
    run:        bool = FlagF("--run", False)     # True needs Java+JMeter on PATH; bumps duration to minutes
    token:      Optional[str] = ArgF("--token")  # Bearer JWT; falls back to ambient PERF_TOKEN; redacted
    base_url:   Optional[str] = ArgF("--url")
    output_dir: str = ArgF("--output-dir", "output/generation/perf-tests")

class E2eFlowsArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    target_codebase: Optional[str] = EnvF("TARGET_CODEBASE")     # auto-detected from graphify manifest if None
    graph_path: str = EnvF("GRAPHIFY_GRAPH", "output/graphify/graph.json")
    max_flows:  int = EnvF("E2E_MAX_FLOWS", 12)
    max_depth:  int = EnvF("E2E_MAX_DEPTH", 5)
    # NOTE: sibling generator.mjs wipes ALL of tests/ — deliberately NOT toolified in spec-09.

class ApiReplayArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    login_email:    Optional[str] = EnvF("LOGIN_EMAIL")     # _login.sh aborts if absent from env
    login_password: Optional[str] = EnvF("LOGIN_PASSWORD")  # redacted
    envfile:        Optional[str] = PosF(0, description="Optional .env sourced by run-all.sh")

class AllureArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mode: Literal["build", "generate"] = "generate"   # "generate" → --generate; --serve FORBIDDEN (blocks forever)
    results_dir: str = ArgF("--results-dir", "output/generation/allure-results")

class PdfArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    output: str = ArgF("--output", "output/generation/report.pdf")

class PipelineArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    url:      Optional[str] = ArgF("--url")
    codebase: Optional[str] = ArgF("--codebase")
    email:    Optional[str] = ArgF("--email")
    password: Optional[str] = ArgF("--pass")      # redacted
    sso:      bool = FlagF("--sso", False)        # triggers interactive scan.login first
    scenario: Optional[str] = ArgF("--scenario")
    execute:  bool = FlagF("--no-execute", True, invert=True)
    report:   Literal["allure", "pdf"] = ArgF("--report", "allure")
```

## 6. Registry rows (`REGISTERED_TOOLS`)

```python
REGISTERED_TOOLS: dict[str, ToolDefinition] = {
    # ── inproc (existing pattern) ──────────────────────────────────────────
    "scan.graphify": ToolDefinition(
        name="scan.graphify", kind="inproc", runtime="python", layer="context",
        source_path=Path("testo/harness/agentic_harness/tools/graphify/tool.py"),
        tool_class="GraphifyTool", args_class="GraphifyArgs",
        tags=("code", "llm"), duration_class="minutes",
        expected_outputs=("output/graphify/bundle.json",),
        summary="LLM-enriched semantic code graph (AST + relationships). Produces graph.json + HTML reports.",
    ),
    "generate.api_tests": ToolDefinition(
        name="generate.api_tests", kind="inproc", runtime="python", layer="generation",
        source_path=Path("generation-layer/api-test-generator/skill.py"),
        tool_class="ApiTestGeneratorSkill", args_class="ApiTestGeneratorArgs",   # ISkill.execute widened per spec-05
        tags=("api", "curl", "execute"), duration_class="minutes",
        requires=("index.build", "generate.mock_data"),
        precondition_paths=("output/indexed_output/apis.json",),
        expected_outputs=("output/generation/api-tests/results.json",
                          "output/generation/api-tests/report.md"),
        summary="Generate + (optionally) execute curl-based API tests from indexed APIs; session-safe exemptions built in.",
    ),
    # ── context / scan (subprocess) ────────────────────────────────────────
    "scan.login": ToolDefinition(
        name="scan.login", kind="subprocess", runtime="node", layer="context",
        entrypoint=Path("context-layer/content-extractor/crawler/login-once.mjs"), cwd=Path("context-layer/content-extractor/crawler"),
        args_model="LoginArgs", tags=("auth", "interactive", "human-in-loop"),
        duration_class="minutes",
        expected_outputs=("output/crawler/auth-state.json",),
        summary="INTERACTIVE one-time SSO/login capture in a visible browser (human completes CAPTCHA/MFA). "
                "Saves Playwright storageState reused by scan.crawler. Not runnable headless.",
    ),
    "scan.crawler": ToolDefinition(
        name="scan.crawler", kind="subprocess", runtime="node", layer="context",
        entrypoint=Path("context-layer/content-extractor/crawler/extract.mjs"),
        args_model="CrawlerArgs", tags=("live", "playwright", "llm-optional"),
        duration_class="tens-of-minutes", requires=("scan.login",),
        expected_outputs=("output/crawler/bundle.json", "output/crawler/data/routes.json",
                          "output/crawler/data/pages.json", "output/crawler/data/click-graph.json"),
        summary="Headless parallel-DFS crawl of a live web app + analysis + optional LLM intent annotation "
                "→ normalized source bundle. Auth-walled apps need scan.login first.",
    ),
    "scan.framework_detect": ToolDefinition(
        name="scan.framework_detect", kind="subprocess", runtime="python", layer="context",
        entrypoint=Path("context-layer/content-extractor/framework-detector/extract.py"),
        args_model="FrameworkDetectArgs", tags=("code", "static"), duration_class="seconds",
        expected_outputs=("output/code-extractors/framework-detection.json",),
        summary="Detect languages/frameworks in a codebase and recommend which code extractors to run.",
    ),
    "scan.code_extractors": ToolDefinition(
        name="scan.code_extractors", kind="subprocess", runtime="python", layer="context",
        entrypoint=Path("context-layer/content-extractor/code-extractors"),  # dir; subclass picks <id>/extract.py
        adapter_class="CodeExtractorsStageTool",
        args_model="CodeExtractorsArgs", tags=("code", "static"), duration_class="seconds",
        requires=("scan.framework_detect",),
        expected_outputs=("output/code-extractors",),
        summary="Run selected static framework extractors (27 available via 'only') "
                "→ per-source endpoint/route/interaction bundles.",
    ),
    "scan.db_schema": ToolDefinition(
        name="scan.db_schema", kind="subprocess", runtime="python", layer="context",
        entrypoint=Path("context-layer/content-extractor/code-extractors/db-schema/extract.py"),
        args_model="DbSchemaArgs", tags=("code", "db", "llm-optional"), duration_class="seconds",
        expected_outputs=("output/db-schema/bundle.json",),
        summary="Extract DB table schemas (deterministic SQLAlchemy AST; llm=true adds a slow agentic "
                "pass for Django/Prisma/TypeORM/raw SQL).",
    ),
    "scan.docs_kg": ToolDefinition(
        name="scan.docs_kg", kind="subprocess", runtime="python", layer="context",
        entrypoint=Path("context-layer/content-extractor/text-kg/extract.py"),  # default; subclass switches
        adapter_class="DocsKgStageTool",
        args_model="DocsKgArgs", tags=("docs", "kg-gen", "llm"), duration_class="minutes",
        summary="Build a knowledge graph (entities + triples) from local docs, Jira issues, or Confluence "
                "pages (source=text|jira|confluence). Content-hash cached.",
    ),
    # ── index / view ───────────────────────────────────────────────────────
    "index.build": ToolDefinition(
        name="index.build", kind="subprocess", runtime="node", layer="context",
        entrypoint=Path("context-layer/indexer/index.mjs"),
        args_model="IndexBuildArgs", tags=("index",), duration_class="seconds",
        requires=("scan.crawler", "scan.graphify", "scan.code_extractors", "generate.mock_data"),
        expected_outputs=("output/indexed_output/index.json",),
        summary="Merge all extractor outputs under output/ into 12 per-topic indices. Missing sources tolerated.",
    ),
    "index.verify_api_spec": ToolDefinition(
        name="index.verify_api_spec", kind="subprocess", runtime="node", layer="context",
        entrypoint=Path("context-layer/indexer/verify/api-spec-verify.mjs"),
        args_model="VerifyApiSpecArgs", tags=("index", "llm-optional"), duration_class="seconds",
        requires=("index.build",),
        blocked="entrypoint missing from this checkout — restore/locate api-spec-verify.mjs, "
                "then re-verify the reconstructed inputs before unblocking",
        summary="Verify/reconcile the indexed API spec (keep/drop endpoints, fill request bodies).",
    ),
    "view.graph": ToolDefinition(
        name="view.graph", kind="subprocess", runtime="node", layer="context",
        entrypoint=Path("context-layer/graph-viewer/index.mjs"),
        args_model="GraphViewArgs", tags=("view",), duration_class="seconds",
        requires=("index.build",),
        expected_outputs=("output/indexed_output/graphs/graphs-index.json",),
        summary="Render indexed click-graph/ui-routes as standalone interactive HTML.",
    ),
    # ── generation ─────────────────────────────────────────────────────────
    "generate.mock_data": ToolDefinition(
        name="generate.mock_data", kind="subprocess", runtime="node", layer="generation",
        entrypoint=Path("context-layer/content-extractor/mock-data/extract.mjs"),
        args_model="MockDataArgs", tags=("deterministic",), duration_class="seconds",
        requires=("scan.crawler",),
        expected_outputs=("output/mock-data/bundle.json",),
        summary="Distil real request/response samples from the crawl into per-endpoint mock data "
                "(feeds api-test body synthesis + the indexer).",
    ),
    "generate.openapi_tests": ToolDefinition(
        name="generate.openapi_tests", kind="subprocess", runtime="node", layer="generation",
        entrypoint=Path("context-layer/content-extractor/crawler/openapi-test-gen.mjs"),
        args_model="OpenapiTestsArgs", tags=("api", "spec-driven", "execute"), duration_class="minutes",
        requires=("scan.crawler",),
        precondition_paths=("output/crawler/reports/openapi.json",),
        expected_outputs=("output/generation/openapi-tests/manifest.json",),
        summary="Spec-driven API tests: replay one real captured request per OpenAPI operation with a "
                "fresh token; PASS/FAIL vs documented status. Wipes its output dir each run.",
    ),
    "test.ui": ToolDefinition(
        name="test.ui", kind="subprocess", runtime="node", layer="generation",
        entrypoint=Path("generation-layer/ui-test-generator/gen.mjs"),
        args_model="UiTestArgs", tags=("ui", "playwright", "generate", "execute"),
        duration_class="minutes",
        expected_outputs=("output/generation/ui-tests/results.json",),
        summary="scenario.json → standalone Playwright UI test; run=true executes it headless with "
                "Web Vitals + screenshots; run=false generates + syntax-checks only.",
    ),
    "test.perf": ToolDefinition(
        name="test.perf", kind="subprocess", runtime="node", layer="generation",
        entrypoint=Path("generation-layer/perf-test-generator/gen.mjs"),
        args_model="PerfTestArgs", tags=("perf", "jmeter", "generate", "execute"),
        duration_class="seconds",   # adapter bumps to minutes when run=true
        expected_outputs=("output/generation/perf-tests/results.json",
                          "output/generation/perf-tests/plan.jmx"),
        summary="scenario.perf.httpFlow → JMeter plan.jmx (+ runner scripts); run=true executes the load "
                "test (needs Java+JMeter on PATH) and reports p50/p95/p99 + error-rate checks.",
    ),
    "generate.e2e_flows": ToolDefinition(
        name="generate.e2e_flows", kind="subprocess", runtime="node", layer="generation",
        entrypoint=Path("context-layer/content-extractor/crawler/generator/e2e.mjs"),
        args_model="E2eFlowsArgs", tags=("e2e", "playwright"), duration_class="seconds",
        requires=("scan.crawler", "scan.graphify"),
        precondition_paths=("output/crawler/data/click-graph.json", "output/crawler/data/routes.json"),
        expected_outputs=("tests/e2e/_index.json",),
        summary="Generate a 4-category Playwright e2e suite (flows/api/auth/forms) from crawl data + "
                "graphify handler map. Wipes tests/e2e/ subdirs each run.",
    ),
    # ── execution / report ─────────────────────────────────────────────────
    "execute.api_replay": ToolDefinition(
        name="execute.api_replay", kind="subprocess", runtime="bash", layer="execution",
        entrypoint=Path("output/generation/api-tests/run-all.sh"),   # generated artifact; checked at execute-time
        adapter_class="ApiReplayStageTool",
        args_model="ApiReplayArgs", tags=("api", "replay"), duration_class="minutes",
        requires=("generate.api_tests",),
        precondition_paths=("output/generation/api-tests/curls",),
        summary="Re-run the previously generated curl API suite (fresh login, no re-crawl/re-generate). "
                "Session-mutating endpoints were never emitted, so replay is safe.",
    ),
    "report.allure": ToolDefinition(
        name="report.allure", kind="subprocess", runtime="node", layer="report",
        entrypoint=Path("generation-layer/allure-reporter/build.mjs"),
        args_model="AllureArgs", tags=("report", "allure"), duration_class="minutes",
        requires=("generate.api_tests", "test.ui", "test.perf"),   # any-of, enforced by the script itself
        expected_outputs=("output/generation/allure-results",),
        summary="Consolidate API+UI+Perf results into an Allure result set; mode=generate renders static "
                "HTML (needs Allure CLI + Java). --serve is intentionally not exposed.",
    ),
    "report.pdf": ToolDefinition(
        name="report.pdf", kind="subprocess", runtime="node", layer="report",
        entrypoint=Path("generation-layer/pdf-reporter/build-pdf.mjs"),
        args_model="PdfArgs", tags=("report", "pdf", "playwright"), duration_class="minutes",
        requires=("generate.api_tests", "test.ui", "test.perf"),   # any-of
        expected_outputs=("output/generation/report.pdf",),
        summary="One shareable A4 PDF consolidating API+UI+Perf results (headless chromium page.pdf; "
                "no Allure/Java needed).",
    ),
    # ── orchestration ──────────────────────────────────────────────────────
    "pipeline.run": ToolDefinition(
        name="pipeline.run", kind="subprocess", runtime="node", layer="orchestration",
        entrypoint=Path("testo/pipeline.mjs"),
        args_model="PipelineArgs", tags=("spine", "deterministic"), duration_class="tens-of-minutes",
        blocked="entrypoint must be rebuilt (P3) — historical orchestration-layer/pipeline.mjs exists "
                "only in commit d413553",
        expected_outputs=("output/orchestration",),
        summary="Deterministic full spine: scan → generate → execute → report, no LLM in the loop. "
                "Writes output/orchestration/run-<ISO>.json stage table.",
    ),
}
REGISTERED_TOOLS["graphify"] = REGISTERED_TOOLS["scan.graphify"]   # back-compat alias
```

Interpreter defaults applied by the adapter (not per-row noise): python rows under `context-layer/` → `context-layer/content-extractor/_lib/.venv/bin/python`; python rows elsewhere (graphify, api-test skill) → `context-layer/content-extractor/graphify/.venv/bin/python`.

## 7. Dependency / ordering metadata

- **`requires: tuple[str,...]`** — advisory tool-name DAG. Surfaced three ways: appended to each tool's `description` ("Requires: scan.crawler, scan.graphify") so the LLM plans order; emitted in `testo tools list` → `output/tool-manifest.json` as a `requires` edge list; used by nothing at runtime (no hidden auto-execution — the agent or the spine decides).
- **`precondition_paths: tuple[str,...]`** — hard, fail-fast: adapter checks existence before spawn and returns `TOOL_ERROR` with an actionable "run <producer> first" message (producer resolved by matching the path against other rows' `expected_outputs`). This preserves each leaf's existing behavior (e.g. `apis.json` missing → skill error) but fails cheaply and with a machine-actionable hint.
- **What stays deterministic:** `pipeline.run` (and today's `testo scan` / `scan.mjs` / `run.mjs`) encode the canonical order `scan.login? → scan.crawler ∥ (scan.framework_detect → scan.code_extractors) ∥ scan.graphify ∥ scan.db_schema → generate.mock_data → index.build → view.graph → generate.* → execute.* → report.*` with **no LLM** — the spine is kept and wrapped, never re-derived by an agent (spec-05 §2.4). The DAG metadata exists only so `--agent` / `testo ask` runs can plan; the flag-off path never consults it.

## 8. Implementation phases

| phase | days | scope | verification (each phase also re-runs the golden-output guard) |
|---|---|---|---|
| **P0 — adapter + 3 pilots** | 4 | Widen `ToolDefinition` (sec. 2); `SubprocessStageTool` + summarizer ladder + envelope + `tool-runs.jsonl`; registry `load()` branch; pilot rows: `scan.graphify` (already inproc — rename + alias), `scan.crawler`, `index.build`. Capture golden baseline: `testo scan` (no flags) + `generate api-tests` snapshot of `output/`. | `bin/call_tool.py scan.crawler --base_url http://localhost:3000` → SUCCESS envelope with counts from `bundle.json.stats`; same via `bin/call_tool.py scan.crawler --mode free-agent --prompt "crawl localhost:3000"` (and `testo ask`); kill-test (unreachable BASE_URL → TOOL_ERROR, not hang); `testo scan` byte-identical to baseline. |
| **P1 — rest of scan + index/view** | 4 | `scan.login`, `scan.framework_detect`, `scan.code_extractors` (`CodeExtractorsStageTool` multi-spawn), `scan.db_schema`, `scan.docs_kg` (`DocsKgStageTool`), `view.graph`; register `index.verify_api_spec` as blocked. Summarizers for each. | Each tool invoked via `call_tool.py` direct AND once via `testo ask` free-agent; `scan.code_extractors --only '["python-fastapi"]'` produces identical `<id>.json` to the raw `extract.py` run (diff); `scan.docs_kg` skip-gates return `ok:true, skipped:<reason>`; blocked row listed with reason, excluded from toolbelt; golden guard green. |
| **P2 — generation** | 4 | Migrate api-test skill row inproc (widen `ISkill.execute(args, context=None)`, per spec-05); `generate.mock_data`, `generate.openapi_tests`, `test.ui` / `test.perf` (generate mode: `run=false` default paths exercised), `generate.e2e_flows`. Temp-file guardrail live for `scenario_inline` / `exempt_patterns`. | `call_tool.py generate.api_tests --base_url ... --execute false` returns the `ApiTestGeneratorResult` envelope identical to the old `call_skill.py` run (field-level diff); `test.ui` with `scenario_inline` produces a `.ui.mjs` passing `node --check`; free-agent run generates api tests end-to-end from a prompt; golden guard incl. `generate api-tests` byte-identical. |
| **P3 — execution + reports + pipeline.run** | 5 | `test.ui run=true`, `test.perf run=true` (duration-class bump verified), `execute.api_replay` (`ApiReplayStageTool` stdout tally), `report.allure` (mode=generate only), `report.pdf`; rebuild `testo/pipeline.mjs` from the d413553 shape and unblock `pipeline.run`. | Full chain via `call_tool.py`: crawl→index→generate.api_tests→report.pdf, each returning envelopes only (assert no envelope > 8 KB); `execute.api_replay` tally matches run-all.sh stdout; `report.allure` never blocks (serve forbidden); `pipeline.run` via free-agent (`testo ask "test this app end to end"`) completes and writes `run-<ISO>.json`; flag-off `testo scan` still byte-identical to the P0 baseline. |

Total: ~17 working days. Risks carried from spec-05 §5 that this design lands early: the argv/large-payload guardrail (P0, in the adapter), venv/interpreter isolation (explicit `interpreter` defaults), determinism (golden guard gates every phase). Open item flagged for the parent: `index.verify_api_spec` inputs are reconstructed from its output artifact and must be re-verified when the missing `api-spec-verify.mjs` is restored.