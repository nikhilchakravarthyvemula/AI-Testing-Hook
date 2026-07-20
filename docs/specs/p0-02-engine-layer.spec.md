# P0-02 — Engine Layer · SPEC

**Status:** v1.2 — **C2a + C2b both implemented** 2026-07-19, all in Node
(`infrastructure/model-api-connector/`). C2a: `complete.mjs` + `cache.mjs`,
`ledger.mjs`, `schema.mjs`, `providers/{claude,mock,copilot}.mjs`. C2b:
`session.mjs` + `providers/{claude,mock,copilot}-session.mjs`. `npm run
test:engine` (30 tests + 3 opt-in live, all green). OQ-4 resolved → C2b is Node,
the Python seam is retired. Remaining: OQ-5 (S4 Python bridge, with C6).
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

## 3. C2b — agent-session seam (Node) · **IMPLEMENTED 2026-07-19**

> **OQ-4 resolved: C2b is Node, not Python.** A spike proved the `claude` CLI
> hosts a stdio MCP server (`--mcp-config`) and runs a full bounded agent
> session that reads a tool and writes files into a workspace. So the A1
> session is driven from the **same CLI the single-shot connector uses** — no
> Python, no Claude Agent SDK, no OpenHarness, no second runtime. The existing
> Python `infrastructure/agentic-harness/` package is **superseded and dormant**
> (left in place as reference / for a possible non-Claude backend; not on any
> P0 path). Implemented as `session.mjs` + `providers/{claude,mock,copilot}-
> session.mjs`; `npm run test:engine` (10 session tests + 1 opt-in live).

### 3.1 Session interface (Node function, called in-process by C6)

```js
import { runSession } from 'infrastructure/model-api-connector/index.mjs';
const r = await runSession({
  workspace, slice,            // { featureId, name, scenarios[] } — the approved slice
  mcpConfigPath,               // <workspace>/mcp-config.json (context-server et al.)
  runId, provider, model, maxRequests,
});
// → { ok:true, filesWritten:[...], usage:{turns,requests,inputTokens,outputTokens}, engine, model }
// → { ok:false, error:'budget-exhausted'|'engine-unavailable'|'honesty-failure', detail, filesWritten? }
```

C6 calls this in-process (no subprocess entrypoint needed — same runtime). The
three ok:false errors map to C6's per-slice template fallback. `runSession` owns
the **A1 behavioural contract**: it builds the session's system + user prompt
from the slice (use the MCP tools, write one file per scenario at
`tests/<featureId>/<scenarioId>.spec.mjs`, use only context the tools return,
generate mutation scenarios too), bounds it (`--max-turns`), and enforces the
honesty rule (§3.3).

### 3.2 Adapters

| Adapter | Mechanism | Notes |
|---|---|---|
| `claude` | `spawnSync` the `claude` CLI: `--print --output-format json --add-dir <ws> --mcp-config … --strict-mcp-config --allowedTools <Write/Edit/Read/Glob/Grep + mcp__*> --permission-mode acceptEdits --max-turns N`, cwd = workspace. Auth rides the machine's Claude Code login. | Bash is NOT in the allowlist → the session cannot run shell commands. `acceptEdits` (verified headless) makes writes non-interactive without disabling tool gating; `bypassPermissions` is deliberately NOT used (it would re-enable everything). |
| `mock` | Copies fixture files from `fixtures/engine/sessions/<featureId>/files/` into `tests/<featureId>/` — the same place a real session writes. A fixture dir with no `files/` is a valid "produced nothing" case (drives the honesty-failure test). | Makes the whole generate stage (C6) testable with zero credentials. |
| `copilot` | Stub → `engine-unavailable`. | P1 drop-in; contract already exercised by the tests. |

### 3.3 Honesty rule (carried from the OpenHarness lesson)

