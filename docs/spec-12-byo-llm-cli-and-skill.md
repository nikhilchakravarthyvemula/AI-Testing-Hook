# Spec 12 — Invert the LLM: context-layer as a BYO-LLM CLI + Claude Code Skill (Deepline pattern)

_Target when built: primary surface = a clean `--json` renderer over `testo/harness/bin/call_tool.py` + a thin `testo <verb>` front door (spec-05 §7). New skill: `~/.claude/skills/testo-context/SKILL.md`. New CLI verbs: `testo scan|crawl|extract|graph|index|generate|report|context` + write-backs `annotate-intents` / `enrich-graph`. New artifact: `output/run-summary.json`. Deterministic-mode flag: `SKILL_MODE` (new `testo/_lib/skill_mode.py` + a read in `context-layer/content-extractor/run.mjs`)._

> **TL;DR** — Today the harness owns its LLM: the crawler calls MiniMax per page for click-intent (`crawler/llm-advisor`, on by default via `CRAWLER_LLM`) and graphify calls MiniMax for its semantic code-graph pass. This spec **inverts** that. In *skill mode* the pipeline runs fully deterministic — raw crawl facts, AST-only code facts — emits clean JSON, and the **host agent's LLM** (Claude Code / Copilot / Cursor) does the intent-classification and semantic-enrichment reasoning, then persists it back via a write-back subcommand. The surface is a **clean JSON-emitting CLI** (universal base, any editor terminal + CI) wrapped by a **Claude Code `SKILL.md`** (the Deepline pattern: CLI-first, Skill-first, BYO-LLM, deliberately **not** MCP). MCP stays a deferred external facade. The standalone `testo` REPL keeps its embedded MiniMax untouched. **§12 records the gaps, prerequisites, and decisions from an adversarial review — read it before building; several of the plan's own guards are unbuilt and the delegation does not yet work end-to-end.**

---

## 0. Architecture comparison — existing vs new

**Verdict: complementary, not either/or. Keep both;** make the new BYO-LLM skill the primary developer-facing surface and keep the embedded-LLM path as the headless/CI/offline **quality floor** (see §12 for why "floor" not just "fallback"). Skill mode is strictly additive — the REPL is untouched — so no capability is lost.

| Dimension | Existing (embedded MiniMax) | New (BYO-LLM CLI + skill) |
|---|---|---|
| Who pays for the LLM | Us (MiniMax tokens + key mgmt) | The host's subscription (Claude/Copilot) |
| Model quality | Fixed MiniMax-M2.7 | Whatever the host runs (often better) |
| Standalone / headless / CI | ✅ runs end-to-end unattended | ❌ needs a host agent to reason; raw facts only without one |
| Reproducibility / golden-output | ✅ temp-0 tuned prompts | ⚠️ varies by host model + SKILL.md wording |
| Offline / locked-down VM | ✅ works (MiniMax or local) | ❌ assumes the host's cloud LLM is reachable |
| Distribution / adoption | Self-contained; a 2nd LLM for devs already in Claude/Copilot | ✅ meets devs where they are (the Deepline pitch) |
| Reasoning cost/context | Batched 15/page inside the pipeline | Shifts to host tokens + context window; big crawls need host-side batching |
| Secrets exposure to the LLM | Secrets flow through the harness that calls the LLM | Host never sees a DSN/token — *if* redaction lands (§12 B2) |

**Gaps the inversion introduces:** loses unattended capability; reproducibility drops; offline breaks; reasoning cost shifts not vanishes; write-back trust boundary; semantic-graph fidelity loss. All expanded in §12.

---

## 1. The inversion — who owns the LLM

Today two internal LLM calls sit inside otherwise-deterministic stages:

