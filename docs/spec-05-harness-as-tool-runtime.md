# Spec 05 — Make every functionality an agent-callable tool (harness as runtime)

_Target: **Infrastructure** (agentic-harness, skill-register, model-api-connector) +
**Interfaces** (`testo`), wrapping every Context / Generation / Execution functionality._

> **Goal:** *"All functionality called as tools, and the whole application runs on the testing
> harness — every functionality we built so far called from the harness."* Today the app runs
> as a deterministic spine (`scan.mjs` / `run.mjs` / `pipeline.mjs` spawn stages as child
> processes) + a `testo` CLI + a `skill-register`. We want every functionality reachable as a
> tool the agent harness can call — **without breaking the working pipeline**.

---

## TL;DR — effort & direction change

- **Direction change: small-to-moderate — an additive overlay, not a rewrite.** The machinery
  already exists and keeps running: the `BaseTool` contract, a 3-mode `ToolService` (direct /
  agent / free-agent), the lazy `importlib` tool registry, and the spawn-leaf orchestrators.
  **All 50 functionalities are already spawn-invoked leaves marked `toolReadiness = ready`**, and
  `graphify` already proves the full pattern (BaseTool + subprocess + heartbeat + freshness
  guard). Nothing core is thrown away; `pipeline.mjs`/`scan.mjs` stay as the default plan,
  *wrapped*.
- **Effort: ~13–18 calendar weeks (~3–4.5 months) for 2 engineers** (≈16–22 person-weeks);
  ~5–6 months solo. The cost is **not** porting code (mostly catalog rows) — it's (a) clean
  `input_model`s for the less-mature generators (validator / test-plan / mock-data), (b) a
  deny-by-default permission rework before any MCP, and (c) a golden-output regression harness
  keeping `testo scan` byte-identical through every phase. Critical path WS1→WS3→WS4
  (contract → adapter → orchestrator) is serial (~5–6 weeks); the rest fans out.

**Approach chosen** (3 designs scored: Hybrid-Strangler **8.7** > Internal-Registry 8.0 >
MCP-first 6.8): **strangler migration → a unified internal tool registry, with MCP as a
deferred external facade.**

---

## 1. Context / problem

The agent harness (OpenHarness) exists, but only **one** functionality (`graphify`) is a
registered tool. Everything else runs via the deterministic spine and the `skill-register`,
which is a near-clone of the tool registry. We want a single tool layer so the harness can
orchestrate every capability — while the deterministic `testo scan` path stays unchanged for
reproducibility.

---

## 2. Recommended architecture

1. **Tool contract — one contract, two flavors.** Keep `openharness.tools.base.BaseTool`
   (`name`, `description`, `input_model: BaseModel`, `async execute(args, ctx) -> ToolResult`;
   LLM JSON via `to_api_schema()`). A tool is one row in a **widened `ToolDefinition`**
   (`models.py`, already `frozen + extra="forbid"` so new defaulted fields are safe):
   `kind: "inproc"|"subprocess"`, `runtime: "python"|"node"`, `entrypoint`, `tags`, `layer`.
   Only contract break: widen the single 1-arg `ISkill.execute(args)` (`skill.py:114`) →
   `execute(args, context=None)` (callers already pass `context=None`).
2. **Unified registry — merge, don't federate.** The agentic-harness registry and the
   skill-register are verified near-clones. Keep
   `agentic_harness/registry/tool_registry.py:REGISTERED_TOOLS` as the single source of truth;
   migrate the one skill row in; reduce skill-register to a one-release re-export shim, then
   delete it; alias `call_skill.py` → `call_tool.py`. No new package.
3. **node ↔ python bridge.** New generic **`SubprocessStageTool(BaseTool)`** backs every
   `.mjs`/`extract.*` leaf — `input_model = StageArgs(target_codebase, base_url, only, skip,
   env)`, `execute()` spawns `node`/`venv-python` (interpreter pick as `run.mjs:41`), lifting
   graphify's proven heartbeat/timeout/kill loop. Per-extractor leaves reuse `run.mjs`'s
   `ONLY=<id>` gate (no need to list 30+). **Guardrail:** large bundles via temp-file/stdin
   JSON, never CLI argv.
4. **Orchestration — hybrid spine, determinism-default.** Happy path: the spine decides order,
   **no LLM** — `testo scan` (no flags) stays byte-identical. Agent path is **opt-in**:
   `testo scan --agent` flips to the LLM loop (spine encoded as a prompt); `testo ask`
   auto-gains every stage tool via `build_toolbelt`. Failure wedge: `AGENT_RECOVERY=1` runs a
   narrow agent on just a failed stage. `pipeline.mjs`/`scan.mjs` are **kept and wrapped**,
   never deprecated.
5. **MCP — no internally, yes as a deferred external facade.** Internal stays in-process
   (faster + preserves full nested pydantic validation). **Decisive:** OpenHarness's
   `mcp_tool._input_model_from_schema` is shallow (nested objects collapse to `dict`), so an
   MCP-internal path would silently drop nested validation. MCP earns its place only as an
   external `bin/mcp_server.py` stdio facade over the **same** registry — gated behind replacing
   `PermissionMode.FULL_AUTO` with deny-by-default.
6. **Observability / determinism.** Thread the uniform `ToolInvocationResult` end-to-end; add
   append-only `output/tool-runs.jsonl` (name, runtime, kind, mode, status, duration, args_hash,
   freshness_ok, redacted). Preserve the strict `NOT_INVOKED` honesty guard
   (`tool_service.py:198`) and graphify's mtime freshness guard.
7. **`testo` becomes a thin front door** where every subcommand resolves to a registry tool
   through one `ToolService` seam, plus a new **`testo tools list`** → `output/tool-manifest.json`
   (single discovery surface for node + MCP).

