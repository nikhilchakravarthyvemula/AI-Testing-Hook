# Spec 14 — run_all: the narrated end-to-end pipeline (`test_app`)

Status: **implemented** (2026-07-22, bundled with spec-13)
Depends on: spec-13 (harness removed, graphify direct-deterministic, MiniMax gone, monorepo)

## Context

From the user's handwritten notes (2026-07-22) — the exact experience expected when
the skill / MCP server tests an app, one continuous narrated invocation loop:

```
Starts skill/mcp server
→ Starting scanner → Starting crawler
→ LLM call from crawler → Sending to Copilot → Received from Copilot → Sent to crawler
→ resuming crawler   (⋮ repeats per clickable batch — THE loop)
→ Crawler completes → Sent to output
→ Starting graphify → ⋮ goes on (generator, executor…)
```

Explicit asks: **don't skip graphify**; **add generator and executor to the loop**.
The host invokes ONE entry point against the target app; the pipeline narrates every
milestone; LLM round-trips happen only inside the crawler batches; graphify /
generator / executor are deterministic and just report progress; results land in
`output/` with a final summary.

Decisions (user-confirmed): one end-to-end tool + keep the granular tools; keep
stage-1 parallelism with per-source-labeled milestones; bundle on top of spec-13
(this spec LIFTS spec-13's `SKIP=graphify`); executor = one `--execute true`
invocation narrated as two milestones.

## What was built

### `test_app` MCP tool (`mcp-server/ai_hook_mcp/server.py`)
`test_app(url, codebase="", login_email="", login_password="", max_tests=0,
reuse=False, verbose=False)`:
scan (crawler ∥ graphify ∥ framework-detector; NO graphify skip) → index →
ONE `call_skill.py api-test-generator --json --execute true` → combined summary
`{ok, run_id, stages[], topics, tests_generated, executed, passed, failed, skipped,
loginOk, paths{indexed,tests,results,report,graph}}`.
- Aborts with `{ok:false, partial:true}` if extract/index fails — never generates
  tests from a stale index.
- `reuse=true` skips ONLY the crawl (`SKIP=crawler`; graphify/index/tests stay
  fresh) — deliberately different from `scan.reuse` (skips everything); both
  docstrings say so.
- Credentials: tool args → child env (`LOGIN_EMAIL`/`LOGIN_PASSWORD`) — never argv.
- Shares plumbing with `scan` via `_host_env()` + `_scan_pipeline()`; FastMCP
  `@mcp.tool()` returns the original function, so tools stay plain callables.

### Milestone narration (`mcp-server/ai_hook_mcp/milestones.py` — NEW, pure module)
- `strip_tags()` — parallel-mode run.mjs stacks prefixes (`[content-extractor]
  [crawler] [crawler] …`, up to 3 deep); a run of leading `[tag] ` tokens is
  stripped before matching.
- `match(line)` — regex→template table over the REAL pipeline line shapes
  (calibrated against a captured run log): stage banners, `→/✓/✗/○` source rows,
  crawl walker, login detection, intent-extract page/summary rows, crawler/graphify
  bundle rows, indexer rows, api-test login + per-test `✓/✗ METHOD path → status` rows.
- `Narrator` — milestones always (per-test rows capped at 30 + one "more in
  report.md" line; exempt rows counted, summarized once at the end); raw lines only
  with `verbose=true`, capped at 400 + notice. Default = milestones only.
- `↳ batch i/n` lines are deliberately unmatched — the bridge narrates the
  round-trip instead (no double lines).

### Bridge round-trip narration (`mcp-server/ai_hook_mcp/bridge.py`)
`register(token, ctx, narrate=False)` + per-token call counter (event-loop
confined, race-free). When narrating:
`[crawler] LLM call #N → sending K message(s) to host` before `create_message`,
`[crawler] ← received from host in Ss — resuming crawler (call #N)` after.
`scan` registers with narrate=False → behavior unchanged.

### Skill surface parity (`byo-llm-poc/ctx.mjs` + SKILL.md)
- graphify skip LIFTED (`skillModeEnv` no longer sets `SKIP=graphify`; the
  `LLM_FRAMEWORK_DETECTION` knob is gone — detection is deterministic by
  construction after spec-13).
- New commands: `ctx generate [--url --max-tests]` (curls only) and
  `ctx execute [--url --max-tests]` (generate + run). Both shell
  `call_skill.py --json`, capture the `[call_skill:result]` marker (never logged
  raw), print `[generator]`/`[executor]` milestone lines to stderr, and keep the
  one-JSON-object-on-stdout contract. Credentials via inherited env ONLY — no
  credential flags exist.
- SKILL.md (both copies) is now the 5-step loop: scan → classify → annotate →
  generate → execute, with never-echo-credentials instructions.

### Non-goal
`byo-llm-poc/mcp_server.py` (the POC server, registered as `testo-context`)
gets NO run_all — it is superseded by `mcp-server/` and kept only as the
spec-12 POC artifact.

## The narration, end to end

```
[scanner] starting scan of http://localhost:3000 + codebase /path/app
[scanner] starting stage 1 — independent primary sources
[scanner] starting crawler          [graphify] starting (code knowledge graph)
[crawler] crawling app (2 seed(s), 4 workers)
[crawler] classifying clickables on 7 page(s) via host LLM
[crawler] LLM call #1 → sending 2 message(s) to host
[crawler] ← received from host in 8.3s — resuming crawler (call #1)
… (per batch — THE loop from the notes) …
[crawler] intents done — 94 clickables across 7/9 pages (61.2s)
[crawler] complete → sent to output/crawler/ (312.4 KB)
[graphify] complete → output/graphify/ (38.1s)    [graphify] graph: 658 nodes, 1893 edges
[indexer] complete → output/indexed_output/       [indexer] 12 topics indexed
[generator] 21 curls generated → output/generation/api-tests/curls/
[executor] login OK — token captured
[executor] ✓ GET /users → 200 …
[executor] 20 tests run — 18 passed, 2 failed, 1 skipped
```

## Verification performed
- `mcp.list_tools()` → `['context','execute','generate','scan','test_app']`.
- Milestone matcher run against the captured fixture
  (`output/tool-runs/ctx-run-2026-07-20T07-03-45-598Z-1bbf3a9.log`): clean
  milestones, no exceptions on stacked-prefix/glyph lines; synthetic lines for
  every table row map to the expected vocabulary; batch + exempt rows suppressed.
- `ctx generate --max-tests 2 --json` → one JSON envelope, `curls_generated: 2`.
- Graphify-direct smoke: 57 nodes / 96 edges bundle, `ok:true, stale:false`.

## Known limits
- The `create_message` round-trip (and therefore live `test_app` narration) needs a
  sampling-capable host (VS Code Copilot Agent mode) — not testable headless.
- A full run is minutes; the milestone stream doubles as keep-alive, but host
  timeout behavior varies.
- Graphify's own stdout is version-dependent; milestones anchor only on run.mjs
  rows + our wrapper's bundle/stats lines.
