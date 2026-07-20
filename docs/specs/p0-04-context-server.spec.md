# P0-04 — Context-Server MCP · SPEC

**Status:** v1.1 — **IMPLEMENTED 2026-07-19** (`context-layer/context-server/server.mjs`).
`npm run test:mcp` — 10 in-process tests (InMemoryTransport); plus an opt-in
real-stdio smoke test (`MCP_STDIO_TEST=1`, boot + handshake ~100ms). All four
acceptance criteria verified — see §4 and §5.
**Depends on:** p0-03 (`store/knowledge.json` + `store.mjs`)
**Consumed by:** p0-06 (the A1 agent session is its only P0 client; VS Code /
other MCP hosts become clients later for free)

> Component 6. A read-only MCP server (stdio, Node) exposing the run's
> knowledge store to the generation agent — just-in-time retrieval instead of
> context-stuffing. The MCP boundary is the whole point: storage can change
> behind it (files today, anything later) without the agent noticing.

---

## 1. Purpose & Non-Goals

**Purpose.** Serve confidence-ranked, provenance-tagged, budgeted slices of
`store/knowledge.json` as MCP tools over stdio.

**Non-Goals.**
- MUST NOT expose write operations of any kind.
- MUST NOT call an LLM, the network, or anything outside the workspace.
- MUST NOT hold credentials — it reads one JSON file. (mcp-atlassian, which
  does hold credentials, is S3/P1 and a *separate* server under the
  orchestrator's MCPHost.)
- MUST NOT implement its own query logic — every tool is a thin wrapper over
  `store.mjs` (p0-03 §3), proven by shared tests.

## 2. Launch

```
node context-layer/context-server/server.mjs --workspace <runDir>
```

Spawned per-session by the generate stage (C6), which calls the server module's
own `writeMcpConfig(workspace)` to emit `<workspace>/mcp-config.json`; `runSession()`
then hands it to the `claude` CLI via `--mcp-config` (Node seam, not Python —
OQ-4). The config the helper writes:

```jsonc
{ "mcpServers": { "context-server": {
    "command": "<process.execPath>",                    // the same node binary
    "args": ["<abs>/context-layer/context-server/server.mjs", "--workspace", "<abs runDir>"]
} } }
```

**Spec-vs-reality fix (found while implementing):** the config MUST use an
**absolute** path to `server.mjs`, not the repo-relative one this spec first
sketched. The session runs with `cwd = <workspace>` (see `claude-session.mjs`),
so a repo-relative arg would resolve against the run dir and fail. The server
module owns its own launch descriptor (`mcpServerConfig()` / `writeMcpConfig()`)
so this path is computed once, from `import.meta.url`, and can't drift.

## 3. Tools

| Tool | Input | Output |
|---|---|---|
| `get_feature_context` | `{feature: "<id or name>", maxItems?: 50}` | `featureContext()` composite: feature, endpoints (confidence-ranked, provenance-tagged), pages, gaps. The primary retrieval unit. |
| `query_endpoints` | `{method?, pathContains?, featureId?, minConfidence?}` | matching endpoint facts, ranked |
| `list_gaps` | `{featureId?, severity?}` | prioritized gaps |
| `list_features` | `{}` | id, name, counts per feature — the agent's table of contents |

Every response carries `{runId, servedAt, truncated: bool}`; results are
capped by `maxItems` with `truncated: true` rather than silently clipped
(no-silent-caps rule). Unknown feature → MCP tool error with the list of
valid ids (agents recover well from that; empty results they mis-read).

**`maxItems` on the sibling tools (deliberate, spec-consistent).** The table
lists `maxItems` only on `get_feature_context`, but the cap rule above is stated
for all results. So `query_endpoints` and `list_gaps` also accept an optional
`maxItems` (default 50) and report `total` (the pre-cap count) alongside
`truncated` — a broad `query_endpoints({})` on logtrim's ~400 endpoints returns
the top 50 with `truncated: true`, which is the whole point of JIT retrieval over
context-stuffing. `list_features` stays a strict `{}` — it's a small table of
contents, never capped.

**Unknown feature is an `isError` result, not a thrown error.** A valid string
that matches nothing is an *execution* condition the model should see and
self-correct from, so it comes back as `{ isError: true, content:[…valid ids…] }`
(fed to the model). Only *protocol* violations — wrong types, unknown args,
missing required, unknown tool — throw a typed `McpError` (InvalidParams /
MethodNotFound). Acceptance 3 covers the latter.

## 4. Acceptance — all verified 2026-07-19

1. ✅ A store built from a real synthesized context, driven through a real MCP
   `Client`: all four tools answer; `get_feature_context("Checkout").context`
   `deepEqual`s `store.mjs` `featureContext("Checkout")` — same code, one
   implementation (`server.test.mjs`).
2. ✅ Real stdio: `server.mjs` spawned as a subprocess via `StdioClientTransport`
   lists all four tools and answers `get_feature_context` (`server-stdio.test.mjs`,
   opt-in). This is the mechanism the p0-06 agent session uses.
3. ✅ Malformed input (`feature: 42`, missing required, unknown arg) → typed
   `McpError -32602`, and a good call right after still succeeds — the server
   never goes down (`server.test.mjs`).
4. ✅ Boot + handshake in ~100ms (< 1s); the store is loaded once at boot and
   every tool answers from memory.

## 5. Implementation notes / deviations

- **First Node dependency: `@modelcontextprotocol/sdk`** (`^1.29.0`), used via
  its **low-level `Server`** (raw JSON-Schema tool defs + a ~30-line arg
  validator) rather than the high-level `McpServer`. The high-level API only
  validates Zod shapes; going low-level keeps the footprint to **one** package —
  we do not also import zod into our source. (The 18 `npm audit` highs are
  pre-existing, in the `crawlee` crawler workspace, not from this SDK.)
- **Owns no query logic** (Non-Goal 4). Every handler is a thin wrapper over a
  p0-03 accessor; the byte-for-byte test is what proves there's one
  implementation, so a change to `featureContext()` can never make the MCP tool
  and the report disagree.
- **`servedAt` freshness + `runId`** on every response let a caller confirm it's
  talking to *this* run's server, consistent with the blank-slate guarantee.
- **Logs to stderr only** — stdout is the JSON-RPC channel; a stray `console.log`
  there would corrupt the protocol. The boot line ("serving run … over stdio")
  goes to stderr.
- **The launch descriptor lives with the server** (`mcpServerConfig` /
  `writeMcpConfig`), so C6 writes the config by calling C4 rather than
  hand-rolling a path — see the §2 absolute-path fix.