---

## 3. Inventory — what gets toolified

**50 functionalities, every one `toolReadiness = ready`.**
- **Context:** crawler, graphify, framework-detector, db-schema (+ deterministic/LLM), **29
  code-extractors**, mock-data, openapi, indexer, graph-viewer, content-extractor orchestrator.
- **Generation:** api-test-generator (already a skill), ui/perf-test-generator, validator,
  test-plan-creator, mock-data-creator.
- **Execution:** allure-reporter, pdf-reporter.
- **Infra / interface:** skill-register, agentic-harness, model-api-connector, `testo`
  dispatcher / scan / generate / ask.

---

## 4. Workstreams (≈16–22 person-weeks)

| WS | Effort | Weeks | What |
|----|:---:|---|------|
| WS1 | M | 1.5–2 | Widen `ToolDefinition` + unify registry/catalog |
| WS2 | S | 0.5–1 | Node→python bridge harden (bundle temp-file/stdin) |
| WS3 | M | 1.5–2 | `SubprocessStageTool` (python→leaf inverse bridge) |
| WS4 | M | 1.5–2.5 | Agent orchestrator (hybrid spine, opt-in agent) |
| WS5 | M | 2–3 | Toolify context leaves (crawler/graphify/extractors/indexer…) |
| WS6 | M | 2–3 | Toolify generation/execution leaves (+ input_models for validator/test-plan/mock-data) |
| WS7 | M | 1.5–2 *(gated P5)* | External MCP stdio facade |
| WS8 | S | 1–1.5 | Observability + determinism guardrails (`tool-runs.jsonl`) |
| WS9 | S | 1–1.5 | CLI rework (`testo` thin front door + `tools list`) |
| WS10 | M | 1.5–2 *(spread)* | Migration / back-compat shim (strangler scaffolding) |

---

## 5. Direction change — reused vs replaced

- **Reused (kept running):** `BaseTool` + `to_api_schema()`, `REGISTERED_TOOLS` + lazy loader,
  `ToolDefinition`, `ToolService` 3 modes + honesty guard, graphify's subprocess/heartbeat/
  freshness loop, `scan.mjs`/`run.mjs` loops + `ONLY/SKIP` gate, all 50 leaves unchanged,
  `call_tool.py`, the `testo` dispatcher, `ToolInvocationResult`/`InvocationStatus`.
- **Replaced:** the duplicated skill-register stack (→ shim → deleted), 1-arg `ISkill.execute`,
  `FULL_AUTO` default, CLI-argv large-payload path, single-kind `generate.mjs` dispatch.
  (MCP-internal is **rejected, not replaced**.)
- **Top risks:** determinism regression in `testo scan` (→ golden-output harness gates every
  phase); `FULL_AUTO`→deny-by-default is security-critical and blocks MCP if under-scoped; the
  large-bundle/argv seam (land guardrail in P0); venv/interpreter isolation across 29 python +
  node leaves; missing `input_model`s for validator/test-plan/mock-data (real design, likely
  slip); shim-deletion discipline; the MCP nested-validation trap recurring.

---

## 6. Phased migration (strangler — pipeline stays runnable throughout; stop at any phase)

- **P0 Foundation** — `SubprocessStageTool` + widen `ToolDefinition` + widen `ISkill.execute` +
  bundle temp-file/stdin guardrail + capture golden-output baseline. *Exit:* `testo scan` /
  `generate api-tests` byte-identical; adapter unit-tested on one leaf; no rows added yet.
- **P1 Unify + first cutover** — migrate the api-test skill into `REGISTERED_TOOLS`;
  skill-register → re-export shim; register scan stages as rows; wrap `scan.mjs`/`run.mjs`
  (loops byte-identical). *Exit:* every stage invokable via `call_tool.py` AND the orchestrator,
  identical output; regression green.
- **P2 Failure-recovery wedge** — `AGENT_RECOVERY=1` narrow agent on a failed stage; verify
  freshness + honesty guards through the adapter. *Exit:* a failed stage is agent-recovered;
  flag-off identical to P1.
- **P3 Opt-in agent + broaden generation** — `testo scan --agent` + `testo ask` gets the full
  toolbelt; register ui/perf/allure/pdf as `runtime:node` rows; define `input_model`s for
  validator/test-plan/mock-data. *Exit:* default still deterministic; `--agent` completes a full
  LLM run; new generate kinds work.
- **P4 Observability + discovery + delete duplication** — `output/tool-runs.jsonl` end-to-end;
  `testo tools list` → manifest; delete the skill-register shim + duplicate registry/models.
  *Exit:* every invocation writes a JSONL row; no imports of the deleted stack; regression green.
- **P5 Gated external MCP** — replace `FULL_AUTO` with deny-by-default; `bin/mcp_server.py`
  external stdio facade over the same registry; document "MCP-internal forbidden." *Exit:*
  deny-by-default blocks un-permitted tools; external client lists+invokes with full nested
  validation preserved.

---

## 7. Verification

- **Golden-output regression harness (built in P0, gates every phase):** snapshot `output/` from
  `testo scan` (no flags) + `testo generate api-tests` against a known target (logtrim); every
  phase must reproduce byte-identical output unless intentionally changed.
- **Per phase:** invoke a representative leaf via `call_tool.py` and via the orchestrator → same
  result; `--agent` completes a run; one `tool-runs.jsonl` row per invocation; deny-by-default
  blocks an un-permitted MCP tool while preserving nested pydantic validation.

---

## 8. Out of scope (now)
- MCP on the internal hot path (shallow-schema validation loss).
- Relocating registries into a new shared toolkit package (avoid up-front churn).
- Deprecating `pipeline.mjs` — it stays the default plan, wrapped.
