# Spec 10 — Output storage skills (Postgres · graph DB · storage bucket)

_Target: `docs/spec-10-output-storage-skills.md`. Skills: new `testo/output-store/{relational_skill.py, graph_skill.py, artifacts_skill.py, lib/}`. Registry: `testo/skill-register/skill_register/registry/skill_registry.py` (`REGISTERED_SKILLS`). Invocation: `testo/skill-register/bin/call_skill.py <skill> --mode direct`._

> **TL;DR** — Three skills walk `output/` after a pipeline run and project it into three
> stores, all keyed by one shared `run_id`: **`store-relational`** (Postgres: runs,
> executions, test_results, source facts), **`store-graph`** (graphify graph + click-graph
> + text-kg triples into a property graph — DB choice deferred, trade-off in §6), and
> **`store-artifacts`** (screenshots / reports / traces / curls to a GCS bucket).
> JSON under `output/` remains the source of truth; the stores are queryable projections.
> Phase 0 ports text-kg (kg-gen) from the `feature_output_indexder` branch.
> This replaces the deleted `knowledge-base/` concept (§0).

---

## 0. Background — knowledge-base removal (record of what changed)

The `knowledge-base/` folder was designed as a "single source of truth" merging every
source bundle into `output/knowledge.json`. In practice only `schema.mjs` (the
`DiscoveryTier` enum + `provenance()`/`confidenceForTier()` helpers) was ever built —
`build.mjs`, `store.mjs`, and `knowledge.json` never existed. The provenance stamps the
four extractor wrappers wrote were **write-only**: the indexer
(`context-layer/indexer/`) keeps its own `TIER_CONFIDENCE` table
(`indexer/lib/models.mjs`) and hardcodes tiers per topic; test generation reads only
`bundle.facts.endpoints`. `knowledge-sources/` was a sibling README describing folders
that were never created — actual input ingestion lives in
`context-layer/content-extractor/` (crawler, graphify, code-extractors, openapi,
mock-data, framework-detector).

**Removed (2026-07-14):**
- `knowledge-base/` (schema.mjs + README) and `knowledge-sources/` (README only) deleted.
- The 4 importers (`content-extractor/{crawler,graphify,openapi-probe,mock-data}/extract.mjs`)
  no longer stamp `discoveryTier` / `confidence` / nested `provenance` blocks on their
  bundles; they keep `sourceId` / `extractedAt` / `extractedBy` as plain metadata.
- `output/indexed_output/` (built by `context-layer/indexer/index.mjs`) is the real
  consumer-facing merged layer — verified unchanged after the removal (identical topic counts).

The future replacement for "a queryable knowledge store" is this spec: real databases,
fed by skills, instead of a JSON merge file.

---

## 1. Scope & non-goals

**In scope**
- Batch persistence *after* a pipeline run (scan → index → generate → execute → report).
- Idempotent re-runs: persisting the same `run_id` twice is a refresh, not duplication.
- `--mode direct` invocation only (matches what `SkillService` has wired today).

**Non-goals (for now)**
- Streaming/live ingestion during a run.
- pgvector embeddings — the SDD's `kb_embedding` entity is explicitly deferred.
- BigQuery — out of scope per SDD.
- A web UI / query layer over the stores.
- Replacing the file-based indexer — `output/` JSON stays canonical.

**SDD alignment** — the SDD (v1.0) prescribes: JSON store now, PostgreSQL/pgvector later
*behind the same interface*; entities `run`, `execution`, `test_result`, `kb_embedding`,
`skill_memory`, `credential_ref`; GCS bucket-per-app with lifecycle rules. This spec is
the concrete realization of that "later".

---

## 2. Phase 0 — prerequisite: port text-kg (kg-gen)

text-kg is the docs→knowledge-graph extractor (entities + subject/predicate/object
triples via the `kg_gen` library, with an HTTP fallback). It is the third graph-shaped
source (`store-graph` input) alongside graphify and the click-graph.

- `text-kg/extract.py` (+ `jira/`, `confluence/` connectors sharing its engine) exist
  **only on branch `feature_output_indexder`** (commit `d413553`) — cherry-pick/port into
  `context-layer/content-extractor/text-kg/`. The kg-gen library is already installed in
  `context-layer/content-extractor/_lib/.venv`.
- text-kg is currently in **no** `run.mjs` STAGE and the indexer does **not** read its
  output — wiring both is part of this phase (new indexer topic, e.g. `docs-kg`, or
  direct consumption by `store-graph`).
- Its per-document cache (`output/.kg-cache/text-kg/<sha>.json`) survives output wipes by
  design — keep that behaviour.

**Exit criteria:** a content-extractor run with `TEXT_KG_SOURCE` set produces
`output/text-kg/bundle.json`; triples reach either an indexed topic or `store-graph`.

---

## 3. Shared `run_id` + storage manifest