| Stage | Where | LLM call | Default |
|---|---|---|---|
| Crawler click-intent | `crawler/extract.mjs:143-154` → `crawler/llm-advisor/index.mjs:89` | one MiniMax call per ~15-clickable batch → `intents[]` merged at `extract.mjs:184-198` | **ON** — `(CRAWLER_LLM ?? '1') !== '0'` (`index.mjs:71-73`) |
| Graphify semantic graph | `tools/graphify/tool.py:342-369` → `graphify extract --backend minimax` | AST **+ semantic LLM** → `graph.json` | **always on** |
| Framework LLM pass | `framework-detector/extract.py:61` | optional confirm | `LLM_FRAMEWORK_DETECTION` = `auto` |
| DB-schema LLM pass | `code-extractors/db-schema/` | optional agentic pass | `DBSCHEMA_LLM` off |

**After (skill mode):** the deterministic engine is unchanged; the *reasoning* moves from MiniMax (inside the harness) to the host agent's LLM (outside). The pipeline emits raw facts + a schema; the host produces annotations; a write-back subcommand merges them via the same code the internal path uses. This is not novel — graphify's own upstream `~/.claude/skills/graphify/SKILL.md` already splits deterministic-structural from LLM-semantic and dispatches Claude subagents for the semantic pass. Spec-12 generalizes that to the whole context layer.

---

## 2. Scope & non-goals

**In scope:** a `--json` clean-stdout contract; a unified `output/run-summary.json` (none exists today); host delegation + write-back; a Claude Code `SKILL.md`; one skill-mode flag.

**Non-goals:** MCP (deferred — §7.3; but see §12 Decision 3, which makes MCP timing *conditional* on the approved host); rewriting the deterministic engine; changing the REPL; new test-planning intelligence.

---

## 3. The CLI — clean JSON surface

**Why a new renderer is needed (verified).** `call_tool.py <tool> --mode direct` already runs with **no agent LLM** (`call_tool.py:160-167`), but its stdout is a human line plus a 600-char-truncated, log-framed envelope (`tool_service.py:36` `_RESULT_TAIL_CHARS=600`, `:246-261`) — not clean JSON. There is no `--json` mode today (`call_tool.py:71-99`).

**Command surface** (thin `argparse` → spec-09 stage-args → `ToolService.invoke_direct`, deterministic):

| Command | Resolves to (spec-09 tool) | Notes |
|---|---|---|
| `testo scan --json --url U [--codebase P]` | orchestrates crawler + code-extractors + graphify | shells `run.mjs`→`index.mjs` with `SKILL_MODE=1` until spec-09 `pipeline.run` unblocks |
| `testo crawl --json --url U` | `scan.crawler` | `CRAWLER_LLM=0` → raw clickables, no `.intent` |
| `testo extract --json --codebase P [--only …]` | `scan.code_extractors` | pure AST |
| `testo graph --json --codebase P` | `scan.graphify` | AST-only (§4.3 / §12 B9) |
| `testo index --json` | `index.build` | merges `output/` → `indexed_output/` |
| `testo generate api --json [--no-execute]` | `generate.api_tests` | already deterministic ("LLM usage: NONE") |
| `testo report --json [--pdf\|--allure]` | `report.pdf`/`report.allure` | deterministic |
| `testo context --json [--topic …]` | read-only | returns the consumable indexed context for the host |
| `testo annotate-intents <f> --json` | **new** write-back | persists host click-intents (§4.2) |
| `testo enrich-graph <f> --json` | **new** write-back | persists host semantic edges (§4.3) |

**Clean JSON envelope** (extends spec-09 §4 with `run_id`, `mode`, and a `delegation` block):

```json
{
  "ok": true, "tool": "scan.crawler",
  "run_id": "run-2026-07-17T09-14-22Z-a1b2c3d", "mode": "skill",
  "counts": { "endpoints": 21, "pages": 12, "clickEdges": 1690, "intentsAnnotated": 0 },
  "outputPaths": ["output/crawler/bundle.json"], "durationMs": 812345,
  "warnings": [], "error": null,
  "delegation": {
    "kind": "crawler-intent", "pending": true,
    "reason": "CRAWLER_LLM=0 (skill mode): clickables emitted un-annotated",
    "input_paths": ["output/crawler/data/pages/page-01.json", "…"],
    "schema_path": "output/crawler/data/intent-schema.json",
    "write_back": "testo annotate-intents <your-intents.json> --json"
  }
}
```

