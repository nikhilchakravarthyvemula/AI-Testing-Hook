# Spec 17 — Dialect adapters: generalizing the scanner beyond REST + React

Status: **planned** (2026-08-06)
Builds on: spec-15 (wire-level mutation guard, deferred host classification)

## Context

The product has to work against whatever the customer runs — not just React SPAs speaking
REST. The immediate forcing case is **GraphQL-only applications**, where the current pipeline
doesn't degrade gracefully, it degrades *completely*. All of these are verified against the
code, not hypothetical:

1. **The API inventory collapses to one row.** `analyze.mjs` keys endpoints as
   `METHOD origin/templatedPath` (`epKey`, `analyze.mjs:158`). On a GraphQL app every call is
   `POST /graphql`, so fifty queries and twenty mutations dedupe into a single endpoint. Gap
   analysis, feature slices, coverage PDFs, and test-gen all inherit the collapse.

2. **The spec-15 mutation guard is broken for GraphQL — a live data-safety bug.** Spec-15 D2
   relaxed the click filter ("click everything, the wire guard blocks writes"). But
   `READ_POST_RE` (`crawl.mjs:129`) whitelists `graphql` as read-shaped, so `isWriteRequest`
   returns false and **GraphQL mutations pass the guard to the real server**. Clicking a
   Confirm-Delete on a GraphQL target fires the actual deletion. The spec-15 safety promise
   ("no mutation reaches the server") only holds for REST verbs today.

3. **Subscriptions are invisible.** The websocket listener (`crawl.mjs:473`) records
   open/close and frame *counts* only — no payloads. GraphQL subscriptions, Socket.IO,
   SignalR contribute zero API surface.

4. **Spec + test-gen assume REST semantics.** OpenAPI output, status-code assertions,
   query-param models (`spec.mjs:229`). GraphQL returns **200 for errors**; the signal is the
   `errors[]` array. Auth/negative tests shaped around status codes assert the wrong thing.

5. **Frontend heuristics are SPA-component-library-tuned, not universal.** `tableReady`
   waits on shadcn/MUI skeleton markers (`worker.mjs:43`); route identity is pathname-based
   and already known-broken on hash-routed SPAs (the pulseviews gap); the scanner doesn't
   pierce shadow DOM or iframes.

What is **already general** and must not be rebuilt: Playwright drives the DOM (framework-
agnostic — MPAs and non-React SPAs mostly work), and the wire listeners capture every byte
regardless of protocol. The gap is concentrated in one assumption: *"an API operation =
HTTP method + URL path."* This spec replaces that assumption with a pluggable layer.

## Decisions (final)

