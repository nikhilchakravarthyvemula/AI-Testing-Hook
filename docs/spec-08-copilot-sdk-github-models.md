# Spec 08 — GitHub Copilot SDK evaluation + GitHub Models as LLM provider

_Target: **Infrastructure** (model-api-connector, agentic-harness backends).
Companion to spec-06 (GitHub device auth / enterprise egress) and spec-07 (interactive REPL)._

> **Question answered:** can the GitHub Copilot SDK (github.com/github/copilot-sdk) replace
> our OpenHarness-based engine and power the harness's LLM calling? User constraint: *if it's
> not a good replacement, integrate GitHub for LLM connections only.* (A Copilot subscription
> is available.)

---

## 1. What the Copilot SDK actually is (verified from the official repo)

- An **agent runtime, not a raw LLM API** — "exposes the same engine behind Copilot CLI"; every
  SDK spawns the proprietary Copilot CLI binary as a subprocess and talks **JSON-RPC** to it.
- GA, semver; MIT covers the SDK wrapper only (the CLI engine is proprietary).
- Packages: `@github/copilot-sdk` (Node), `github-copilot-sdk` (Python), + Go/.NET/Java/Rust.
- Custom tools, custom agents/skills, MCP client, sessions (planning / tool-invocation /
  file-edits). All Copilot CLI models. Auth: Copilot subscription (OAuth/PAT) or BYOK.
- **No chat-completions endpoint.** GitHub's sanctioned raw-LLM API is **GitHub Models**
  (`models.github.ai/inference`, OpenAI-compatible, PAT auth). Calling Copilot's *internal*
  completion endpoints directly is ToS-restricted (spec-06 §9 — account-suspension risk).

## 2. Replacement verdict: **NO — keep OpenHarness** (scored 11/25 vs 23/25)

| Dimension | OpenHarness | Copilot SDK | Why |
|---|:---:|:---:|---|
| Loop control / determinism | 5 | 2 | We own the loop: `NOT_INVOKED` honesty guard (`tool_service.py:198`), DIRECT no-LLM mode, spec-05 golden-output guarantee. SDK loop is a proprietary black box over JSON-RPC. |
| Model / cost control | 5 | 2 | MiniMax primary + Ollama offline + any OpenAI-compat endpoint + per-call usage logging. SDK = Copilot's model list, per-seat metering; strands the MiniMax investment. |
| Deployment fit (HSBC VM / offline) | 5 | 1 | Offline requirement (local mirrors + Ollama). SDK needs the non-vendorable Copilot CLI binary + live GitHub egress + user-bound seat auth. Fails outright. |
| Tool-contract fit (spec-05) | 5 | 3 | Our registry hangs off pydantic `BaseTool` with nested validation; SDK custom tools are flat JSON-schema over JSON-RPC (the same shallow-validation flaw spec-05 rejected MCP-internal for). |
| Maturity / lock-in | 3 | 3 | SDK is production-tested but proprietary + subscription-gated; OpenHarness is patchable + vendorable. |

**Post-spec-07 revision — the verdict *strengthens*:** the SDK's main selling point (a
production interactive agent runtime with sessions and permission prompts) turns out to be
something **OpenHarness already ships natively** (`ui/runtime.py`, `session_storage.py`,
`permission_dialog.py` — see spec-07 §1). Replacing the engine would discard a free REPL stack
we control. **Decision: OpenHarness is final as the engine. The Copilot-SDK-as-secondary-engine
spike is deferred indefinitely** — its residual value (Copilot-subscription models, MCP client)
is covered by GitHub Models/BYOK and spec-05's deferred external MCP facade.

## 3. Committed integration — GitHub for LLM connections only (~2 days)

### Piece A — Node provider (crawler llm-advisor seam) · ~1 day
**New** `testo/model-api-connector/providers/github-models.mjs`, mirroring
`providers/minimax.mjs`:
- `POST https://models.github.ai/inference/chat/completions`; header
  `X-GitHub-Api-Version: 2022-11-28`.
