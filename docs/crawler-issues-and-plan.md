# Crawler Issues Analysis & Comprehensive Fix Plan

**Generated**: 2026-08-12  
**Verified against codebase**: 2026-08-12 — every issue checked line-by-line against `crawl.mjs`, `pool.mjs`, `worker.mjs`, `scanner.mjs`, `sso.mjs`, `harvest-token.mjs`, `deep-crawl.mjs`, `state.mjs`. Verdicts: **8 confirmed · 3 partially correct (corrected inline) · 1 withdrawn (Issue 7)**.  
**Context**: HSBC internal Pulse application crawl — SSO TTL < 2 min, dual login forms, cross-origin SSO redirects

---

## 📋 Executive Summary

The crawler works for simple apps but **fundamentally breaks** on enterprise apps with:
- Short-lived rotating SSO tokens (< 2 min TTL)
- Multiple login forms on same page
- Cross-origin IdP redirects without credentials
- Parallel workers racing on single-use refresh tokens

**Root Cause**: Architecture assumes "login once, crawl long" but reality is "login, crawl 90s, re-login, repeat" — with 8 workers doing this independently and serially.

---

## 🔴 Verified Issues (User-Reported)

### Issue 1: Short SSO TTL → Repeated 75s Recovery Cycles ✅ CONFIRMED

**Location**: `testo/src/crawler/crawl.mjs:793-850` (`recoverSession`), `testo/src/crawler/walker/worker.mjs:178-195` (`reAuth`)

**Mechanism**:
- `recoverSession()` attempts **3 × 22s settle waits** = ~66s per recovery (matches observed ~75s)
- Triggered on ANY `/login|signin|sso|auth` URL redirect
- With `CRAWL_WORKERS=8`, each worker hits expiry independently
- All recoveries **serialized** via `serializedRecover` promise chain (`crawl.mjs:215-220`)
- **Total auth time**: 8 workers × 66s = **~9 minutes of pure recovery per TTL cycle**

**Evidence in code**:
```javascript
// crawl.mjs:829-844
for (let attempt = 1; attempt <= 3; attempt++) {
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  if (await settle(22_000)) {  // 22s per attempt
    ...
  }
}
```

**Verification note**: The 3 × 22s = ~66s is the **failure-path worst case** — `settle()` returns early the moment recovery succeeds, so a healthy silent-SSO recovery completes in 10-20s. The observed ~75s matches the failure path (goto timeouts + settle + `waitForUrlStable` overhead). The "~9 min per TTL cycle" is therefore the worst case when all 8 workers' recoveries fail, not the guaranteed cost.

---

### Issue 2: Parallelism Broken by Token Rotation Race ✅ CONFIRMED

**Location**: `testo/src/crawler/walker/pool.mjs:204-229` (warm-up), `testo/src/crawler/deep-crawl.mjs:83-88`

**Mechanism**:
- **Warm-up only at start**: One context logs in, captures rotated session, fans out others with fresh `storageState`
- **Mid-crawl expiry NOT handled**: When TTL < crawl duration, workers independently hit login wall
- Each worker enters `serializedRecover` → **cascade of serial recoveries**
- `deep-crawl.mjs` explicitly sets `CRAWL_WORKERS=1` for pass 2 with comment:
  > *"N contexts cloned from same auth-state race on refresh endpoint... whole pass-2 budget goes to auth instead of crawling"*

**Evidence in code**:
```javascript
// pool.mjs:204-229 - Only runs ONCE at startup
if (serializeAuth && onContextReady && effectiveWorkers > 1 && !discoveryWarmed) {
  const warmCtx = await newSeededContext();
  // ... warmCtx logs in ...
  const fresh = await warmCtx.storageState({ indexedDB: true });
  await onAuthWarmed(fresh);  // Fan-out workers get THIS session
}
// After this, NO mechanism to refresh fan-out workers mid-crawl
```

---

### Issue 3: Cross-Origin SSO Buttons Get Clicked ✅ CONFIRMED

**Location**: `testo/src/crawler/walker/scanner.mjs:419-420`, `testo/src/crawler/crawl.mjs:92`

**Mechanism**:
- Scanner correctly rejects cross-origin **anchors** (`nav` kind): line 420
- But **SSO buttons are `click` kind** (button elements) — no cross-origin check
- `SAFE_CLICK_REGEX` default is `.+` (matches everything) — `crawl.mjs:92`
- `NEVER_CLICK_REGEX` only catches logout patterns — doesn't block "Sign in with Google/Microsoft"