Enforced by the WRAPPER, not trusted to the model: `runSession` snapshots the
files under `tests/<featureId>/` before and after, and a session that produced
**no new file** returns `honesty-failure` regardless of what the model said —
and is still ledgered (degraded) so the report accounts for the wasted turns.
Partial output (2 of 5 scenarios) is a success here; C6 maps the produced files
to scenarios and marks the rest `failed-generation`.

**Deviation from the earlier draft (deliberate):** the SESSION writes only test
FILES; it does **not** write `tests/manifest.json`. The manifest is derived
deterministically by C6 from `filesWritten` (filename = scenarioId), because a
hand-written-by-LLM manifest is exactly the kind of thing that malforms. The
manifest stays trustworthy by never passing through the model.

### 3.4 S4 (graphify enrichment) is a Python caller — needs a bridge

graphify is Python; its S4 enrichment can't `import` the Node connector. Rather
than reintroduce a Python engine path, S4 routes through a thin
`bin/complete.mjs` CLI (a subprocess wrapper over `complete()`, so it inherits
cache/ledger/budget). **BUILT 2026-07-20** (OQ-5 closed) —
`infrastructure/model-api-connector/bin/complete.mjs` (JSON-over-stdio: request
in, `complete()` result out; exit 0 on any engine outcome, exit 2 only on a
malformed call) + the reusable Python client
`context-layer/content-extractor/graphify/s4_bridge.py` (`s4_complete(...)`, the
`single_call("S4")` replacement). Verified `test:engine`, incl. a real
`python3 → s4_bridge.py → node complete.mjs` round-trip that shares the cache
(2nd call = hit), writes the ledger line, and honours the budget. **Consumer
note:** graphify's own `QueryEngine` LLM path (`scripts/graphify/`, OpenHarness)
is retired and uninstalled (no `.venv`), so the literal in-place swap has no live
target today; the raw-AST graph (the `python-ast` extractor) is the active S4
source. When graphify's semantic stage is revived it calls `s4_bridge` instead
of constructing a `QueryEngine`. See p0-06 §8.

### 3.5 Ledger & budget

One ledger line per session (`useCase:'A1'`, `caller:'session'`), `requests` =
the CLI's `num_turns` — a session spends its turns against the same budget pool
as single-shot calls. Before starting, it refuses (`budget-exhausted`) if fewer
than `SESSION_MIN_BUDGET` (default 10) requests remain, so a session is never
kicked off with too little headroom to finish.

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

1. ✅ `provider: 'claude'`: schema call round-trips against the real engine
   (opt-in `ENGINE_LIVE_TEST=1`; verified it judged `/users/{id}` ≡ `/users/:id`
   `same:true`); ledger line present; second identical call is a cache hit.
2. ✅ `provider: 'mock'` with no fixtures: every call returns
   `engine-unavailable` cleanly; `test:engine` green with zero credentials.