| Fork | Decision |
|---|---|
| Core abstraction | A normalized **operation record** replaces `method+path` as the unit everything downstream consumes. REST is just the first dialect; its records are byte-compatible with today's endpoint rows (`dialect:'rest'` added), so downstream consumers don't break. |
| Where dialects plug in | One **dialect-adapter layer** between raw capture and analysis: `detect(request) → dialect`, `identify(request) → opId`, `isWrite(request) → bool`, `paramModel(samples)`, `assertModel(op)`. New protocol = new adapter module, never a pipeline fork. |
| Mutation guard | Becomes **dialect-aware and fail-closed**: for GraphQL-shaped requests, parse the body — `query` continues, `mutation` aborts+captures, unparseable body **aborts** (a blocked read is re-issuable; a leaked write is not). `graphql` is removed from `READ_POST_RE`. |
| GraphQL schema | Try **introspection once** at scan start; on refusal (common in prod) fall back to **schema inference from observed query docs + response samples**. Parsing uses the `graphql` npm package — deterministic, no LLM. |
| Frontend generality | A **fingerprint probe** on the first page (framework globals, router type, first traffic's dialect, introspection availability) selects settle strategy, route-keying, and adapters per target. No hardcoded React assumptions in the walker. |
| LLM's role | Unchanged from spec-15: semantics only (intent, feature naming, ambiguous read/write adjudication for JSON-RPC-style dialects), always on the compact normalized bundle — never parsing raw wire logs or HARs. |
| Product scope | **Anything in a browser over HTTP/WS.** Native mobile/desktop acquisition (Appium et al.) is out of scope; the adapter seam stays open for it. |

## Architecture

```
walker (Playwright, framework-agnostic)         fingerprint probe (first page):
   │  passive wire capture — protocol-blind      framework / router / dialects /
   ▼                                             introspection → strategy config
raw streams: requests / responses / ws-frames (NEW: payloads) / blocked
   ▼
dialect layer (deterministic):  detect → identify → read/write → normalize
   ▼
operations.ndjson — the pivot artifact
   ▼
analyze (op-keyed) → spec artifacts (OpenAPI + GraphQL SDL) → gap / slices / reports
   ▼
test-gen per dialect (REST curls; GraphQL docs + errors[]-aware assertions)
```

## The operation record

```jsonc
{
  "dialect": "graphql",                  // rest | graphql | trpc | jsonrpc | grpc-web | ws-*
  "opId": "mutation CreateUser",         // dialect-canonical identity (see table)
  "transport": { "method": "POST", "url": "/graphql" },
  "kind": "write",                       // read | write | subscribe
  "params": { /* inferred model: variables / query params / body shape */ },
  "responseSample": { /* redacted, hashed body ref */ },
  "auth": { "bearer": true, "cookie": false },
  "blocked": true,                       // spec-15 D3 flag carried through
  "pages": ["https://app/users"],        // provenance: which pages fired it
  "via": ["click:Create user"]           // click-graph attribution when known
}
```

## Dialects

| Dialect | Detect | Operation identity | Read/write |
|---|---|---|---|
| REST | default | method + templated path (today's `epKey`) | HTTP verb (unchanged) |
| GraphQL | body `{query,variables}` / content-type / `/graphql` | operationName; anonymous ops → hash of normalized doc; APQ persisted queries → the sha256 they send | AST operation type; unparseable → write (fail closed) |
| tRPC | `/api/trpc/<procs>` | procedure name; **split batched calls** (`a.b,c.d?batch=1`) into per-proc records | proc name heuristic + host adjudication |
| JSON-RPC | body `{jsonrpc,"method"}` | `method` field | naming heuristic + host adjudication |
| gRPC-web | content-type `application/grpc-web*` | `/pkg.Service/Method` path | method-name heuristic |
| WS subprotocols | upgrade + first frames (graphql-ws, socket.io, signalr) | per-subprotocol message type | passive observe only; never replayed by the guard |

## Implementation phases

- **A — close the GraphQL guard hole (urgent, small):** `isWriteRequest` gains a body-aware
  branch; drop `graphql` from `READ_POST_RE`; fail-closed rule as decided above. Blocked
  mutations land in `blocked-mutations.ndjson` keyed by operation, not URL. *Until A ships,
  GraphQL targets must not be full-click crawled.*
- **B — WS frame payloads:** record frame bodies (size-capped, redacted) in
  `websockets.ndjson`; tag graphql-ws / socket.io subprotocols. Unlocks subscriptions.
- **C — dialect layer + operation-keyed analyze (the core):** adapter modules under
  `crawler/dialects/`; `analyze.mjs` keys by `(dialect, opId)` instead of `epKey`; bundle and
  indexer carry `dialect` through. REST output stays byte-compatible. Roughly the size of
  analyze.mjs itself.
- **D — GraphQL artifacts + test-gen:** introspection-else-inferred SDL alongside OpenAPI;
  generated tests assert on `errors[]`/`data` (not status), cover auth-off, bad-variables,
  and blocked-mutation candidates; `synthesize-urls`'s detail fan-out ported to variables
  (mine ids from observed list-query responses, re-issue detail queries).
- **E — fingerprint probe + frontend strategies:** probe result configures settle strategy
  (layered: network-quiet → DOM-quiet → component-lib skeletons as one option, not the
  default), and route identity (pathname vs hash — fixes the known hash-SPA gap in the same
  stroke).
- **F — scanner reach:** shadow-DOM piercing and same-origin iframe traversal in
  `scanner.mjs`.

## Non-goals

Native mobile/desktop drivers; gRPC over HTTP/2 outside grpc-web; dialect adapters nobody has
asked for yet (SOAP stays a detection stub that logs, nothing more); LLM parsing of raw
capture (settled in the context-layer research — relations are deterministic).

## Verification

- **A:** unit table over the guard: GraphQL query → continue; mutation → abort+capture;
  malformed body on graphql-ish URL → abort; REST verbs unchanged. Live: full-click a
  GraphQL staging app, assert zero mutations server-side.
- **B:** subscription-bearing app yields frame payloads with subprotocol tags.
- **C:** fixture wire-logs (REST-only, GraphQL-only, mixed) → operation counts match hand
  counts; REST-only output diff-identical to pre-C analyze output (backcompat gate).
- **D:** generated GraphQL tests pass against a known-good target and fail correctly against
  a seeded-error one (errors[] asserted, not status 200).
- **E:** hash-routed fixture app: route fan-out works (today's known failure becomes the
  regression test); settle strategy chosen by probe is logged per run.
- **F:** web-component fixture: interactables inside shadow roots appear in the scan.
