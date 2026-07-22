# LLM Advisor

A tiny seam between the deterministic crawler and the HOST model (BYO-LLM:
`getClient('host')` → sampling bridge → the MCP host's LLM). Called at the
few decision-points where rules fail today.

## Decision kinds

| Kind | Asked when | Returns | Used by |
|---|---|---|---|
| `auth-detect`    | a page looks auth-related (URL pattern OR password field present) | `{type, action, steps, confidence, reasoning}` | `crawl.mjs:maybeLogin` — before attempting login. Lets the crawler skip registration / password-reset / not-auth pages and follow multi-step SSO flows. |
| `intent-extract` | once per page, AFTER the crawl finishes (in `content-extractor/crawler/extract.mjs`) | `{intents: [{i, intent, category, destructive, expectedApiCall, ...}]}` | Merged back into the bundle so the indexer can build a semantic click-graph. |

## Public API

```js
import { adviseOn } from '../llm-advisor/index.mjs';

const decision = await adviseOn({
  kind: 'auth-detect',
  input: { url, title, dom },
});
// → { kind, tookMs, usage, recommendation } OR null on any failure
```

The advisor **never throws**. Any error path returns `null` and prints a
single-line warning. Callers are expected to fall back to their existing
rule-based path when the advisor returns null.

## Env vars

| Var | Effect |
|---|---|
| `CRAWLER_LLM=0` | disables the advisor entirely (deterministic regression mode) |
| `LLM_PROVIDER` | provider selection; default `host` (the only registered provider) |
| `SAMPLING_BRIDGE_URL` | loopback URL of the MCP server's sampling bridge (required for `host`; the MCP server sets it) |
| `SAMPLING_TOKEN` | correlates this pipeline run to the in-flight MCP request |

With no bridge present the client can't be built → the advisor returns `null`
→ the crawler keeps its deterministic path.

## Design constraints

* **Never blocks the crawl for more than `timeoutMs`.** Default 25 s per decision.
* **Strips `<think>…</think>`** from every response (harmless no-op for non-reasoning host models). See `strip-think.mjs`.
* **Validates** each response against a per-kind schema. Unvalidated fields default to safe values (e.g. `safeToClick: true`).
* **Stateless** — no caching across calls (yet). The decisions are
  cheap and rare enough that page-level caching is the next thing to add
  if it ever matters.

## Adding a new decision kind

1. Drop a sibling module exporting `{ buildMessages(input), validate(raw), temperature, maxTokens, timeoutMs }`.
2. Register it in `index.mjs` `HANDLERS`:
   ```js
   const HANDLERS = {
     'auth-detect':    authDetector,
     'intent-extract': intentExtract,
     'your-new-kind':  yourModule,    // ← add here
   };
   ```

That's it. The advisor handles dispatch, error containment, JSON parsing,
and validation uniformly.
