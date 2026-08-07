# Spec 18 — Session-race-free parallel crawling under rotating-token auth

Status: **planned** (2026-08-06)
Builds on: spec-15 (wire-level `page.route` interception — the broker composes with it),
spec-17 (fingerprint probe — `sessionType` detection lands there; this spec consumes it)

> **Implementation note for the coding agent picking this up on another machine.**
> You will implement this with no access to the conversation that produced it — everything
> needed is in this file. Every change site carries BOTH a `file:line` (from the tree as of
> commit `9cde54a`, branch `feature_byoh`) AND a **grep anchor** (a string unique enough to
> relocate the spot when line numbers drift — they will). Prefer the grep anchor. If a cited
> file doesn't exist in your tree, the **"if missing"** notes say what to do. Do the phases
> **in order**, commit per phase — each is independently shippable. **Do not** refactor
> `SharedState` into threads/processes (Phase G explains why): its race-safety depends on
> Node's single-threaded scheduling — every shared read+write pair must stay in one
> synchronous block with no `await` between (grep anchor: `race-safe` in `walker/state.mjs`).

## Context — why 8 workers is currently *slower* than 1

Measured on the primary OIDC target (recorded in project memory): `CRAWL_WORKERS=1` covered
**58 pages**; `CRAWL_WORKERS=8` covered **5** in the same budget. Parallelism already exists and
is race-safe (`walker/pool.mjs`, `walker/state.mjs`) — it just *loses* on this app class.
Parallelism here is a **coverage regression**, not merely a speed one. Every claim below is
anchored in code.

| # | Blocker | file:line | grep anchor | Class |
|---|---|---|---|---|
| 1 | Single-use rotating refresh token — N contexts clone one refresh cookie; first refresh rotates it, other N−1 get 401→/login; recovery serialized ~75s each | `pool.mjs:112-119`, `crawl.mjs:215-220`, `crawl.mjs:829-844` | `newSeededContext`, `serializedRecover`, `settle(22_000)` | correctness |
| 2 | Bounced task requeued only once; concurrent bounces exhaust the one retry while auth still poisoned → URL dropped silently (the 58→5 mechanism) | `worker.mjs:201-207` | `reauthRetried` | correctness |
| 3 | `persistSession` last-writer-wins; a stale rotation clobbers a newer one on the shared file. Guard rejects *empty* captures, not *stale* ones | `crawl.mjs:781-791` | `persistSession` | correctness |
| 4 | Synchronous sha256 of every response body on the shared event loop stalls all workers' `setTimeout` timers | `crawl.mjs:410-424` | `createHash('sha256')` | throughput |
| 5 | Task granularity = page + full (unbounded) click loop; one heavy page pins a worker while others idle-poll a shallow queue | `worker.mjs:317`, `worker.mjs:65-71` | `slice(0, maxClicksPerPage)`, `MAX_LIST_ITEMS_PER_NAV` | throughput |
| 6 | ~1.5-2 min serial startup: pre-discovery + per-worker `networkidle` waits that always time out on SPAs, +2.5s stagger | `pool.mjs:140`, `crawl.mjs:1021`, `pool.mjs:196` | `networkidle', { timeout: 8_000 }`, `STAGGER_MS` | throughput |
| 7 | Scaling ceiling: `SharedState` in-memory single-thread; one Chromium shared by all contexts | `state.mjs:3-9`, `worker.mjs:6-10` | `race-safe` | scale |

Every recovery rotates the token **again**, which can invalidate a sibling that was healthy —
so the race cascades for the whole run. The existing warm-up (grep: `AUTH WARM-UP` in
`pool.mjs`) only protects **startup**: fan-out contexts still share one refresh cookie, so the
first mid-run access-token expiry (TTL is minutes) re-triggers the whole race.

**Critical scoping fact:** blockers 1-3 are specific to the **rotating-refresh-token** auth
class. On a plain cookie-session or static-bearer app, today's fan-out already works. The fix is
therefore **mode selection**, not a hardcoded `CRAWL_WORKERS=1`. Mode detection is added to
spec-17's fingerprint probe (Phase F).

## Decisions (final)

