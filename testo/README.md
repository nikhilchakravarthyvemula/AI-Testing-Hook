# testo — shared runtimes

Two packages survive here after the BYO-LLM migration (spec-13). The
interactive REPL and the agentic harness were retired — the host model
(VS Code Copilot via `mcp-server/`, Claude Code via `/ctx`) is the agent now.

| Package | Role |
|---|---|
| `skill-register/` | Deterministic skill runtime. `bin/call_skill.py <skill> --mode direct --json` runs a registered skill (e.g. `api-test-generator`) and emits a machine-readable `[call_skill:result] {…}` marker line that the MCP server and `ctx.mjs` parse. |
| `model-api-connector/` | The single LLM seam: `getClient('host')`. The `host` provider POSTs chat requests to the MCP server's sampling bridge → `create_message` → the host model. No API keys. |
| `_lib/load-env.mjs` | Tiny `.env` loader used by the generators and `bin/chat.mjs`. |

Architecture: see `mcp-server/docs/ARCHITECTURE.md`.
