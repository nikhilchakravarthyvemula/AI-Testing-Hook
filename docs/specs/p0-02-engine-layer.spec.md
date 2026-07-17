# P0-02 — Engine Layer · SPEC

**Status:** Draft v1.0 (for review)
**Depends on:** p0-01 (run workspace, ledger path, budget config)
**Consumed by:** p0-03 (S2), p0-05 (S1), p0-06 (A1, S4), later S5/S6/S7
**Shared contracts:** `ledger.jsonl` (p0-00 §5), budget rule (p0-00 §5), degradation (p0-00 §4)

> Two thin engine touchpoints, each native to its caller, both engine-agnostic:
> **C2a** — the Node `model-api-connector` grows providers for single-shot
> calls (S1/S2, and S6/S7 later). **C2b** — `infrastructure/agentic-harness`
> v2, Python, runs agent sessions (A1) and exposes a Python `single_call`
> (S4/graphify, S5 later). Dev engine: Claude (enterprise Claude Code
> subscription on this machine). Work engine: Copilot SDK — **contract + stub
> in P0, implementation P1**. Test engine: mock/replay.

---

## 1. Purpose & Non-Goals

**Purpose.** Give every LLM touchpoint one interface per side, three
interchangeable engines behind it, unified ledger/budget behavior, and a
defined failure shape so callers can implement their deterministic fallbacks.

**Non-Goals.**
- MUST NOT leak engine specifics past the interface — no caller may branch on
  "is this Claude".
- MUST NOT implement the Copilot adapter beyond a stub that fails loudly —
  we cannot verify it from this machine (P1, with a seat).
- MUST NOT keep the OpenHarness backend chain (MiniMax/Kimi/Ollama agent
  path). `providers/minimax.mjs` may remain on disk, unused by P0.
- MUST NOT write to `run.json` (that's the spine's file) — engine failures are
  reported to the caller, who registers degradation via the spine helper.
- Single-shot calls MUST NOT get tools. Agent sessions MUST NOT get execution
  tools (generation and execution are separated by the checkpoint).

## 2. C2a — connector providers (Node)

### 2.1 Interface

```js
// infrastructure/model-api-connector/index.mjs
const result = await complete({
  useCase: "S1",                 // ledger tag, required
  system: "...",                 // optional
  prompt: "...",                 // required
  schema: {...},                 // optional JSON Schema for the reply
  cacheKey: "sha256:...",        // optional; default = hash(useCase+system+prompt+schema)
  workspace: "/abs/run/dir",     // required — locates cache/ and ledger.jsonl
});
// → { ok: true,  json|text, usage: {requests, inputTokens, outputTokens},
//     engine, model, cacheHit, durationMs }
// → { ok: false, error: "budget-exhausted" | "engine-unavailable" | "bad-output",
//     detail }
```

`ok: false` never throws — the caller's contract is: take your deterministic
fallback and call the spine's `markDegraded()`. Schema handling: the provider
instructs the engine to answer with JSON matching the schema, validates, and
on mismatch retries **once** with the validation errors; a second mismatch is
`bad-output`.

### 2.2 Providers

| Provider | Mechanism | Notes |
|---|---|---|
| `claude` | Spawn Claude Code headless: `claude -p <prompt> --output-format json` | Auth rides the machine's existing Claude Code login (enterprise subscription) — no API key handling in our code. Model: `CLAUDE_MODEL` env if set, else the CLI's default. Timeout per call: `ENGINE_CALL_TIMEOUT_MS` (default 120000). |
| `mock` | Replay `fixtures/engine/<useCase>/<cacheKey>.json` | Missing fixture → `engine-unavailable` (this is how CI exercises degraded paths). `MOCK_RECORD=1` + `ENGINE_PROVIDER=claude` records live responses into fixtures for later replay. |
| `copilot` | Stub — always `engine-unavailable`, message "copilot adapter is P1" | Exists so the provider contract tests (§4) already run against its shape. |
| `minimax` | Legacy, untouched | Not selectable for P0 use cases. |

### 2.3 Cache, ledger, budget

- Cache: `workspace/cache/<cacheKey>.json` — checked before budget, before
  engine. Hits are ledgered with `cacheHit: true, requests: 0`.