**Contract rules for `--json`:** exactly one JSON object on stdout, untruncated; every human/diagnostic line on **stderr** + `output/tool-runs/<run_id>.log`. Because `scan` shells the Node pipeline (a stdout firehose — see §12 B3), the wrapper must **never stream pipeline stdout**; it redirects child stdout+stderr to the log, waits for exit, and **synthesizes the envelope from on-disk artifacts**. Assert "exactly one JSON value on stdout" as a hard verify gate. Secrets redacted everywhere (§12 B2). Exit codes 0/1/2, composed across the Node pipeline ⊕ Python wrapper (§12 B6).

**New `output/run-summary.json`** (there is none today — only the disjoint `content-extraction-index.json` + `indexed_output/index.json`), keyed by the shared `run_id`, with `stages[]`, `delegations[]`, and `consumable{index,topics_dir}`. This is what `testo scan --json` prints.

---

## 4. Host-LLM delegation (the crux)

Three-move pattern: **(a)** the deterministic pipeline emits raw facts + a schema; **(b)** the SKILL.md tells the host LLM to produce annotations matching the schema; **(c)** a write-back subcommand merges them exactly as the internal path would.

**4.1/4.2 Crawler intent.** The crawl is deterministic (`page.clickables = {buttons[],links[]}`); the only LLM step is `adviseOn({kind:'intent-extract'})` (`extract.mjs:143-154`). With `CRAWLER_LLM=0`, `adviseOn` returns `null` (`index.mjs:90`) and clickables carry no `.intent` — the deterministic path already exists (it's the regression-run path). The host reproduces the **already-specified** intent schema (`intent-extract.mjs` `SCHEMA_HINT`:37-52, `CATEGORIES`, `validate()`:88-112). `testo annotate-intents` refactors the `extract.mjs:184-198` merge into a shared `mergeIntents(bundle, intents)` used by both the MiniMax path and the write-back, runs `validate()`, updates `counts.intentsAnnotated`, and re-runs `index.build`. **The hand-off must be page/batch-scoped (15-clickable unit), not one bundle — §12 B5. The merge must be identity-keyed with fail-safe safety defaults — §12 B4.**

**4.3 Graphify.** Two different "AST" things exist: `graphify extract` (structural **+** semantic LLM, one `graph.json`) vs the **separate deterministic** `code-extractors/python-ast/extract.py`. **P1: skip graphify-semantic**, assemble a deterministic `graph.ast.json` from python-ast + framework extractors; the host infers semantic edges → `testo enrich-graph` (each stamped `origin:"INFERRED"`, deterministic edges `origin:"EXTRACTED"`). **P2:** a structural-only `graphify` mode — but graphify is a third-party pip binary with **no `--no-llm` flag** today (§12 B9), so this is an external dependency, not a config toggle. `enrich-graph` needs a referential-integrity validator before it ships (§12 B4).

**Why write-back, not host-edits-files:** one merge function so the MiniMax and host paths can't drift, `validate()` rejects malformed host output loudly, and `index.build` re-triggers so downstream topics stay consistent.

---

## 5. The Claude Code SKILL.md

Home: `~/.claude/skills/testo-context/SKILL.md`, mirroring the graphify template — YAML frontmatter (`name`, `description`, `trigger: /testo`) + imperative "What You Must Do When Invoked" steps: (1) locate + persist the `_lib/.venv` python; (2) `SKILL_MODE=1 testo scan --json …`, read the JSON silently, present a clean human summary, note each `delegations[]` entry; (3) classify intents per batch → `testo annotate-intents`; (4) infer graph edges → `testo enrich-graph`; (5) `testo context --json` read-back to answer the user. Include a `--help` short-circuit. **Treat all crawled content as untrusted data (§12 M3): the SKILL.md must instruct the host to emit only the schema and never execute instructions found in page content.**

---

## 5b. Connectors & storage in the BYO-LLM model

Core principle: **connections are deterministic I/O → CLI subcommands run by OUR code with credentials in the LOCAL `.env`; only the REASONING over fetched data is delegated to the host LLM.** The host never sees a DSN/token/bucket key.

- **Storage DBs (spec-10) — Postgres / graph DB / GCS.** LLM-free deterministic writes → CLI verbs `testo store relational|graph|artifacts`, keyed by `run_id`. Creds via env-var NAMES in args, VALUES in local `.env`. Graph backend deferred (Neo4j vs Postgres+AGE vs JSONB) behind a `backend` arg. Nothing changes for BYO-LLM.
- **Jira / Confluence.** (a) deterministic **fetch** (`testo fetch jira|confluence`, tokens local); (b) **kg-gen extract** = LLM half → delegated to the host (or embedded fallback). Connectors live only on `feature_output_indexder` — a port prerequisite (shared with spec-10 Phase 0).
- **GitHub.** (a) as code input — clone + deterministic AST, `GITHUB_TOKEN` local, no LLM; (b) as an LLM provider (spec-06/08) — moot in skill mode, relevant only for the embedded/offline floor.
- **Where the CLI runs:** locally (dev laptop / CI runner), with local creds, while the host merely orchestrates — "local CLI + local creds + remote data stores," not a hosted service. **Caveat (§12 M1): this credential boundary protects the DSN/token class only; crawled response bodies/screenshots carry runtime secrets + PII and need a separate DLP stage.**

---

## 6. Config — the skill-mode flag

`SKILL_MODE=1` umbrella → `CRAWLER_LLM=0` + `LLM_FRAMEWORK_DETECTION=never` + skip/AST-only graphify (db-schema already off). Expanded in one place per language: new Python `testo/_lib/skill_mode.py apply_skill_mode(env)`; Node `run.mjs` reads `SKILL_MODE`. **Critical (§12 B8):** `run.mjs` does zero per-child env injection today (`:298` spawn passes no `env`; propagation is ambient `process.env` inheritance through two nested spawns), and `SKILL_MODE` exists nowhere. `apply_skill_mode` must mutate the **real inherited environment** (or pass explicit `env=` on the spawn), or `CRAWLER_LLM` stays `'1'` and the crawler silently calls MiniMax "in skill mode." The REPL never sets `SKILL_MODE` → its MiniMax path stays byte-identical (golden-output guard).

---

## 6b. Org-level deployment at HSBC — major gaps + installation

The BYO-LLM model *helps* one bank concern (route reasoning through the sanctioned enterprise LLM instead of an unapproved MiniMax key) but exposes others. Prioritized:

1. **No installable artifact (biggest blocker).** Three-runtime app (Python venv + Node + Chromium); pipx ignores Node, npm ignores Python; hardcoded `_lib/.venv` paths break relocatable/container builds; Chromium un-mirrored + macOS-assumed. Need pipx/npm from Artifactory, a container image, or a golden-image bundle via Jamf/SCCM/Ansible.
2. **Approved LLM host + the SKILL.md-vs-Copilot mismatch.** MiniMax is not approvable → embedded path is a compliance non-starter; the compliant path is the sanctioned Copilot/Claude Enterprise. **But Copilot has no "skills" mechanism** — the SKILL.md surface is Claude-Code-specific. Which host is approved decides whether the primary surface applies (see §12 Decision 1).
3. **Dependency supply chain / SBOM** — internal mirrors + Black Duck/Snyk + SBOM.
4. **Secrets** — plaintext `.env` won't pass; integrate CyberArk / Vault / Key Vault / keychain.
5. **Data governance / DLP** — crawls capture PII; approved encrypted region-locked stores; control what content reaches the LLM.
6. **Network** — proxy/CA/egress; offline VMs break BYO-host-LLM (need an on-prem model or deterministic-only).
7. **Enterprise identity** — GitHub Enterprise, Jira/Confluence SSO/SAML, service accounts.
8. **Versioning / update / support / ownership** + run auditability.

**Installation story:** internal-registry deps → `pipx install testo` (or signed bootstrap) → Chromium from internal mirror → secrets from Vault (not `.env`) → SKILL.md → `~/.claude/skills/` via config management (only if the host is Claude Code; if Copilot, register an MCP server or ship a VS Code extension). CI runners get the container image + service-account creds. **This packaging/secrets/host-integration layer does not exist today and is larger than the CLI/skill build itself.**

---

## 7. Multi-host coverage

- **7.1 Claude Code — now, via `SKILL.md`** (`/testo`).
- **7.2 Copilot / Cursor — now, via the raw CLI in the integrated terminal** (CLI is the universal base; add `.github/copilot-instructions.md` + a Cursor Rules file as the near-zero-cost auto-inject analogs).
- **7.3 MCP stdio facade — deferred**, over the same spec-09 registry (spec-05 §5 / WS7 / P5, gated on deny-by-default). Same `delegation` block; write-backs become two MCP tools. **§12 Decision 3 makes this timing conditional on the approved host — if Copilot, MCP is near-P0, not P3.**

---

## 8. Auditability (Deepline-style)

One `run_id` per run (spec-10 §3 join key). After a scan, spec-10 `store-relational` persists `mode`, `delegations[]`, durations. Stamp `pipeline_version` (short-sha) + a pinned `tool-manifest.json` hash into `run-summary.json`. **§12 M5:** also stamp the **host model id/version + a hash of the prompt/schema shipped + a hash of the raw host response** per delegation, and **hash-chain `output/tool-runs.jsonl`** — otherwise two runs with identical audit metadata can produce different annotations and you can't prove whether a test came from the pipeline or a hijacked host.

---

## 9. Relationship to existing specs

| Spec | Relationship |
|---|---|
| **spec-05** (harness as tool runtime) | **Reused foundation** — unified registry, `SubprocessStageTool`, DIRECT mode, thin `testo` front door. Target `call_tool.py`, NOT the deprecating `skill-register`. |
| **spec-09** (tool catalog) | **Reused 1:1** — verbs map to registered tools; envelope extends §4. `pipeline.run` is BLOCKED → interim `run.mjs→index.mjs` shelling. |
| **spec-10** (output storage) | **Complementary** — supplies `run_id` + `run-summary.json` + skill-mode metadata for its stores. |
| **spec-08** (Copilot SDK / GitHub Models) | **Precedent** — "reuse pipeline, BYO the LLM"; spec-12 goes further (BYO the whole reasoning). Its unbuilt `github-models.mjs` should be generalized (§12 M2). |
| **spec-06** (GitHub device auth) | Orthogonal — relevant only to the embedded/offline fallback. |
| **spec-07** (REPL) | Kept separate — bare `testo` ⇒ REPL (embedded MiniMax); `testo <verb> --json` ⇒ non-interactive BYO-LLM CLI. Delivers the deny-by-default prerequisite for the deferred MCP facade. |

**Deprecation tension:** `api-test-generator` lives **only** in `skill-register` (`skill_registry.py:27-37`), which spec-05 deletes — so §9's "never skill-register" contradicts routing `testo generate` today. Requires spec-05 to migrate it into `tool_registry` first (§12 B-cross).

---

## 10. Phasing + verification

- **P0 — clean-JSON CLI + `run-summary.json`.** Add the `--json` renderer (synthesize-from-disk, not stdout passthrough); fix exit codes at both layers; `run-summary.json`. *Verify:* exactly-one-JSON-value on stdout; bad args → exit 2; golden flag-off `testo scan` byte-identical; **no secret substring on the `--json` channel.**
- **P1 — SKILL.md + delegation + `SKILL_MODE`.** Wire `SKILL_MODE` (real env injection); emit `delegation` + `intent-schema.json` + `graph.ast.json`; author the SKILL.md. *Verify:* skill-mode crawl → clickables with no `.intent`, `delegation.pending:true`; **zero `model-api-connector` hits in the run log (hard gate).**
- **P2 — write-backs + full deterministic mode.** `annotate-intents`/`enrich-graph` with identity-keyed merge, fail-safe defaults, and the graph validator; AST-only graphify. *Verify:* hand-written intents → click-graph shape-identical to a MiniMax run; invalid/misaligned entries rejected; idempotent per `run_id`.
- **P3 — MCP facade + audit persistence.** Gated on deny-by-default + spec-10 `store-relational` + spec-09 `tool-runs.jsonl`.

---

## 11. Open questions (superseded by §12 where they overlap)

1. Output quality depends on host LLM + SKILL.md wording — ship the exact schema + "unknown when unsure" (enforced by write-back reject, not prose — §12 M7).
2. AST-only graphify — no upstream flag exists (§12 B9).
3. CLI naming vs REPL — verb-present ⇒ non-interactive; bare `testo` ⇒ REPL (reconsider: `testo repl` explicit, print help on no-TTY — §12 M-improve).
4. `--json` stdout purity — synthesize from on-disk artifact (§12 B3).
5. Copilot/Cursor have no auto-trigger (§12 Decision 1).
6. skill-register deletion timing (§9 tension).
7. `enrich-graph` graph validator — undesigned (§12 B4).
8. MCP facade deferred (§12 Decision 3).

---

## 12. Gaps, prerequisites & decisions (adversarial review)

Source: a multi-agent review (code ground-truth + 5 adversarial lenses: feasibility, cross-spec, product/DX, security, enterprise). The core inversion is **sound**; the gaps are in the hand-off mechanics, the prerequisites, and the safety/enterprise layers. **As specified today the delegation does not work end-to-end, and several of the plan's own guards are unbuilt.**

### 12.1 Blocking gaps (resolve before building)

- **B1 — Approved host + data-egress is undecided (go/no-go).** SKILL.md auto-triggers only in Claude Code; if HSBC standardizes on Copilot the primary surface is dead on arrival and the loop collapses to a manual terminal dance. Host = who sees the crawled bank data, so this is also the PII-egress decision. **Decide first** (§12.4 D1).
- **B2 — Live secret leak on the exact path skill mode shells.** `tool_service.py:52-53` prints `[tool→] {tool}({args!r})` unredacted; `CrawlerArgs.login_password` is a plain `str` (`crawler_tool.py:19`); so `testo scan` → `scan.crawler --login_password …` emits cleartext into the stdout the SKILL.md tells the host to read. Plus argv exposure (`repl.py:400`, `call_tool.py:162`), the plaintext-password bake in `generator.mjs:94-95`, and exception/tail prints (`tool_service.py:61,246,258`). **Land spec-11 WP1 (redaction + env-only secrets) before any SKILL.md reads CLI output.**
- **B3 — `--json` purity is unachievable by the named fix.** §10-P0 names the Python truncation, but `scan` shells the **Node** `run.mjs`, a stdout firehose (`:183,195,196,200,316,353,358,360,361`; fans child stdout at `:298,305`; crawler `execFileSync('npm',['run','all'],{stdio:'inherit'})` → npm/Playwright/chromium logs). **Fix: redirect all pipeline stdout to a log and synthesize the envelope from on-disk artifacts.**
- **B4 — Write-back trust boundary.** Merge binds by **position, not identity** (`extract.mjs:184-198`); `validate()` (`intent-extract.mjs:88-112`) is shape-only and defaults `safeToClick:true`, `destructive:false`. A misaligned/hallucinated/injection-steered annotation marks a Delete/Transfer control safe → the generator emits a Playwright test that **clicks it**. `enrich-graph` has **no validator** (open #7). **Fix: identity-keyed merge (selector-hash, count ≤ input); derive `destructive`/`safeToClick` deterministically, fail-safe defaults; `--allow-destructive` gate; graph referential-integrity validator (every edge endpoint must resolve to a real `graph.ast.json` node; `expectedApiCall` must match a crawl-observed route or be stored `unverified`).**
- **B5 — 122-page hand-off exceeds host context.** `bundle.json`=8.5 MB, `pages.json`=3.9 MB; ~200K-token window ≈ 1 MB. Skill mode drops the existing `BATCH_SIZE=15` chunking (`extract.mjs:108`). **Fix: page/batch-scoped delegation; `delegation.input_paths[]`; SKILL.md iterates batches, write-back incrementally.**
- **B6 — Exit-code contract is a lie at the Node layer.** `run.mjs` never exits nonzero on extractor failure (`:319-321` warn+`resolve()`; only `exit(0)` at `:134`). `testo scan --json` returns 0 with a broken bundle. **Fix: `process.exitCode=1` on any `ok:false`; wrapper maps Node non-zero → envelope `ok:false`.**
- **B7 — No `run_id`/idempotency substrate.** No artifact carries a `run_id`; no `run-summary.json`. **Fix: generate one `run_id` at CLI entry, thread it through env into every writer; write-back matches on `run_id` + input-bundle hash before merging.**
- **B8 — `SKILL_MODE` is net-new plumbing, not "wiring."** No `SKILL_MODE` anywhere; `run.mjs` does zero per-child env injection (ambient inheritance through two spawns). `apply_skill_mode` must mutate the real inherited env or the crawler silently calls MiniMax. **Promote "zero `model-api-connector` hits" to a hard gating test.**
- **B9 — AST-only graphify doesn't exist.** graphify is a third-party pip binary with no `--no-llm` flag (`tool.py:358-372` always passes `--backend`). §10-P1's "zero LLM hits" is unsatisfiable in P1 (self-contradiction). **Fix: pin a graphify version + confirm/file an upstream structural mode, OR scope the deterministic assembler as its own work item and accept the semantic-edge fidelity loss.**
- **B-cross — `api-test-generator` only in skill-register** (which spec-05 deletes) → §9 contradiction; needs spec-05 to migrate it into `tool_registry` first.

### 12.2 Major gaps (needed for a real rollout)

- **M1 — No PII/DLP stage; no spec owns it.** Existing redaction is secret-hygiene only. DOM text, on-screen account numbers/balances/names, typed values (spec-04 records these), full-page screenshots (`worker.mjs:172`), `storageState` — all flow to a possibly-external host = cross-border PII transfer HSBC forbids, likely a **DPIA precondition**. **New component: classify + redact so the host gets structure (selectors, counts, shapes, hashes), values/screenshots stay local; CLI-enforced approved-host + region allowlist; crawl non-prod/synthetic data.**
- **M2 — Only provider is MiniMax→public cloud (highest-leverage single build).** No generic OpenAI-compatible provider (configurable `base_url` + internal-CA trust + proxy). One such component covers **offline VMs + on-prem Azure-OpenAI-in-tenant + every non-Copilot org at once** — spec-08's `github-models.mjs` generalized. On no roadmap.
- **M3 — Prompt injection** from crawled content (`intent-extract.mjs:69-80` inlines page text verbatim) into a tool-wielding host agent. **Fix: data-only fencing; sandboxed tool-less classification; the B4 validators as a backstop that holds under full hijack.**
- **M4 — Deterministic facts are currently garbage** (spec-11 WP3 #1/#2): `pages.mjs:31` → every page title null; `:34` → `clickableCount` always 0. **Fix before P1.**
- **M5 — Reproducibility worse; audit blind to the generating half.** Host owns sampling/model-version. **Fix: stamp host provenance + prompt/response hashes; hash-chain `tool-runs.jsonl`; embedded temp-0 = the reproducible/CI mode.**
- **M6 — Three-runtime packaging** (see §6b#1) — bigger than "no installer."
- **M7 — No eval for the delegated (high-risk) path.** Golden-output guards only the deterministic half. **Fix: a delegation eval set + `testo eval-delegation` (intent F1 / edge validity); A/B gate vs MiniMax baseline; ship BYO only where ≥ MiniMax.**

### 12.3 Improvements

- **Split the value streams; ship the safe one first:** clean-JSON CLI + `run-summary.json` + WP1 fixes (pure DX, no LLM risk, useful to REPL + CI) — decouple from the inversion.
- **Host-agnostic playbook verb** `testo context --plan` that prints the next command + schema; SKILL.md becomes a thin trigger over it; ship `.github/copilot-instructions.md` + Cursor Rules day one.
- **`testo doctor`/`init` preflight** + one-command installer + pinned venv path (the skill's step-1 venv-hunt is a red flag) + a no-secrets bundled-demo quickstart.
- **Embedded = quality floor, not just offline fallback:** auto-refuse skill mode below a host-eval threshold, degrading to the embedded baseline.
- **Make the reasoning model visible:** envelope `mode` names the host/model; stderr banner `[testo] mode=skill reasoning=host(claude-code)`; never flip backends silently on argument shape; `testo repl` explicit, print help on no-TTY; namespace write-backs (`testo delegate apply-intents/apply-graph`); `testo context` refuses to run with pending delegations.
- **Small correctness fixes:** stop propagating the stale `outputDir:'output/sources/'` (`run.mjs:350`); guard `graphify/extract.mjs:111`'s unguarded `JSON.parse`; content-sanitize every crawled string entering the envelope.

### 12.4 The three decisions to make now

- **D1 — Approved host + inference location + data-egress (one coupled decision).** Claude Code → SKILL.md is the surface (as designed). Copilot → SKILL.md dead on arrival; **MCP moves from P3 to P1-critical**; pull its prerequisites forward. On-prem / Azure-OpenAI-in-tenant → **invert the thesis**: embedded-at-internal-endpoint becomes primary, BYO-host becomes the extra. Offline VMs → BYO-host breaks; only deterministic-only (degraded) or an on-prem endpoint remains.
- **D2 — Keep the embedded path as fallback/floor? (Yes — but not MiniMax-public.)** MiniMax→`api.minimaxi.chat` is un-approvable at HSBC, so "keep embedded" means **repoint it at an approved internal OpenAI-compatible endpoint (M2) and delete the MiniMax-public provider.** If you decline any embedded floor, BYO-LLM on a weaker-than-MiniMax or non-Claude host is negative-value vs the REPL — in that world ship only the clean-JSON CLI and shelve the inversion.
- **D3 — MCP now or later? Conditional on D1**, not uniformly "future." spec-05 only rejects MCP on the *internal* hot path; an *external* stdio facade doesn't contradict it. If a non-Claude host is approved, MCP is near-P0.

### 12.5 Prerequisite sequencing

- **Before P0:** spec-11 WP1 #1 (redaction — hard), WP3 #8 (exit code), coordinate the truncation edit (same files); (soft) WP4 shared flag parser / `_lib/env.py`.
- **Before P1:** `run.mjs` `SKILL_MODE` + per-child env injection; spec-11 WP3 #1/#2 (facts not garbage); resolve AST-only graphify (B9); spec-05 migrate `api-test-generator` into `tool_registry`.
- **Before P3:** deny-by-default (spec-07 WS2 / spec-05 P5); spec-10 `store-relational` + spec-09 `tool-runs.jsonl`; connector port from `feature_output_indexder`.
