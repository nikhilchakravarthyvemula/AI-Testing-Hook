# Spec 16 — Three-service rollout: `BYOLLM` / `testo` / `web-app`

Status: **planned** (structure + migration plan; execution phased)
Supersedes (for production): the local `scripts/skill-guard.sh` + `.claude/settings.json` read-only
approach — immutability now comes from the packaging/deployment boundary of each service.
Depends on: spec-13 (harness removed, monorepo), spec-15 (deterministic crawler, wire-guard, MCP removed).

## Context

testo works but ships as one coupled monorepo with hardcoded paths — not distributable, and the
"LLM must not edit the code / mutate the app" concern is patched with chmod. The fix is to split
into **three independently-packaged services**, each with a natural immutability boundary:

| # | Service | Packaged as | Runs on | Editable by the LLM? |
|---|---|---|---|---|
| 1 | **BYOLLM** | Claude Code plugin / Copilot instructions | the editor | No (installed plugin) |
| 2 | **testo** | npm package (`@superalign/testo`) | the **developer's device** (Win/Mac/Linux) | No (`node_modules`, hash-pinned) |
| 3 | **web-app** | Docker image → VM / container | **server** | No (**read-only image layer** — strongest) |

Because MCP chat is blocked in the client org (spec-15 Phase A removed the MCP surface), the
web-app exposes a **plain REST API** (not MCP); the skill calls it over HTTP (or drives the local
`testo` CLI).

## Why the split falls where it does

- **The crawl needs a real browser + the target's SSO session** (login-once, the headed fallback).
  That's inherently *device-local* → **Node crawler lives in `testo` (npm)**.
- **Generate / extract / execute / report is deterministic + Python + heavy** (Playwright-free) →
  containerize it → **`web-app`**. A container has no display, so it can't do interactive MFA; it
  runs headless CI crawls (staging + service account) or receives a crawl bundle from a device.
- **The reasoning is the host model** (Copilot / Claude) → **`BYOLLM`** is a thin router.

Census confirms the language boundary: **55 `.mjs` (Node)** vs **120 `.py` (Python)**.

## Target structure

```
BYOLLM/                         # Service 3 — the skill / LLM interface (editor-installed)
  ctx.mjs                       # thin CLI front door the host LLM drives (crawl → testo, gen/exec → web-app)
  skill/
    SKILL.md                    # Claude Code skill
    copilot-instructions.md     # VS Code Copilot variant (.github/)
  README.md

testo/                          # Service 1 — npm engine (Node, device-local)
  src/
    crawler/                    # Playwright crawl: walker, wire-guard, login-once, llm-advisor(deterministic)
    indexer/                    # merge source bundles → topics
  bin/{testo,ctx}.mjs           # CLI entrypoints
  package.json                  # bin + exports + files (no Python dep)
  README.md

web-app/                        # Service 2 — containerized service (Python + REST API + dashboard)
  api/                          # REST server (submit scan/gen/exec job, fetch results)
  skills/
    api-test-generator/         # generate/execute
    skill-register/             # skill runtime + call_skill
  extractors/                   # framework-detector, code-extractors, graphify, mock-data, openapi-probe, db-schema
  reporters/                    # allure, pdf
  dashboard/                    # graph-viewer, mind-map (results UI)
  _lib/                         # testing_agent shared
  Dockerfile
  pyproject.toml                # declared deps (pydantic, requests, graphifyy, playwright, fastapi/flask…)
  README.md
```

## Current → target file mapping

| Current | → | Target service |
|---|---|---|
| `byo-llm-poc/ctx.mjs`, `SKILL.md` · `.claude/skills/testo-context/SKILL.md` | → | **BYOLLM** |
| `context-layer/content-extractor/crawler/**` (Node) | → | **testo**/src/crawler |
| `context-layer/indexer/**` (Node) | → | **testo**/src/indexer |
| `testo/model-api-connector/**` (already removed spec-15; host provider only) | → | **testo** (if reinstated) |
| `generation-layer/api-test-generator/**` (Python) | → | **web-app**/skills |
| `testo/skill-register/**` (Python) | → | **web-app**/skills |
| `context-layer/content-extractor/{framework-detector,code-extractors,graphify,mock-data,openapi-probe}/**` | → | **web-app**/extractors |
| `generation-layer/{allure,pdf}-reporter`, `context-layer/{graph-viewer,mind-map-builder}` | → | **web-app**/{reporters,dashboard} |
| `context-layer/content-extractor/_lib/testing_agent` | → | **web-app**/_lib |
| `docs/**` | → | stays at repo root (all three are one git monorepo, three publish targets) |