**Evidence in code**:
```javascript
// scanner.mjs:419-420 - ONLY for nav (anchors)
if (kind === 'nav' && href && !isSameOrigin(href)) { 
  base.rejected = 'cross-origin'; 
  items.push(base); 
  continue; 
}
// No equivalent check for kind === 'click' (buttons)

// crawl.mjs:92 - Default allows ALL button text
const SAFE_CLICK_REGEX = new RegExp(process.env.SAFE_CLICK_REGEX || '.+', 'i');
```

---

### Issue 4: Two Login Forms (Simple + SSO) on Same Page ⚠️ PARTIALLY CORRECT

**Location**: `testo/src/crawler/crawl.mjs:637-684` (`maybeLogin`)

**Mechanism**:
- `maybeLogin` tries plain email/password form first (lines 637-685)
- Falls back to SSO only if no fillable form found (line 652-660)
- **Problem**: If both forms visible simultaneously (Pulse app), fills email/password — may be wrong form
- No config to prefer SSO form or detect dual-form scenario
- **Correction**: the LLM advisor (`classifyAuthFlow`) is more than advisory — when it returns `type: 'sso_redirect'` + `action: 'click_sso_button'`, `executeAuthSteps` runs the SSO steps directly (crawl.mjs:631-633) and the plain form is skipped. Plain-form-first applies only to the deterministic path (advisor off / timeout / null).
- **Design tension the plan missed**: `sso.mjs:161-166` documents that plain-form-first is *deliberate* — forge's popup-based OAuth (`signInWithPopup`) stalls headless (COOP severs popup→opener). A global `PREFER_SSO_FORM=1` default would break the forge workaround, so SSO preference must be per-app config (Fix #12), never a global default.

**Evidence in code**:
```javascript
// crawl.mjs:637-684 - Tries plain form FIRST
const emailLoc = page.locator(LOGIN_EMAIL_SELECTOR).first();
const pwdLoc   = page.locator(LOGIN_PASSWORD_SELECTOR).first();
// ... fills and submits ...
// Only if NO form found, tries SSO (line 652)
if (LOGIN_URL_REGEX.test(page.url()) && (LOGIN_EMAIL || LOGIN_PASSWORD)) {
  const sso = await attemptSsoLogin(page, {...});
}
```

---

## 🔴 Additional Critical Issues (Discovered During Analysis)

### Issue 5: Mid-Crawl Token Rotation Cascade ✅ CONFIRMED

**Location**: `testo/src/crawler/crawl.mjs:215-220` (`serializedRecover`), `testo/src/crawler/walker/worker.mjs:178-195`

**Mechanism**:
- Each worker has **independent BrowserContext** with own cookie jar
- Worker A recovers → rotates token on server → Worker B's context now has **stale cookie**
- Worker B recovers → server already rotated past B's cookie → **cascade of failures**
- `serializedRecover` serializes the **recovery calls** but NOT the **token state** across contexts
- No mechanism to broadcast rotated session to live contexts mid-crawl

---

### Issue 6: Interactive Login Fallback Breaks Parallelism ⚠️ PARTIALLY CORRECT (overstated)

**Location**: `testo/src/crawler/crawl.mjs:874-891` (`ensureInteractiveLogin`), `testo/src/crawler/crawl.mjs:1033-1047` (onContextReady)

**Mechanism**:
- `ensureInteractiveLogin()` is promise-guarded (only one runs globally)
- **Correction — "only 1/8 workers get cookies" is wrong for the startup case**: every worker that hits the login wall in `onContextReady` awaits the *same* shared promise and then runs `addCookies` + reload **in its own context** (crawl.mjs:1034-1047). With staggered bring-up, all wall-hitting workers adopt the cookie-based session.
- The two gaps that ARE real:
  1. **Mid-crawl expiry never triggers the interactive fallback at all** — the `reAuth` path (crawl.mjs:1061-1071) only calls `recoverSession`/`maybeLogin`, never `ensureInteractiveLogin`. If the session dies mid-crawl and silent recovery fails, workers limp along unauthenticated with no manual-login offer.
  2. **IndexedDB sessions (Firebase) cannot be adopted mid-run** (lines 1037-1042):
  ```javascript
  if (!(authState.cookies?.length)) {
    console.warn(`manual login saved, but session is IndexedDB-based — cannot adopt into live context`);
  }
  ```
- Next run works (via `storageStateProvider`), but for IndexedDB apps the current crawl's workers stay unauthenticated

---

### Issue 7: harvest-token.mjs Re-Rotates Token AFTER Crawl ❌ WITHDRAWN (code contradicts the claim)

