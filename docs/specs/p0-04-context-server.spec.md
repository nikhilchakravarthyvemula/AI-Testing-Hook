# P0-04 — Context-Server MCP · SPEC

**Status:** Draft v1.0 (for review)
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

Spawned per-session by the generate stage; the spine writes the MCP config
file (`<workspace>/mcp-config.json`) that the Python seam passes to the SDK:

```jsonc
{ "mcpServers": { "context-server": {
    "command": "node",
    "args": ["context-layer/context-server/server.mjs", "--workspace", "<runDir>"]
} } }
```

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

## 4. Acceptance

1. MCP Inspector (or any MCP client) against a built logtrim store: all four
   tools answer; `get_feature_context("Checkout")` matches `store.mjs`
   `featureContext()` byte-for-byte.
2. The Claude Agent SDK session (p0-06 mock slice) successfully lists tools
   and calls `get_feature_context` over stdio.
3. Malformed input → typed MCP error, server stays up.
4. Server starts in <1s and serves from memory (single file load at boot).