3. ✅ Session mock adapter produces files into the workspace and the honesty
   rule holds; a missing fixture degrades to `engine-unavailable`; a real
   `claude` session (opt-in) reads MCP context and writes a test file
   end-to-end through `runSession()`. *(Driving a full multi-slice generate
   stage is C6's job; C2b provides and proves the per-slice mechanism.)*
4. ✅ Budget set to 1: the second call returns `budget-exhausted` before any
   engine traffic (no ledger line for the blocked call).

### 5.1 What C2a actually built vs. this spec

- **`complete()` signature** grew three options the §2.1 sketch omitted but
  every real caller needs: `provider` (default `ENGINE_PROVIDER`), `model`
  (default `MODEL_API_DEFAULT_MODEL`), and `maxRequests` (the run's budget cap,
  passed from `run.json`). Cache-hit `usage` is zeroed (`0/0/0`) to match its
  ledger line — a hit incurred nothing *this* call.
- **Budget is checked before each live call**, including the schema retry — so
  a `complete()` never overspends, and a retry that would exceed the cap is
  skipped (returns `bad-output`, "no budget to retry"). This is stricter than
  the §2.3 "before a live call" wording; it's the safe reading.
- **`schema.mjs` is a deliberate subset validator** (type/properties/required/
  items/enum/const/additionalProperties:false), same philosophy as
  `plan-schema.mjs` — no JSON-Schema dependency. Unknown keywords are not
  enforced. Keep P0 schemas within the subset or extend the file.
- **The ledger reader/`requestsSpent` moved to `ledger.mjs`** and the spine's
  `workspace.mjs` now re-exports it, so the checkpoint's budget display and the
  connector's enforcement are literally one function (no divergence risk).

## 6. Open Questions

Recorded from building C2a — each bears on the end product, not just this layer.

**OQ-1 — Per-use-case model choice (cost/quality).** `complete()` takes a
`model` override and a `MODEL_API_DEFAULT_MODEL` env default, but no default is
baked in yet. S2/S7 are cheap classification (Haiku-appropriate); S1 scenario
ideation and S4 enrichment want more capability; the A1 session (C2b) wants the
most. This is a product cost decision, not a code one. **Proposal:** a small
per-use-case model map in config (e.g. `{S1: sonnet, S2: haiku, S4: sonnet}`),
defaulting to one balanced model. Decide before C5 (S1) ships, since scenario
quality depends on it.

**OQ-2 — `claude -p` scaffolding overhead.** Measured on this machine: even
with `--system-prompt` (replace, not append), a single-shot call carries
**~15k cache-read + ~3k cache-created tokens** of Claude Code's own context,
and **5–9s latency**, before our prompt. cache-read is cheap (~0.1×) but not
free, and the latency is per-call. For high-volume Tier-1 (per-button S7,
per-document S3, per-entity S4) over a large app, that overhead dominates.
**Implication:** the CLI is fine for low-volume, high-value calls (S1, S2
residue); for high-volume calls, a direct Anthropic SDK path or GitHub Models
(batchable, no CLI scaffolding) may be the right second provider behind the same
`complete()` interface. Revisit when a use case first goes high-volume.

**OQ-3 — Budget unit: requests vs tokens vs cost.** p0-00 §5 budgets on a flat
**request count** (1 per live call). Simple and predictable, and it's what the
checkpoint shows. But the CLI reports `total_cost_usd` and real token usage that
vary wildly per call (a 5-scenario A1 session ≫ an S2 yes/no). A request-count
cap can under- or over-protect. **For P0, request-count stays** (predictable,
easy to reason about at the gate). Flagging it because when cost matters, the
ledger already carries the tokens needed to switch to a cost/token budget behind
the same check.

**OQ-4 — Does C2b need Python at all? ✅ RESOLVED 2026-07-19: no.** Spiked a
Node-driven `claude` session against a real stdio MCP server: it hosted the
server, called `get_feature_context`, and wrote a test file into the workspace
using only the tool's endpoints — bounded, exit 0. C2b is Node (§3); the
Python/Agent-SDK/OpenHarness path is retired and the existing
`infrastructure/agentic-harness/` package is dormant. The whole engine layer is
now one CLI behind one seam. *(Trade-off knowingly accepted: raw CLI JSON
parsing instead of the Agent SDK's typed session events/hooks. If we later need
per-turn hooks — e.g. live steering or fine cost control mid-session — revisit;
`--output-format stream-json` is the upgrade path without changing the seam.)*

**OQ-5 — S4's Python→Node bridge (new, from resolving OQ-4).** With the engine
layer Node-only, graphify (Python) can no longer route S4 enrichment through an
in-process seam. Plan: a thin `bin/complete.mjs` CLI that graphify shells out
to, inheriting cache/ledger/budget. Small and mechanical, but it's the one spot
where "one engine, one ledger" meets the pre-existing Python island. Build it
with the S4 re-route (C6 §5); until then graphify keeps its own LLM path and the
raw-AST graph is the S4 fallback.