| Fork | Decision |
|---|---|
| Core mechanism | **Token broker**: exactly ONE long-lived context owns the refresh chain. Workers never refresh. One chain, N consumers. This breaks the race at its source. |
| How workers stay authed | **Two layers, both on:** (a) **refresh-mock** — intercept the app's own `POST /oidc/refresh` (and lookalikes) in worker contexts and `route.fulfill()` the broker's latest verbatim refresh response, so the app's *own* client code stores the token and route guards pass with zero app-specific storage knowledge; (b) **header rewrite** — belt-and-braces `Authorization: Bearer <broker.current()>` on same-origin non-auth API requests. |
| Bounce handling | **Auth-health-gated backoff requeue**, retry budget 3 (was 1), with a `notBefore` delay. A task is never silently dropped while auth is poisoned. |
| Session persistence | **Monotonic**, via a sidecar `auth-state.meta.json` (rotation counter + JWT `iat`) — NOT written inside `auth-state.json` (Playwright owns that shape). Never overwrite newer with older. |
| Body hashing | Skip sha256 above `BODY_HASH_MAX_BYTES` (default 262144); record `bodyLen`, `bodyUnhashed:true`. Worker-thread pool is a later option, out of scope here. |
| Click granularity | Split a page's click list into batches of `CLICK_BATCH_SIZE` (default 10); remainder re-enqueued as a continuation task. Transition claims already make resumption idempotent (grep: `tryClaim`). |
| Setup settles | Extract the worker's content-based settle (grep: `innerText.length > 200` in `worker.mjs`) into a shared helper; replace every setup-path `networkidle` with it. |
| Mode selection | `CRAWL_AUTH_MODE=auto\|broker\|shared\|off`. Default `auto`: broker when a saved auth-state exists AND a refresh/token endpoint is observed during warm-up; `shared` = today's behavior (fallback); `off` = no auth handling. Detection feeds spec-17's probe (Phase F). |
| Backwards compat | On a cookie-session / static-bearer app the broker relays a token that never rotates (or `current()===null`), so the new path is **behaviorally identical** to today. No regression on the currently-working class. |
| Scale ceiling | Accepted non-goal: one process, one browser, in-memory SharedState. Multi-process / SQLite queue is Phase G, out of scope. |

## Architecture

```
                 ┌────────────────────────────────────────────┐
                 │ TOKEN BROKER (1 dedicated context)         │
                 │  · only holder of the live refresh cookie  │
                 │  · completes silent SSO once, then         │
                 │    re-refreshes at ~60% of token lifetime  │
                 │  · captures off the wire:                  │
                 │      - Authorization header (bearer)       │
                 │      - full refresh RESPONSE body+headers  │
                 │  · exposes: current(), latestRefreshRes(), │
                 │             healthy(), onRotate(cb),       │
                 │             storageState(), stop()         │
                 └───────┬────────────────────────────────────┘
                         │ push (in-process, single writer)
   ┌─────────────────────┼─────────────────────┐
   ▼                     ▼                     ▼
 worker 1 ctx        worker 2 ctx    …     worker N ctx
   route('**/*') handler — ORDER IS FIXED (invariant):
     1. app's own refresh call?  → FULFILL from broker cache (layer a)
     2. other AUTH_ALLOW_RE?     → continue()  (IdP/SSO infra untouched)
     3. spec-15 write?           → abort/mock + capture (unchanged)
     4. else same-origin         → continue({ +Authorization from broker })  (layer b)
   SharedState: authHealthy flag · notBefore-aware dequeue · retry budget 3
```

The broker is a promotion of what `harvest-token.mjs` already does (capture the app's bearer off
the wire — grep: `headers['authorization']`) into a **continuous** role: keep a live session,
catch each rotation, publish it. Workers become pure consumers.

## Implementation phases

### Phase A — token broker (the unlock) — blocker 1

**New file:** `testo/src/crawler/walker/token-broker.mjs`

```js
// Contract (all in-process, no persistence of its own):
export async function startTokenBroker({ browser, storageStateProvider, baseUrl,
                                         seedPath, refreshUrlRe, log }) => ({
  current(),               // → string|null   latest bearer (no "Bearer " prefix)
  latestRefreshResponse(), // → { status, headers, body }|null  verbatim last refresh 2xx
  healthy(),               // → bool          last refresh/harvest ok & token unexpired
  onRotate(cb),            // cb(token) on every rotation
  storageState(),          // → Promise<state>  broker's CURRENT session (for persist)
  stop(),                  // close context, clear timers
})
```

Implementation notes:

- Create the broker context the way the pool creates contexts (grep: `newSeededContext` in
  `pool.mjs`). Navigate `baseUrl+seedPath`, let the app authenticate by reusing the recovery
  flow (grep: `recoverSession` in `crawl.mjs` — in broker mode the broker is the **only** caller
  of it), then **harvest off the wire**: a `page.on('request')` listener records the first
  same-origin request carrying `Authorization: Bearer …`; a `page.on('response')` listener stores
  the verbatim status/headers/body of every response matching `refreshUrlRe`
  (default `/\/(oidc\/)?(refresh|token)\b/i`).
