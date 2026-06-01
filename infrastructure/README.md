# Cross-Cutting Infrastructure

| Component | Role | Status |
|---|---|---|
| `model-api-connector/` | Pluggable LLM client interface (OpenAI-compat, Anthropic, Gemini, local Ollama). **No LLM hits yet** — scaffold for the eventual LLM phase. | scaffold |
| `agentic-harness/` | OpenHarness `QueryEngine` wrapper. **No LLM hits yet** — scaffold for the eventual agentic loop. | scaffold |
| `skill-register/` | `skills.json` — list of installable external skills (graphify, browser-trace, etc.) | planned |
| `postgresql/` | Persistence for multi-target / history needs | deferred |
| `container-deploy/` | Dockerfile + compose for CI usage | deferred |
