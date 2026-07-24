# Spec 15 — Copilot-deferred architecture + host-classified destructiveness

Status: **in progress** (2026-07-24)
Supersedes: the MCP/live-sampling direction of spec-13/spec-14 (`test_app`, `mcp-server/`, the sampling bridge)

## Context

The client environment has exactly one LLM available: **VS Code GitHub Copilot**. The org
**blocks MCP-server chat access** (no MCP sampling / `create_message`), **no local LLM**
(ollama) is permitted, and there are **no cloud API keys**. That removes every transport by
which the crawler (a Node subprocess) could call an LLM *live, mid-crawl*.

Therefore there is exactly one viable shape: **deferred delegation, with the host (Copilot in
agent mode, or Claude Code `/ctx`) as the LLM.** The crawler runs fully deterministic, records
everything, and hands off; the host reads the recorded artifacts, classifies, and writes back
via files. No MCP, no bridge, no key, no local model.

### Why this was forced by a real gap

The prior "deterministic regex is enough" claim was wrong. Reading `walker/scanner.mjs`:
1. **Icon-only destructive controls get clicked** — the destructive filter (`scanner.mjs:391`)
   only fires when `userSignal` (text/aria/title/tooltip/svg-title/testid) is non-empty; a
   label-less trash icon evades it and is clicked by index (`:392`). Live-safety depends on the
   app's accessibility hygiene.
2. **The regex over-blocks features** — `cancel|remove|clear|reset|archive|…` also matches
   "Cancel" (dialog dismiss), "Remove filter", "Clear search" — safe controls that then never
   get explored.
3. **Depth is lost** — a flagged destructive control is recorded but never clicked
   (`items.push(base); continue`), so the flow *behind* delete/deactivate features is never mapped.

Destructiveness is **contextual and semantic** — a classifier's job, not a keyword's. Since the
only classifier is Copilot and it can't be called live, classification moves to the deferred
host step.

## Decisions (final)