`run.mjs` (the orchestrator) splits: its Node stages (crawler, indexer) stay in `testo`; its
Python stages (extractors) become web-app jobs invoked over the REST API.

## The device ↔ web-app contract

The one seam between the tiers. `testo` (device) crawls → emits a **crawl bundle**
(`output/crawler/bundle.json` + raw). The bundle is POSTed to the web-app, which runs the Python
pipeline and returns/stores the indexed context + generated tests + report. Contract = the existing
bundle JSON shape (already stable). Auth per tier:

| Mode | Crawl runs on | Auth |
|---|---|---|
| Interactive / dev | device (`testo`) | headed login-once (SSO + MFA) |
| Headless CI | web-app container | staging + service account, or a device-uploaded `auth-state.json` |

## Path-decoupling (the prerequisite work)

The blocker for packaging. Each service must resolve paths from **its own** root + config, not the
monorepo:
1. Replace hardcoded absolutes (`/Users/superalign/...` in `.claude/workflows/progress.js`, old
   `.vscode/mcp.json`, etc.) with package-relative resolution.
2. Retire the hand-built `context-layer/content-extractor/_lib/.venv` → **declared deps** in
   `web-app/pyproject.toml`.
3. Replace cross-folder `../../..` walks with per-package roots.
4. Split "user config" (target url, creds, output dir — a small `testo.config.json` + `.env`) from
   "engine" (everything packaged). The user's repo holds only config + `output/`.

## Migration phases

- **P0 — skeleton + spec (this).** Create `BYOLLM/`, `web-app/` folders + READMEs; write this spec.
- **P1 — carve `testo` (npm).** Move crawler + indexer under `testo/src`, add `package.json`
  bin/exports, fix relative paths, `npm pack` a tarball. Verify: `npx testo scan --url … --reuse`.
- **P2 — carve `web-app`.** Move the Python skills/extractors/reporters under `web-app/`, add
  `pyproject.toml` + a thin REST `api/` (submit bundle → generate/execute → results), Dockerfile.
  Verify: `docker build` + `curl` a generate job.
- **P3 — carve `BYOLLM`.** Thin `ctx.mjs` that calls `testo` locally + the web-app API; update
  SKILL.md + a Copilot instructions file. Package as a plugin.
- **P4 — wire the contract + auth-per-tier.** Device crawl → bundle upload → web-app compute.
- **P5 — decommission** the old `context-layer/` / `generation-layer/` / `testo/` layout.

Each phase keeps the previous working (parallel folders during migration, delete old last).

## Immutability per service (the read-only story, productionized)

- **testo:** `npm ci` (lockfile + integrity hashes) + `npm i -g` (system-owned) → the dev can't edit it.
- **web-app:** the Docker image layer is **read-only**; the container mounts only `output/`/results
  writable. The strongest boundary — the LLM literally cannot write the engine.
- **BYOLLM:** installed from a marketplace/git as a versioned plugin, outside the editable repo.
- **The target app:** already read-only via the crawler **wire-guard** (spec-15) + the REST API only
  exposing read/generate/execute-against-sandbox operations.

`scripts/skill-guard.sh` + `.claude/settings.json` remain as the **dev-time** convenience for the
un-packaged monorepo; production immutability is the packaging boundary above.

## Verification (end state)

1. `npm i -g @superalign/testo && testo scan --url <app>` on a clean Mac + Windows box.
2. `docker run web-app` + `curl` a scan→generate→execute job → results JSON + dashboard.
3. `claude plugin install byollm` (or the Copilot instructions) → `/ctx` drives testo + web-app.
4. Read-only: on the deployed web-app, an attempt to edit engine code fails (read-only layer);
   `testo` global install is system-owned; the target app shows zero mutations (wire-guard).
