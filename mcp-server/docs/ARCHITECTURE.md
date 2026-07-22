# AI-Hook MCP Server — architecture

## Two dependencies, two jobs
This server does **not** re-implement crawling or hold an LLM key. It glues two things:

| | Provides | From | Required |
|---|---|---|---|
| **The pipeline** | the *hands* — crawl (Playwright), graphify code graph, extract endpoints, index, generate + run API tests | this monorepo (`AI_HOOK_ROOT` = repo root; auto-resolved by parent-walk) | yes — the server *drives* it |
| **VS Code Copilot** | the *brain* — the LLM that reasons | MCP **sampling**, once registered in VS Code | yes — no API key, the host runs it |

## The productionized flow (crawler as the example)
```
VS Code Copilot ──tool: test_app / scan──► ai_hook_mcp.server
                                   │  spawns run.mjs with
                                   │  LLM_PROVIDER=host, SAMPLING_BRIDGE_URL, SAMPLING_TOKEN
                                   ▼
              context-layer/content-extractor/crawler  (deterministic crawl)
                   └─ adviseOn(intent-extract)  →  getClient('host').chat()   [Node]
                         │  HTTP POST {messages, system, token}
                         ▼
              ai_hook_mcp.bridge (SamplingBridge, loopback HTTP)
                   └─ ctx.session.create_message(...)   ──► Copilot model ──► completion
                         ▲                                                      │
                         └──────────────── intents JSON ◄───────────────────────┘
                   crawler merges intents with its own tuned validate()/merge (unchanged)
                                   ▼
              indexer → output/indexed_output/ → api-test-generator → executor → summary
```
The elegant part: **the crawler's own `adviseOn` loop** does the classification — batching,
schema, `validate()`, merge — all reused unchanged; the provider is `host` (the only one).

## The tools

| Tool | What it does | LLM? |
|---|---|---|
| `test_app` | **the narrated end-to-end loop**: scan (crawler ∥ graphify ∥ framework-detect) → index → generate → EXECUTE against the live target → combined summary | host (crawler batches only) |
| `scan` | discover app (+ codebase) into `output/indexed_output/`; `reuse=true` skips the whole pipeline | host (crawler batches) |
| `generate` | build curl API tests from the indexed context (writes only) | none |
| `execute` | generate **and run** the API tests against the live target | none |
| `context` | read back the consumable `indexed_output/` (whole, or one topic) | none |

`generate`/`execute`/`test_app`'s test stage don't sample — they shell the deterministic
`api-test-generator` skill via `call_skill.py --json`, which emits a single
`[call_skill:result] {…}` marker line the server parses for the authoritative
`curls_generated` / `passed` / `failed` / `login_succeeded` counts. Login creds are
passed by **env** (`LOGIN_EMAIL`/`LOGIN_PASSWORD`), never argv.

`reuse` semantics differ by design: `scan.reuse` skips the whole pipeline and reads
existing output; `test_app.reuse` skips **only the crawl** (graphify/index/tests stay fresh).

## The narrated loop (`test_app`)

`milestones.py` turns the raw pipeline log into the story the user sees (stage-1 sources
run in parallel, so every line is source-prefixed); the bridge narrates each sampling
round-trip. Default is milestones-only; `verbose=true` adds the raw log (capped at 400 lines).

```
[scanner] starting scan of http://localhost:3000 + codebase /path/app
[scanner] starting stage 1 — independent primary sources
[scanner] starting crawler          [graphify] starting (code knowledge graph)
[crawler] crawling app (2 seed(s), 4 workers)
[crawler] classifying clickables on 7 page(s) via host LLM
[crawler] LLM call #1 → sending 2 message(s) to host
[crawler] ← received from host in 8.3s — resuming crawler (call #1)
… (per batch) …
[crawler] intents done — 94 clickables across 7/9 pages (61.2s)
[crawler] complete → sent to output/crawler/ (312.4 KB)
[graphify] complete → output/graphify/ (38.1s)    [graphify] graph: 658 nodes, 1893 edges
[indexer] complete → output/indexed_output/       [indexer] 12 topics indexed
[generator] 21 curls generated → output/generation/api-tests/curls/
[executor] login OK — token captured
[executor] ✓ GET /users → 200 …
[executor] 20 tests run — 18 passed, 2 failed, 1 skipped
```

## Where the code lives (monorepo)
- `mcp-server/ai_hook_mcp/server.py` — FastMCP server; the five tools above.
- `mcp-server/ai_hook_mcp/bridge.py` — `SamplingBridge`: loopback HTTP → `ctx.session.create_message`, correlated by `SAMPLING_TOKEN`; narrates round-trips for `test_app`.
- `mcp-server/ai_hook_mcp/milestones.py` — log-line → milestone matcher + `Narrator` (caps, per-test limits).
- `mcp-server/ai_hook_mcp/config.py` — resolves `AI_HOOK_ROOT` (defaults to the repo root by parent-walk).
- `testo/model-api-connector/providers/host.mjs` — `getClient('host')`: `chat()` POSTs to the bridge.
- `testo/model-api-connector/index.mjs` — the provider registry (`host` is the only entry).
- `context-layer/content-extractor/crawler/llm-advisor/index.mjs` — `LLM_PROVIDER` (default `host`) selects the provider.
- `.vscode/mcp.json` (repo root) — registers the server for Copilot Agent mode.

## The LLM connection
`getClient(provider).chat()` is the single seam. `host` → the bridge → `create_message` →
the host's model (no key). Same call site, same contract — a future provider registers
in the same table.

## Run / register
1. Open the monorepo root in VS Code — `.vscode/mcp.json` registers `ai-hook`
   (`python -m ai_hook_mcp.server`, cwd `mcp-server/`, `AI_HOOK_ROOT` = workspace root).
2. Python env: `context-layer/content-extractor/_lib/.venv` (has `mcp`; see `_lib/requirements.txt`).
3. Copilot Chat → Agent mode → ask *"test my app at http://localhost:3000, codebase /path"*
   → `test_app` runs the narrated loop. The first sampling call prompts for approval;
   Copilot Business/Enterprise needs the MCP policy enabled by an admin.
   `generate`/`execute` need no approval — they don't sample.

## Boundaries
- Real sampling needs a sampling-capable MCP client (VS Code Copilot Agent mode). The server,
  tools, config, bridge relay, and milestone matcher are testable headless; the
  `create_message` round-trip is not.
- Single-flight by default; the `token`→ctx registry supports concurrency but isn't load-tested.
- With no bridge/host present, the `host` client can't be constructed → the crawler's advisor
  returns null and the crawl proceeds deterministically (un-annotated). `CRAWLER_LLM=0`
  forces that mode explicitly.
- A full `test_app` run is minutes, not seconds — the milestone stream doubles as keep-alive.