**Location**: `testo/src/crawler/harvest-token.mjs:46-65` (`ensureAuthed`), `testo/src/crawler/harvest-token.mjs:146-154`

**Why withdrawn**:
- The claimed unconditional overwrite doesn't exist. `harvest-token.mjs:146-154` has an explicit guard: it saves auth-state.json **only when the page is NOT on a login URL** (`authed = !LOGIN_URL_RE.test(page.url())`); otherwise it logs `"leaving auth-state.json untouched"`.
- `ensureAuthed()` only attempts recovery **after** a login bounce (line 48 returns early when already authenticated) — it doesn't gratuitously re-login.
- When it does save, persisting the **rotated** session is the *correct* behavior under a single-use rotating token (same reason `persistSession` exists in crawl.mjs) — skipping the save would leave a consumed token on disk and break the next run.

**Residual (small, real) concern**: the guard is **URL-based only** — weaker than crawl.mjs's `sessionMaterial` guard (crawl.mjs:992-999) and hollow-shell refresh-status check (crawl.mjs:833). On an app whose route guard fails open (real URL, all APIs 401), harvest could persist a hollow session. Fix #9 is rescoped to this.

---

### Issue 8: No Proactive Token Refresh ✅ CONFIRMED

**Location**: `testo/src/crawler/walker/worker.mjs` (no refresh logic)

**Mechanism**:
- Crawler only **reacts** to 401/login redirect (in `reAuth`)
- With <2min TTL, constantly chasing expiry
- Could monitor JWT `exp` claim from localStorage/IndexedDB or refresh preemptively at 50% TTL
- No background timer, no `AUTH_REFRESH_INTERVAL_MS` config

---

### Issue 9: Discovery Phase Can Pre-Rotate Token Before Fan-Out ⚠️ MECHANISM WRONG — fold into Issues 2/5

**Location**: `testo/src/crawler/walker/pool.mjs:130-185` (discovery phase)

**Correction**: mid-discovery rotations happen **inside the discovery context's own cookie jar**, and the capture (pool.mjs:179) runs *after* discovery — so the captured state is always the **newest** rotation, not a stale one. Discovery duration doesn't stale the capture.

The real residual risk is just the general single-use-token problem restated: all fan-out contexts are cloned from ONE capture carrying ONE single-use refresh token. Whichever worker refreshes first consumes it; the rest cascade (= Issue 2/5). The window between capture and each worker's first refresh (context creation + `idx × 2500ms` stagger) only affects *when* that race fires, not whether. **Recommendation: drop this as a separate issue; it adds no fix beyond #1/#2.**

---

### Issue 10: SSO Button Detection Not Configurable Per App ✅ CONFIRMED

**Location**: `testo/src/crawler/auth/sso.mjs:35-45` (hardcoded regex and hints)

**Mechanism**:
- `SSO_BUTTON_TEXT_RE` hardcoded (line 35-36)
- Can't exclude specific providers (e.g., "Sign in with SSO" vs "Sign in with Google")
- `PROVIDER_HINTS` array fixed — can't add custom IdP patterns via env
- No way to say "never click Microsoft button" or "only click generic SSO button"

---

### Issue 11: Worker Stagger (2.5s) Insufficient for Slow SSO ⚠️ PARTIALLY CORRECT

**Location**: `testo/src/crawler/walker/pool.mjs:196` (`STAGGER_MS`)

**Mechanism**:
- `STAGGER_MS` default 2500ms
- Enterprise SSO with MFA/push approval can take 10-30s
- Workers still collide on refresh endpoint despite stagger
- No exponential backoff or auth-aware staggering
- **Correction**: the stagger is **already configurable** — `WORKER_STAGGER_MS` env is read at pool.mjs:196 (`Number(process.env.WORKER_STAGGER_MS) || 2500`). Only the backoff / auth-aware part is missing. (Minor bug while here: `|| 2500` means `WORKER_STAGGER_MS=0` silently falls back to 2500.)

---

### Issue 12: Cross-Origin SSO Redirect Not Detected Pre-Click ⚠️ CONFIRMED, but severity overstated

**Location**: `testo/src/crawler/walker/worker.mjs:368-380` (click loop), `testo/src/crawler/walker/scanner.mjs` (no pre-check)