- Auth `Bearer` from `GITHUB_MODELS_TOKEN ?? GH_TOKEN ?? GITHUB_TOKEN` (fine-grained PAT with
  **Models: read**; dedicated var first so a repo-scoped token isn't silently burned on inference).
- Default model `GITHUB_MODELS_MODEL ?? 'openai/gpt-4o-mini'`; model IDs are
  publisher-prefixed — include an `openai/` prefix normalizer (bare `gpt-4o` 404s).
- OpenAI-shaped body (reuse `_normaliseMessage` / `_safeJson`); surface 429 with
  `Retry-After` / `x-ratelimit-*` headers in error messages (free-tier throttling is the
  dominant failure mode).
- **Usage-logger parity:** same never-throw `_logUsage` pattern → `output/github-models-usage.jsonl`
  (`{ts, model, inputTokens, outputTokens, totalTokens, provider:'github'}`).
- Register `github` (alias `github-models`) in `testo/model-api-connector/index.mjs`.
- `context-layer/content-extractor/crawler/llm-advisor/index.mjs:57`: `getClient('minimax')` →
  `getClient(process.env.LLM_PROVIDER ?? 'minimax')`. **MiniMax stays default**; `LLM_PROVIDER=github` opts in.

### Piece B — Python backend row (agentic-harness seam) · ~0.5 day
- `agentic_harness/enums.py`: add `GITHUB = "github"` to `BackendKind`.
- `agentic_harness/backends/catalog.py`: `BackendConfig(kind=GITHUB,
  base_url="https://models.github.ai/inference", default_model="openai/gpt-4o-mini",
  api_key_env="GITHUB_MODELS_TOKEN")`; insert in `BACKEND_PRIORITY` **between kimi and ollama**
  (zero behavior change for anyone with `MINIMAX_API_KEY` set); `DEFAULT_CONCURRENCY[GITHUB]=2`
  (tight per-minute caps).
- Downstream inherits free: `db-schema/llm/extract.py` shells to `bin/ask.py`; graphify uses
  `OPENHARNESS_BASE_URL/MODEL/API_KEY_ENV` env overrides — document the recipe in
  `context-layer/content-extractor/graphify/README.md`. *(Note: no `content-extractor/_lib/llm_backend.py` exists —
  these two seams are the complete Python surface.)*

### Piece C — REPL surfacing (lands with spec-07)
The REPL's **`/backend github`** slash command makes GitHub Models a first-class switchable
backend (engine `set_api_client` / `set_model` are runtime-mutable). This is where the Copilot
subscription pays off — **it raises GitHub Models rate limits** — not via the SDK.

### Env vars
`GITHUB_MODELS_TOKEN` (PAT, Models:read) · optional `GITHUB_MODELS_MODEL`, `GITHUB_MODELS_ORG` ·
`LLM_PROVIDER=github` (Node opt-in).

## 4. Risks
- **Rate/output caps** on GitHub Models tiers (input ~8k / output ~4–8k per request on some
  models) — keep MiniMax default, treat GitHub as burst/fallback, always set `maxTokens`.
- **Offline:** `models.github.ai` needs egress — GitHub can never replace Ollama as the offline
  fallback. HSBC proxy needs `models.github.ai` allowlisted + `NODE_EXTRA_CA_CERTS` (spec-06 §5).
- **ToS:** only GitHub Models is touched; never Copilot's internal completion endpoints (spec-06 §9).
- **Model naming 404s** — mitigated by the prefix normalizer.

## 5. Verification
1. Provider smoke: one-shot `getClient('github')` chat → non-empty content + a
   `github-models-usage.jsonl` line with token counts.
2. Crawler advisor E2E: `LLM_PROVIDER=github` + one real `auth-detector` call → same downstream
   behavior as MiniMax + usage line.
3. Python resolver: with only `GITHUB_MODELS_TOKEN` set, `bin/ask.py` auto-resolves to github,
   makes ≥1 tool call, honesty guard silent; with `MINIMAX_API_KEY` set, minimax still wins priority.
4. 429 behavior: burst 10 calls → error surfaces status + rate-limit headers (not a silent
   empty response).

## 6. Out of scope
- Copilot SDK embedding (deferred indefinitely — see §2).
- Editing `BACKEND_PRIORITY` to promote github above minimax (revisit only if MiniMax spend
  needs offloading).
- Update `docs/spec-06-github-device-auth-llm.md` §10 open question → "decided: GitHub Models"
  when implementing.
