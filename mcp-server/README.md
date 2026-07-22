# AI-Hook MCP Server

Exposes the AI testing-hook pipeline to MCP hosts (VS Code Copilot / Cursor / any MCP client)
as MCP **tools**, using **MCP sampling** for the LLM steps — the host model does the reasoning,
so there is no API key in this server (BYO-LLM).

Lives in the monorepo at `mcp-server/` (absorbed from the standalone AI-Hook-MCP-Server repo;
its pre-merge history is on that repo's `mcp-poc` branch).

Tools: `test_app` (narrated end-to-end run), `scan`, `generate`, `execute`, `context`.
Design: `docs/ARCHITECTURE.md`. Registration: the repo-root `.vscode/mcp.json`.