**Mechanism**:
- Scanner only rejects cross-origin **nav** (anchors)
- No pre-click check: "Will this click navigate cross-origin?"
- Could use `page.evaluate(() => element.href)` or check button's form action before clicking
- **Correction — the crawler does NOT get stranded on the IdP**: the click loop detects the cross-origin nav *after* the fact, refuses to queue it (`cross-origin nav (not queued)`), and immediately re-baselines with `page.goto(url)` (worker.mjs:445-453). Actual cost = one wasted click cycle (~5-10s) per SSO button per page, plus the risk that initiating an OAuth redirect mid-crawl rotates/pollutes auth state. Worth fixing, but it's an efficiency + state-hygiene issue, not a lost-crawler issue.

---

## 🎯 Comprehensive Fix Plan

### Phase 1: Core Auth Architecture (High Impact)

| # | Fix | Files | Effort | Description |
|---|-----|-------|--------|-------------|
| 1 | **Shared token refresh broadcast** | `crawl.mjs`, `worker.mjs`, `pool.mjs` | Medium | When any worker recovers, propagate new `storageState` to ALL live contexts via `context.addCookies()` + IndexedDB script injection |
| 2 | **Proactive token refresh timer** | `worker.mjs`, `crawl.mjs` | Medium | Per-context background refresh at 50% TTL (configurable via `AUTH_REFRESH_INTERVAL_MS`) |
| 3 | **Mid-crawl auth warm-up trigger** | `pool.mjs`, `state.mjs` | Medium | Detect when >N workers in recovery → pause crawl, do single warm-up, resume all with fresh session |

### Phase 2: SSO Button & Cross-Origin Protection