- Every live call appends one ledger line (p0-00 §5) whether it succeeded or
  failed.
- Budget: before a live call, sum ledger `requests`; at/over
  `budget.maxRequests` → `budget-exhausted` without calling.

## 3. C2b — harness seam v2 (Python)

Replaces the OpenHarness internals of `infrastructure/agentic-harness/`.
The public seam stays; `client.py`'s QueryEngine wiring goes.

### 3.1 Session interface

```
python -m agentic_harness.run_session \
  --slice   <workspace>/plan/slices/<featureId>.json \
  --workspace <workspace> \
  --engine  claude|mock|copilot \
  --mcp-config <workspace>/mcp-config.json
```

Behavior: run one agent session for one approved feature slice. The session
system prompt states the job (write tests for these scenarios), the workspace
conventions (files under `tests/<featureId>/`, append entries to
`tests/manifest.json` per p0-00 §7), and the tools available. Exit codes:
`0` = artifacts produced; `3` = honesty failure (see §3.3); `4` = engine
unavailable; `5` = budget exhausted. Anything nonzero → the spine falls back
to the template generator **for that slice only**.

### 3.2 Adapters

| Adapter | Mechanism | Notes |
|---|---|---|
| `claude` | **Claude Agent SDK** (`claude-agent-sdk`, Python) — `query()` with: `cwd` = workspace, MCP servers from `--mcp-config` (context-server et al., stdio), file tools allowed (writes confined to the workspace), Bash denied, `max_turns` bounded. Uses the same Claude Code subscription auth as C2a. | The claude-api skill delegates Agent SDK specifics to its own docs (`code.claude.com/docs/en/agent-sdk`) — consult them at implementation; this spec pins the contract, not the SDK call shapes. |
| `mock` | Scripted replay: fixture script per slice writes predefined test files + manifest entries | Deterministic tests of the whole generate stage without an engine. |
| `copilot` | Stub, exit 4 | Contract stands ready for the P1 Copilot SDK implementation. |

### 3.3 Honesty rule (carried from the OpenHarness lesson)

A session that ends without having written ≥1 test file **and** its manifest
entries for the slice is a **failed session (exit 3)** regardless of what the
model said. Partial output (2 of 5 scenarios) is allowed and kept — the
missing scenarios are marked `failed-generation` in the manifest so the report
counts them honestly.

### 3.4 `single_call` for Python callers (S4)

`agentic_harness.single_call(use_case, prompt, schema=None)` — same semantics
as C2a's `complete()` (cache, ledger, budget, `ok`-shaped result), same
adapters, no tools, no session. graphify's enrichment swaps its QueryEngine
call for this; its raw-AST output is the documented S4 fallback when the call
comes back `ok: false`.

### 3.5 Ledger & budget

The seam appends one ledger line per model turn (or per session if the SDK
only exposes aggregate usage — record what's real, don't fabricate per-turn
splits). Before starting a session it checks remaining budget and refuses
(exit 5) if fewer than `SESSION_MIN_BUDGET` (default 10) requests remain.

## 4. Contract tests (both sides)

A shared test suite that any provider/adapter must pass, run against `claude`
(live, opt-in), `mock` (always), `copilot` (expected-failure shape only):

1. schema-validated single call returns parsed JSON matching the schema;
2. budget exhaustion returns `budget-exhausted` without a live call;
3. cache hit returns identical payload with `cacheHit: true`, `requests: 0`;
4. engine-down returns `engine-unavailable` (never throws / never hangs past
   timeout);
5. every live call appends exactly one valid ledger line;
6. (seam) honesty rule: a session producing no files exits 3;
7. (seam) file writes outside the workspace are blocked.

## 5. Acceptance

1. `ENGINE_PROVIDER=claude`: S1-shaped schema call round-trips against the
   real engine; ledger line present; second identical call is a cache hit.
2. `ENGINE_PROVIDER=mock` with no fixtures: every call degrades cleanly;
   contract tests green in CI with zero credentials.
3. Seam mock adapter drives a full generate stage: files + manifest appear,
   spine sees exit 0.
4. Budget set to 1: second call is refused before any engine traffic.