One `run_id` ties all three stores together so a row in Postgres, a subgraph, and a
bucket prefix all refer to the same pipeline run.

- Resolution: latest `output/orchestration/run-*.json` if present, else generated
  (`run-<ISO8601>-<shortsha>`).
- New shared helper `testo/output-store/lib/manifest.py`: walks `output/`,
  classifies every file (**relational-source** | **graph-source** | **artifact**), and
  writes `output/storage-manifest.json` (`run_id`, `app_id`, file list + sha256 + size +
  classification). All three skills consume the manifest — classification logic lives in
  exactly one place.

Current inventory to classify:

| Classification | Paths |
|---|---|
| relational-source | `output/{crawler,mock-data,openapi,db-schema}/bundle.json`, `output/code-extractors/*.json`, `output/indexed_output/*.json`, `output/generation/*/results.json`, `output/execution/results.json`, `output/orchestration/run-*.json`, `output/content-extraction-index.json` |
| graph-source | `output/graphify/graph.json` (NetworkX node-link), `output/crawler/data/click-graph.json`, `output/text-kg/bundle.json` (after Phase 0) |
| artifact | `output/crawler/screenshots/`, `output/crawler/{raw,bodies}/`, `output/generation/**/allure-results/`, curl `.sh` suites, PDF/HTML reports, traces, `storage-manifest.json` itself |

---

## 4. Skill homes + registration

Home: **`testo/output-store/`** (the persistence home the old infrastructure
README reserved for `postgresql/` — that folder is gone; testo owns it now). Skills follow the `generation-layer/api-test-generator/skill.py`
conventions: pydantic args model with `extra="forbid"`, result model exposing `ok: bool`,
`async execute()` offloading sync I/O via `asyncio.to_thread`.

```python
# skill_register/registry/skill_registry.py — three new rows
"store-relational": SkillDefinition(
    name="store-relational",
    source_path=Path("testo/output-store/relational_skill.py"),
    skill_class="StoreRelationalSkill", args_class="StoreRelationalArgs",
    summary="Persist output/ run data (runs, executions, test_results, facts) to Postgres.",
    layer="infrastructure"),
"store-graph": SkillDefinition(
    name="store-graph",
    source_path=Path("testo/output-store/graph_skill.py"),
    skill_class="StoreGraphSkill", args_class="StoreGraphArgs",
    summary="Load graphify + click-graph + text-kg graphs into the graph store.",
    layer="infrastructure"),
"store-artifacts": SkillDefinition(
    name="store-artifacts",
    source_path=Path("testo/output-store/artifacts_skill.py"),
    skill_class="StoreArtifactsSkill", args_class="StoreArtifactsArgs",
    summary="Upload screenshots, reports, traces and curls to the app's storage bucket.",
    layer="infrastructure"),
```

Skills are the unit (user decision). They can later be wrapped as agentic-harness tools
(`store.relational` etc. in `REGISTERED_TOOLS`) so the testo REPL/agent can trigger
persistence — out of scope here.

---

## 5. Phase 1 — `store-relational` (Postgres)

```python
class StoreRelationalArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    output_dir: Path = Path("output")
    run_id: Optional[str] = None      # default: latest orchestration run, else generated
    app_id: Optional[str] = None      # target application identifier
    dsn_env: str = "POSTGRES_DSN"     # env var NAME — never the secret itself
    topics: list[str] = ["all"]       # subset of indexed topics / bundles
    dry_run: bool = False             # print row counts, write nothing

class StoreRelationalResult(BaseModel):
    ok: bool
    run_id: str
    tables: dict[str, int]            # table → rows upserted
    skipped: list[str]
    error: Optional[str] = None
```

Schema (`testo/output-store/schema.sql`), mapped to the SDD entities:

| Table | Source | Notes |
|---|---|---|
| `run` | `output/orchestration/run-*.json` | one row per pipeline run (`run_id` PK, `app_id`, started/finished, mode) |
| `execution` | `output/execution/results.json`, `output/generation/*/results.json` | one row per suite execution |
| `test_result` | per-test entries in the above | FK → execution |
| `source_bundle` | each `output/<source>/bundle.json` | JSONB row: sourceId, extractedAt, extractedBy, stats |
| `indexed_topic` | each `output/indexed_output/<topic>.json` | JSONB row per topic per run |

`kb_embedding`, `skill_memory`, `credential_ref` — reserved names per SDD, deferred.

Idempotency: `INSERT … ON CONFLICT (run_id, natural_key) DO UPDATE` — re-running the
skill for the same run refreshes rather than duplicates.

CLI: `python testo/skill-register/bin/call_skill.py store-relational --mode direct --dry_run true`

---

## 6. Phase 2 — `store-graph` + the graph-DB trade-off