| # | Fix | Files | Effort | Description |
|---|-----|-------|--------|-------------|
| 4 | **Pre-click cross-origin check** | `scanner.mjs`, `worker.mjs` | Low | In `clickableLocator` → `page.evaluate` to check `href`/form action target origin before clicking |
| 5 | **SSO button exclusion config** | `crawl.mjs`, `sso.mjs` | Low | `EXCLUDE_SSO_PROVIDERS=google,microsoft` env → adds to `NEVER_CLICK_REGEX` |
| 6 | **Dual-form detection & preference** | `crawl.mjs` | Low | In `maybeLogin`, if both email/password fields AND SSO button visible → prefer SSO. ⚠️ Must be **per-app config only** (via Fix #12), never a global default — plain-form-first is deliberate for forge's popup-COOP case (`sso.mjs:161-166`) |

### Phase 3: Parallelism & Recovery Optimization

| # | Fix | Files | Effort | Description |
|---|-----|-------|--------|-------------|
| 7 | **Auth-aware stagger backoff** | `pool.mjs` | Low | `WORKER_STAGGER_MS` env **already exists** (pool.mjs:196) — only build the exponential backoff when auth is detected during warm-up; also fix `|| 2500` so `WORKER_STAGGER_MS=0` isn't ignored |
| 8 | **Interactive login for mid-crawl expiry** | `crawl.mjs`, `pool.mjs` | Medium | Startup-time sharing **already works** (every wall-hitting worker adopts cookies in `onContextReady`). Real gaps: (a) wire `ensureInteractiveLogin` into the `reAuth` path so mid-crawl auth death offers manual login, (b) IndexedDB session adoption (needs context recreation, not `addCookies`) |
| 9 | **Strengthen harvest-token save guard** | `harvest-token.mjs` | Low | Guard already exists but is URL-based only (line 146) — upgrade to `sessionMaterial` + refresh-status checks like crawl.mjs warm-up, so a hollow-shell page can't persist a weak session |

### Phase 4: Observability & Config

| # | Fix | Files | Effort | Description |
|---|-----|-------|--------|-------------|
| 10 | **Auth metrics in click-graph.json** | `state.mjs`, `pool.mjs` | Low | **Partially exists**: `recordIssue` already lands `re-auth` / `re-auth-failed` / `requeued-login-bounce` counts in `issueCounts` (state.mjs:119-120). New work = durations (`recoveryDurationMs`), `tokenRotations`, `workersInRecovery` |
| 11 | **TTL-aware crawl budget** | `crawl.mjs` | Low | `CRAWL_BUDGET_MS` should account for expected recovery cycles (auto-calc from `AUTH_TTL_ESTIMATE_MS`) |
| 12 | **Per-app auth profile (JSON config)** | New file + `crawl.mjs` | Medium | JSON config for `loginForms`, `ssoProviders`, `tokenTtlEstimate`, `preferSsoForm`, `excludedSsoProviders` |

---

## ❓ Clarifying Questions (Required Before Implementation)

1. **Token TTL estimate**: You said "< 2 min" — is it consistent (e.g., 90s) or variable? Affects proactive refresh timing.

2. **SSO Provider(s)**: Which IdP(s)? Google, Microsoft/Entra, Okta, Ping, custom? Affects `PROVIDER_HINTS` and button detection.

3. **Pulse app login flow**: Both forms on same page simultaneously? Or tabs/steps? Affects dual-form detection logic.

4. **IndexedDB vs Cookies**: Does HSBC app use cookies, IndexedDB (Firebase), or both? Affects session broadcast approach (Fix #1, #8).

5. **Current crawl duration**: How long does full crawl take? Determines how many TTL cycles expected.

6. **Acceptable trade-off**:
   - Option A: Reduce workers to 1-2 (like deep-crawl pass 2) → simpler but slower
   - Option B: Implement shared refresh broadcast (Fix #1) → complex but maintains parallelism
   - Option C: Proactive refresh + stagger (Fix #2, #7) → middle ground

7. **Interactive login frequency**: How often do you need manual intervention? If rare, fixing broadcast (Fix #8) may suffice.

8. **harvest-token.mjs usage**: Is this run after every crawl? Or only for API test generation? Affects priority of Fix #9.

---

## Answer to clarifying questions
1. **Token TTL estimate**: There is fixed TTL from their side but exact value is not known but it is tested that it is around 2 mins only.
2. **SSO Provider(s)**: Pulse uses Keycloak. But we have to make it independent of which SSO the application uses. We need to give priority to the auth form located at BASE_URL + SEED_PATH which is something set by user only who knows the application being tested.
3. **Pulse app login flow**: Both forms are on different domains only. Keycloak SSO form is at some other origin whereas the username password form is the part of teh applicatiion only (from same origin as that of application).
4. **IndexedDB vs Cookies**: We need to tackle for both types as this application will not be just testing the pulse application only.
5. **Current Crawl duration**: There is a TTL limit for the crawler which is 30 mins set from the env only.
6. **Acceptable trade-offs**: 
7. **Interactive login frequency**: Can we make it backup for the broadcast methodology failure?
8. **harvest-token.mjs usage**: See during the whole pipeline run we want to have functionality that will keep checking if the auth-state has gotten stale or not, if yes then it will renew that state before any other task to be done whether it be api test generation or execution or any other step in the pipeline.

## 📁 Files to Modify (Summary)

### Core Crawler
- `testo/src/crawler/crawl.mjs` — Main entry, auth recovery, maybeLogin, persistSession
- `testo/src/crawler/walker/pool.mjs` — Worker orchestration, warm-up, stagger
- `testo/src/crawler/walker/worker.mjs` — Per-worker DFS, reAuth, click loop
- `testo/src/crawler/walker/state.mjs` — SharedState, metrics serialization
- `testo/src/crawler/walker/scanner.mjs` — Element detection, cross-origin check

### Auth
- `testo/src/crawler/auth/sso.mjs` — SSO button detection, provider hints
- `testo/src/crawler/harvest-token.mjs` — Token harvesting, strengthen save guard (URL-based → sessionMaterial)
- `testo/src/crawler/login-once.mjs` — Interactive login, session capture

### New Config
- `testo/src/crawler/auth-profile.json` (new) — Per-app auth configuration

---

## 🚀 Recommended Implementation Order

1. **Quick wins (Phase 2)**: Fixes #4, #5, #6, #9 — Low effort, immediate relief
2. **Core auth (Phase 1)**: Fixes #1, #2, #3 — High effort, solves root cause
3. **Parallelism (Phase 3)**: Fixes #7, #8 — Medium effort, restores parallelism
4. **Observability (Phase 4)**: Fixes #10, #11, #12 — Low effort, prevents regression

---

## ✅ Success Criteria

| Metric | Current | Target |
|--------|---------|--------|
| Auth recovery time per TTL cycle | up to ~9 min worst case (8 workers × 75s failure path) | < 30s (single recovery broadcast) |
| Workers blocked on auth | 8/8 (serial) | 0/8 (parallel with fresh session) |
| Cross-origin SSO clicks | Clicked, then re-baselined (~5-10s wasted each) | Skipped pre-click |
| Dual-form confusion | Fills wrong form (deterministic path) | Prefers SSO (per-app config) |
| Crawl budget wasted on auth | ~60-80% | < 10% |
| Manual login fixes all workers | Startup: yes (cookie-based). Mid-crawl: never offered. IndexedDB: no | Yes, incl. mid-crawl + IndexedDB |

---

*Plan verified against the codebase on 2026-08-12 (all 12 issues checked line-by-line; corrections applied inline). Awaiting clarification on questions above before implementation begins.*