| Fork | Decision |
|---|---|
| Transport | **Deferred delegation only.** Remove all MCP (server + bridge + `test_app` + sampling). Copilot/Claude Code = the LLM, via files. |
| `CRAWLER_LLM` | **Removed.** The crawler never calls an LLM (no transport); it always records raw + host classifies. |
| Destructiveness | **Host-classified.** Regex becomes a cheap pre-flag; the host assigns a class (`irreversible`/`recoverable`/`safe`/`unknown`). Server re-derives the final safety flag. |
| Exploration policy | **Click everything; block writes at the wire.** A `page.route()` mutation-guard aborts `PUT/PATCH/DELETE` (and non-read `POST`) *before they leave the browser*, so the crawler can click every control — including a Confirm-Delete — for full coverage while no mutation reaches the server. The HTTP method is the deterministic safety gate; the label-regex demotes to a hint. (Replaces the earlier confirm-suppression idea — the user's better design.) Only session-breakers (logout/sign-out) stay skipped, since they destroy the client session, not just a server row. |
| Client entry point | **VS Code Copilot** prompt-file / `copilot-instructions.md` mirroring the `/ctx` skill; Claude Code `/ctx` kept in parallel. |

## Architecture

```
Copilot agent mode (or Claude Code /ctx) — THE LLM
   │  runs: node byo-llm-poc/ctx.mjs scan …
   ▼
crawler (deterministic, regex pre-flag) — records EVERY clickable incl. destructive
   ▼  delegation files: raw clickables + destructive-flagged set + schema
Copilot classifies: intent + destructivenessClass per control        ← the "LLM call", deferred
   ▼  host-intents.json
ctx.mjs annotate-intents — merge by id; deriveSafety RE-DERIVES (never-set always irreversible)
   ▼
(pass 2) ctx.mjs explore-destructive — re-crawl host-approved recoverable/safe controls,
   auto-dismiss confirm dialogs, never click final Confirm; skip never-set
   ▼
generate → execute (irreversible paths exempt from live execution)
```

## Destructiveness taxonomy

- `irreversible` — catastrophic/unrecoverable: delete account, delete org, delete user, purge,
  wipe, revoke-all, logout-self. **Never clicked; map-only; tests marked sandbox-only.**
- `recoverable` — reversible/low-stakes: delete draft, archive, remove item, disable toggle,
  clear filter. **Explored in pass 2 with confirm-suppression.**
- `safe` — regex false-positive: "Cancel" (dialog), "Remove filter", "Clear search", "Reset
  form". **Explored normally.**
- `unknown` — icon-only / ambiguous / no signal. **Surfaced for host adjudication; default to
  map-only until classified.**

**Server-side authority (`deriveSafety`):** the `NEVER_SET` (delete-account|org|self, logout,
close-account) is forced `irreversible` regardless of what the host returns — a hijacked or
hallucinating host cannot green-light a catastrophic control. The host can only *downgrade*
risk within safe bounds, never override the never-set.

## Implementation phases

- **A — remove MCP surface:** delete `mcp-server/`, `byo-llm-poc/mcp_server.py`, `.vscode/mcp.json`,
  `testo/model-api-connector/providers/host.mjs` (+ `model-api-connector/` if orphaned).
- **B — crawler deterministic:** drop `CRAWLER_LLM` from `ctx.mjs`; `llm-advisor` client → always
  null (LLM unavailable); short-circuit the intent-extract LLM loop in `crawler/extract.mjs`;
  deterministic auth-detect/clickable-suggest fallbacks remain.
- **C — destructiveness classification:** `INTENT_SCHEMA` gains `destructivenessClass`;
  `writeIntentDelegation` surfaces destructive-flagged + icon-only-unknown controls for host
  adjudication; `deriveSafety` incorporates the class + `NEVER_SET`. Fixes gaps 1–2.
- **D — wire-level mutation guard (the user's design; replaces confirm-suppression):**
  `crawl.mjs attachListeners` installs `page.route('**/*')` per worker page. Reads
  (`GET/HEAD/OPTIONS`) and all auth/session infra (`AUTH_ALLOW_RE` — `/oidc|/token|/refresh|…`,
  never blocked) `route.continue()`; writes (`PUT/PATCH/DELETE`, non-read `POST`) `route.abort()`
  (or `fulfill` a 200 mock under `INTERCEPT_MODE=mock`) and are captured to
  `output/crawler/raw/blocked-mutations.ndjson` (method + path + body + `Authorization` header).
  Env: `INTERCEPT_MODE=abort|mock|off`, `INTERCEPT_BLOCK_POST=writes|all|none`. **Done + unit-verified.**
  - **D2 (done): the click filter is relaxed** — `scanner.mjs` flags destructive controls
    (`base.destructive=true`) but still clicks them (the wire-guard protects); a `NEVER_CLICK_REGEX`
    (logout/sign-out + account/org-level delete/close/deactivate), threaded crawl.mjs→pool→worker→
    scanner as `neverRe`, is checked FIRST and independently and stays skipped. Unit-verified across
    the decision table; needs a live run with a fresh `login-once` for end-to-end confirmation.
  - **Bonus:** the captured `Authorization: Bearer …` header feeds the generator → fixes the
    earlier "generated curls carry no token → 401" gap.
  - **D3 — save EVERYTHING with a blocked flag (done):** every request is written to
    `requests.ndjson` with `blocked` / `reachedServer` / `interceptAction`; blocked writes (which
    have no response) are folded back into `analyze.mjs`'s endpoint list flagged
    `blocked:true` + `interceptedSamples`, and the flag is carried through the indexer into
    `apis.json`. So the host sees the FULL API surface — including the destructive calls we
    clicked but intercepted — and decides what to do with each (test-only, sandbox, skip).
- **The LLM's role shrinks** to what it does well and can do deferred: classifying the intent +
  destructiveness of **captured real requests** (method + path + body — far richer than a button
  label), not guessing from text. Safety is deterministic (the method gate); classification is
  deferred (host).
- **E — VS Code Copilot entry point:** prompt-file / `copilot-instructions.md` driving the loop
  in Copilot agent mode.

## Verification

- Headless (A–C): syntax/compile; `deriveSafety` unit table (never-set → irreversible even if host
  says safe; recoverable stays explorable; icon-only → unknown); dead-ref grep for
  `mcp|test_app|CRAWLER_LLM|sampling|create_message|host provider`.
- Live (D–E, needs a fresh `login-once` session): re-crawl explores recoverable controls, dismisses
  confirms, never fires a never-set mutation; Copilot agent-mode drives the full loop.