Inputs (all graph-shaped, merged into one property graph namespaced by source, every
node/edge stamped with `run_id`):
- `output/graphify/graph.json` — code graph (NetworkX node-link)
- `output/crawler/data/click-graph.json` — UI navigation graph (pages → intents → APIs)
- `output/text-kg/bundle.json` — docs triples (after Phase 0)

**Decision deferred to implementation time** — the trade-off:

| Option | For | Against |
|---|---|---|
| **Neo4j** | Best Cypher tooling; Browser/Bloom visualization; mature drivers; `MERGE` gives idempotency for free | A second database to operate; enterprise licensing / infra approval at HSBC; overkill if queries stay simple |
| **Postgres + Apache AGE** | One database serves §5 and §6 (single DSN, secret, backup); openCypher inside SQL; aligns with SDD "PostgreSQL later behind the same interface" | Extension must be installed/version-pinned — may not be available on managed HSBC Postgres; younger ecosystem; weak visualization |
| **NetworkX JSON in Postgres (JSONB)** | Zero new infra — graph.json already exists; analytics via NetworkX in Python; simplest skill | No graph query language; no cross-run traversal without loading into memory |

**Recommendation:** default to **Postgres + Apache AGE** (one system, SDD-aligned). If
AGE is unavailable in the target environment, fall back to node-link JSONB behind the
same skill interface. Adopt Neo4j only if interactive graph exploration becomes a hard
requirement. The choice is isolated behind an args field:

```python
class StoreGraphArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    output_dir: Path = Path("output")
    run_id: Optional[str] = None
    app_id: Optional[str] = None
    backend: Literal["age", "jsonb", "neo4j"] = "age"
    sources: list[Literal["graphify", "click-graph", "text-kg"]] = ["graphify", "click-graph", "text-kg"]
    dsn_env: str = "POSTGRES_DSN"     # age/jsonb
    neo4j_uri_env: str = "NEO4J_URI"  # neo4j only
    dry_run: bool = False

class StoreGraphResult(BaseModel):
    ok: bool
    run_id: str
    nodes_written: int
    edges_written: int
    per_source: dict[str, dict]       # source → {nodes, edges}
    error: Optional[str] = None
```

---

## 7. Phase 3 — `store-artifacts` (storage bucket)

Uploads binary/bulky artifacts per SDD: **bucket-per-app**, prefix layout
`gs://<bucket>/<app_id>/<run_id>/<repo-relative-path>`, lifecycle rules (e.g. expire raw
traces after N days, keep reports).

Payload: `output/crawler/screenshots/`, `output/generation/**/allure-results/`,
curl `.sh` suites, PDF/HTML reports, traces, plus a copy of `storage-manifest.json`.

```python
class StoreArtifactsArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    output_dir: Path = Path("output")
    run_id: Optional[str] = None
    app_id: Optional[str] = None
    bucket_env: str = "GCS_BUCKET"
    credentials_env: str = "GOOGLE_APPLICATION_CREDENTIALS"
    include: list[str] = []           # extra globs
    exclude: list[str] = []
    dry_run: bool = False

class StoreArtifactsResult(BaseModel):
    ok: bool
    run_id: str
    uploaded: int
    bytes: int
    skipped_unchanged: int            # sha256 match → skip
    errors: list[str] = []
```

Idempotent by construction: same `run_id` + same path + same sha256 → skip.

---

## 8. Configuration & secrets

All connection material via env vars loaded from `.env` (gitignored, **never committed**):
`POSTGRES_DSN`, `GCS_BUCKET`, `GOOGLE_APPLICATION_CREDENTIALS`, optionally
`NEO4J_URI` / `NEO4J_USER` / `NEO4J_PASSWORD`. Skill args carry env-var **names**, never
values. Ship an `.env.example`. The SDD's `credential_ref` entity is the eventual home
for credential indirection once the relational store exists.

---

## 9. Verification per phase

- **Phase 0**: content-extractor run produces a non-empty triples bundle; indexer topic
  count check (or `store-graph` ingest count).
- **Phase 1**: `--dry_run` row counts match the manifest; running twice yields identical
  table counts (idempotency); `psql` spot-queries documented alongside `schema.sql`.
- **Phase 2**: node/edge counts equal source graph counts; a sample Cypher/JSONB query
  returns a known endpoint→page path.
- **Phase 3**: bucket listing matches the manifest; a second run reports everything as
  `skipped_unchanged`.

---

## 10. Open questions

1. Does the target (HSBC-managed) Postgres allow the Apache AGE extension? → drives §6.
2. One database per target app, or one shared DB with an `app_id` column?
3. Should `store-*` run automatically at the end of the pipeline (`run.mjs` /
   future `pipeline.run`), or stay operator-invoked?
4. Retention: how many runs kept in Postgres before pruning? (The bucket has lifecycle
   rules; tables need an explicit policy.)
5. Do the `jira/` and `confluence/` connectors get ported in Phase 0 alongside text-kg,
   or in a later pass?