- **Proactive rotation:** decode the JWT payload (`Buffer.from(part, 'base64url')`, no signature
  check) → `exp`/`iat`. Schedule re-refresh at `iat + 0.6*(exp-iat)`. To re-refresh, re-navigate
  the broker page to the seed route (the app fires its own refresh with the broker's live
  cookie). Non-JWT token → fixed `BROKER_REFRESH_INTERVAL_MS` (default 240000).
- **Harmless on non-bearer apps:** if no bearer appears within 30s but the app works
  (cookie-session), the broker reports `healthy()` with `current()===null` — header rewrite
  becomes a no-op and workers run on cookies as today.
- **if missing:** if `harvest-token.mjs` isn't in your tree, the two listeners above ARE the
  harvest logic — inline them.

**Wire-in — `crawl.mjs`:** start the broker before fan-out when mode resolves to broker
(Phase F), pass its handle into `runWalkerPool` as `broker`, and thread it into `runWorker` opts
(grep: `runWorker({` in `pool.mjs`; signature at `worker.mjs:73-89`).

**Acceptance:** with `CRAWL_AUTH_MODE=broker` and N=4 on the OIDC target, logs show exactly
**one** context ever hitting `/oidc/refresh`; zero worker-initiated refreshes.

### Phase B — refresh-mock + header rewrite + auth-gated requeue — blockers 1, 2

1. **Route handler (both auth layers)** — extend the spec-15 handler (grep: `page.route('**/*'`
   in `crawl.mjs`) to the FIXED ordering in the architecture box:
   - if `broker` set AND request matches the app-origin refresh (`refreshUrlRe` + same-origin)
     AND `broker.latestRefreshResponse()` non-null → `route.fulfill()` that cached response
     (layer a);
   - other `AUTH_ALLOW_RE` (grep: `AUTH_ALLOW_RE` in `crawl.mjs`) → `continue()` untouched;
   - spec-15 write → abort/mock + capture (unchanged);
   - else same-origin, when `broker.current()` set →
     `route.continue({ headers: { ...req.headers(), authorization: 'Bearer ' + broker.current() } })`
     (layer b). **Never** inject on cross-origin/IdP requests.
2. **reAuth in broker mode** (grep: `reAuth: async (page, intendedUrl)` in `crawl.mjs`): do NOT
   run `recoverSession` from workers (that's what rotates the token). Instead wait for
   `broker.healthy()` (poll ≤15s) then re-`goto` the intended URL once.
3. **Requeue** — replace the one-shot `reauthRetried` block (`worker.mjs:201-207`) with an
   auth-gated backoff: `state.enqueue({ ...task, authRetries: (task.authRetries ?? 0) + 1, notBefore: Date.now() + backoff })`,
   cap at `CRAWL_BOUNCE_RETRIES` (default 3).

**Acceptance:** rotate the token out-of-band mid-run; no task ends up in `interactedUrls` without
a page record. **N=4 coverage ≥ N=1 coverage** on the OIDC target (headline regression gone).
Add a test asserting a bounced task is re-crawled after health returns.

### Phase C — auth-health gate in SharedState — blocker 2 (state side)

**`walker/state.mjs`** (grep: `class SharedState`): add `this.authHealthy = true`,
`setAuthHealth(bool)`, and honor `task.notBefore` in `tryDequeue()` — skip-and-requeue (push to
tail) tasks whose `notBefore > Date.now()`. Keep read+mutate pairs synchronous — **no `await`
inside** (grep: `race-safe`). Guard against spin: if ALL pending tasks are future-dated,
`tryDequeue` returns null so the worker's 100ms idle poll paces the loop.

**Acceptance:** unit test — a future-dated task is not dequeued early and is picked up after its
`notBefore`; an all-future queue doesn't busy-spin.

### Phase D — monotonic persist guard — blocker 3

Sidecar `auth-state.meta.json` next to `auth-state.json` holding `{ rotationSeq, iat, savedAt }`.
In `persistSession` (`crawl.mjs:781-791`), before `fs.writeFileSync`, read the sidecar and write
only if the new session's `iat` (or broker `rotationSeq` for opaque tokens) is strictly newer.
Keep the existing empty-capture guard (grep: `material(fresh) === 0`). Log rejected stale writes.

**Acceptance:** unit test — two persists with `iat` older-then-newer and newer-then-older; the
file always ends on the newest.

### Phase E — throughput: hashing, granularity, startup — blockers 4, 5, 6

1. **Hashing (4):** in the `response` handler (grep: `createHash('sha256')`), skip hashing when
   `bodyLen > BODY_HASH_MAX_BYTES` (default 262144); still record `bodyLen`, set
   `bodyUnhashed:true`. (Worker-thread pool is a later option, not this spec.)
2. **Granularity (5):** default `MAX_LIST_ITEMS_PER_NAV` to a finite value (3) — the comment at
   `worker.mjs:65-71` already claims 3 but the code defaults to Infinity; make code match. Add
   `CLICK_BATCH_SIZE` (default 10): a page's click list beyond the batch is re-enqueued as a
   continuation task (transition claims make this idempotent — grep: `tryClaim`). Keep env
   overrides.
3. **Startup (6):** extract the worker's content-based settle (grep: `innerText.length > 200`)
   into a shared helper; replace the always-timing-out `networkidle` waits in setup
   (`pool.mjs:140`, `crawl.mjs:1021`) with it. Make the 2.5s stagger (grep: `STAGGER_MS`) apply
   only in broker/rotating mode.

**Acceptance:** event-loop lag (`perf_hooks.monitorEventLoopDelay`) under N=4 drops materially
with the hashing threshold on; fixed startup on a 20-page SPA drops from ~1.5-2 min toward <30s;
**N=4 wall-clock < N=1 wall-clock** on the OIDC target (parallelism now positive).

### Phase F — spec-17 integration: sessionType detection + auto mode

Add `sessionType ∈ { rotating-refresh, cookie, static-bearer, unknown }` to the spec-17 probe.
Deterministic heuristics observed during warm-up:
- `/oidc/refresh|/token` response that **rotates** the refresh cookie (Set-Cookie on it) →
  `rotating-refresh`;
- stable session cookie, no token endpoint → `cookie`;
- fixed `Authorization: Bearer` with no refresh traffic → `static-bearer`.
`CRAWL_AUTH_MODE=auto` selects broker for `rotating-refresh` and `unknown` (safe default),
`shared` otherwise. `pool.mjs` reads the resolved mode.

**Acceptance:** probe on the OIDC target reports `rotating-refresh` and auto-selects broker
without any env; probe on a cookie-session fixture reports `cookie` and uses the unchanged
fan-out path.

### Phase G — (documented non-goal) horizontal scale

`SharedState` (`state.mjs`) is intentionally in-memory and single-thread — `tryClaim`/
`tryDequeue` race-safety depends on no `await` between read and write (grep: `race-safe`).
Multi-process / multi-machine scale requires replacing it with an external atomic queue
(SQLite-backed, matching the run-store direction in the harness-architecture research).
**Out of scope here** — only matters beyond ~200 pages. Do not attempt by adding threads to the
current class; that breaks the invariant silently.

## Env surface (new)

| Var | Default | Meaning |
|---|---|---|
| `CRAWL_AUTH_MODE` | `auto` | `auto\|broker\|shared\|off` — Phase F resolves `auto` |
| `BROKER_REFRESH_INTERVAL_MS` | `240000` | re-refresh cadence when the token is not a JWT |
| `BODY_HASH_MAX_BYTES` | `262144` | skip sha256 above this response size |
| `CRAWL_BOUNCE_RETRIES` | `3` | per-task auth-bounce requeue cap (was hardcoded 1) |
| `CRAWL_AUTH_BACKOFF_MS` | `2000` | base backoff for auth-gated requeue |
| `CLICK_BATCH_SIZE` | `10` | clicks per page-task before the remainder is continued |

(Existing `CRAWL_WORKERS`, `MAX_LIST_ITEMS_PER_NAV`, `SAFE_CLICK_MAX_PER_PAGE`,
`WORKER_STAGGER_MS` are reused, not replaced.)

## Verification (whole-spec)

- **Regression gate (must pass):** on a cookie-session fixture app, a full scan's output is
  diff-identical to pre-spec-18 output — the currently-working auth class must not change.
- **Headline metric (the definition of "parallelism that pays"):** on the rotating-token OIDC
  target, N=4 coverage ≥ N=1 coverage **AND** N=4 wall-clock < N=1 wall-clock. Both, together.
- **Auth-chaos test:** force a token rotation mid-run; assert (a) exactly one context refreshes,
  (b) no task silently dropped, (c) `auth-state.json` ends on the newest rotation.
- **Unit:** broker JWT `exp` decode + 60%-rotation scheduling; SharedState `notBefore` dequeue;
  persist stale-rejection; requeue-after-health.
- **Event loop:** `monitorEventLoopDelay` p99 under N=4 with hashing threshold on vs off.

## What to hand the coding agent, in one line

Do Phases A→F in order; A+B+C are the unlock (broker + refresh-mock/header-rewrite + auth-gated
requeue), D keeps N workers honest, E makes the win visible, F makes it automatic per target.
Guard every change behind the cookie-session regression gate so the already-working class never
breaks.
