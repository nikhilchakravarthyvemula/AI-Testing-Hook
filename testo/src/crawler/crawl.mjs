// Headless Crawlee + Playwright BFS crawler with rich per-page capture.
// Pure code for capture; an optional LLM advisor (CRAWLER_LLM=1, default
// on) is consulted at the auth-flow decision point.
//
// Captures (latest run only; previous run wiped at start):
//   output/crawler/raw/requests.ndjson      every network request (filtered)
//   output/crawler/raw/responses.ndjson     every network response (+ bodyHash)
//   output/crawler/raw/pages.ndjson         rich per-page record (title, meta,
//                                           headings, forms, clickables, links,
//                                           storage, timing, screenshot path)
//   output/crawler/raw/console.ndjson       console messages + pageerrors
//   output/crawler/raw/failed.ndjson        failed/blocked/network-errored reqs
//   output/crawler/raw/websockets.ndjson    websocket opened + close events
//   output/crawler/bodies/<sha16>.bin       response body cache (dedup by hash)
//   output/crawler/screenshots/<safe>.png   full-page screenshot per page
//
// Spec / mindmap / routes / pages JSON are produced by analyze.mjs in a 2nd pass.

// Note: Crawlee + playwright/chromium have been retired in favor of the
// in-house unified parallel-DFS walker (context-layer/content-extractor/crawler/walker/). The
// walker handles its own browser lifecycle, BFS-or-DFS traversal, click-
// graph synthesis, and per-context auth refresh.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { adviseOn } from './llm-advisor/index.mjs';
import { attemptSsoLogin, EXTERNAL_IDP_RE } from './auth/sso.mjs';
import { runWalkerPool } from './walker/pool.mjs';

// Per-page scanner: the heuristic walker/scanner.mjs (the only scanner).
// The LLM advisor in ./llm-advisor still augments this crawl when
// CRAWLER_LLM=1; the separate LLM-primary scanner variant was removed.
const scannerFn = undefined;   // worker.mjs falls back to the heuristic default

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

// ----- config (env-overridable) -----
// BASE_URL is REQUIRED for the crawler. testo scan sets it from --url.
// Direct callers (rare) must set it. The default below is a placeholder
// for local dev convenience; production usage should always pass --url.
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const SEED_PATH = process.env.SEED_PATH || '/';
// Multiple seed entry points (comma-separated). If unset, falls back to SEED_PATH.
// Useful when a SPA's nav from one page doesn't surface every route — e.g.
//   SEED_PATHS="/graph,/insights,/inventory,/settings,/users"
const SEED_PATHS = (process.env.SEED_PATHS || SEED_PATH)
  .split(',').map(s => s.trim()).filter(Boolean);
const HEADLESS = (process.env.HEADLESS ?? '1') !== '0';
// Used as the post-load settle after each full page-visit. Default
// dropped 1500 → 500: networkidle is no longer waited (it falsely
// times-out on SPAs), so we only need a short window for React to mount
// and synthetic event listeners to attach.
const POST_NAV_WAIT_MS = Number(process.env.POST_NAV_WAIT_MS || 500);
// Credentials — empty by default. `maybeLogin` only fills the form
// when BOTH are non-empty, so the crawler does the right thing on
// apps with no auth wall (just skips the login attempt entirely).
// testo scan sets these from --user / --pass.
const LOGIN_EMAIL = process.env.LOGIN_EMAIL || '';
const LOGIN_PASSWORD = process.env.LOGIN_PASSWORD || '';
// Login page detection + form selectors — all overridable per app.
const LOGIN_URL_REGEX        = new RegExp(process.env.LOGIN_URL_REGEX || '/(login|sign-?in|signin|auth)');
// Broader defaults: also match Keycloak/OIDC (`username`), and any `type=email`/`type=password`
// input so common stacks work without an env override.
const LOGIN_EMAIL_SELECTOR   = process.env.LOGIN_EMAIL_SELECTOR   ||
  "input[type='email'], input[name='email'], input[name='username'], input[id='username']";
const LOGIN_PASSWORD_SELECTOR= process.env.LOGIN_PASSWORD_SELECTOR||
  "input[type='password'], input[name='password']";
// Submit can be either a CSS selector (LOGIN_SUBMIT_SELECTOR) or button text
// match (LOGIN_SUBMIT_TEXT). If both unset, defaults to text "Sign in".
const LOGIN_SUBMIT_SELECTOR  = process.env.LOGIN_SUBMIT_SELECTOR  || '';
const LOGIN_SUBMIT_TEXT      = process.env.LOGIN_SUBMIT_TEXT      || (LOGIN_SUBMIT_SELECTOR ? '' : 'Sign in');
const CAPTURE_SCREENSHOTS = (process.env.CAPTURE_SCREENSHOTS ?? '1') !== '0';
const CAPTURE_DOM = (process.env.CAPTURE_DOM ?? '1') !== '0';
// Wait until url has been unchanged for this many ms (catches SPA router.push)
const URL_STABLE_IDLE_MS = Number(process.env.URL_STABLE_IDLE_MS || 1500);
const URL_STABLE_MAX_MS  = Number(process.env.URL_STABLE_MAX_MS  || 5000);
// POST_CRAWL_URLS — extra URL paths visited as additional seeds. Default
// is EMPTY because for a parallel-worker walker, visiting destructive
// paths like /logout kills the worker's session and produces nav-failed
// errors for its remaining tasks (each context is independent but
// invalidated). Opt in with `POST_CRAWL_URLS=/logout,/somewhere-else`
// only when those URLs are actually safe + worth crawling.
const POST_CRAWL_URLS = (process.env.POST_CRAWL_URLS ?? '')
  .split(',').map(s => s.trim()).filter(Boolean);
// Default: '.+' matches any button text. The DESTRUCTIVE_CLICK_REGEX below is
// the actual gate. Set SAFE_CLICK_REGEX to a narrower pattern (e.g.
// 'view|details|more') to be more conservative.
const SAFE_CLICK_REGEX = new RegExp(process.env.SAFE_CLICK_REGEX || '.+', 'i');
// Word-boundaries (\b) on every alternative — so "drop" doesn't match
// inside "dropdown" or "drop-shadow" even if those leak into the
// user-facing signal somehow. Pair with the scanner's userSignal
// (label-only, no CSS classes) for the two-layer defense.
const DESTRUCTIVE_CLICK_REGEX = new RegExp(
  process.env.DESTRUCTIVE_CLICK_REGEX ||
    '\\b(?:delete|cancel|remove|revoke|disable|sign[- ]?out|log[- ]?out|destroy|reset|drop|trash|archive|deactivate|terminate|kill|stop|pause|suspend|ban|clear|wipe|purge|leave|exit|close[ -](?:account|session)|unlink|disconnect)\\b',
  'i'
);
// spec-15 D2: destructive controls are now CLICKED — the wire-level mutation
// guard aborts any resulting PUT/PATCH/DELETE before it reaches the server, so
// clicking a Delete/Deactivate is safe (we capture the blocked request as a
// test candidate). DESTRUCTIVE_CLICK_REGEX above is now just a HINT/flag.
// The NEVER-CLICK set is the small class we STILL skip, because they destroy
// the client session or redirect away — no network request to block:
// logout/sign-out, and account/org-level deletes/closes.
const NEVER_CLICK_REGEX = new RegExp(
  process.env.NEVER_CLICK_REGEX ||
    '\\b(?:log[\\s-]?out|logout|sign[\\s-]?out|signout|end[\\s-]?session|switch[\\s-]?account)\\b' +
    '|\\b(?:delete|remove|close|deactivate|terminate|deprovision)\\b[\\s\\S]{0,20}\\b(?:account|organization|org|workspace|tenant|profile|everything)\\b',
  'i'
);
// ── mutation guard (spec-15) — block WRITE requests at the wire ────────────
// The HTTP method is a deterministic destructiveness signal the button label
// isn't. We let reads through (the crawl needs them to load data) and ABORT
// writes before they leave the browser — so the crawler can click EVERY
// control (even a Confirm-Delete) for full feature coverage while the mutation
// never reaches the server. Each blocked write is captured as a test candidate.
//   INTERCEPT_MODE=abort|mock|off        abort (default) = honest network error
//   INTERCEPT_BLOCK_POST=writes|all|none writes (default) = block POST unless read-shaped
const INTERCEPT_MODE = (process.env.INTERCEPT_MODE || 'abort').toLowerCase();
const INTERCEPT_BLOCK_POST = (process.env.INTERCEPT_BLOCK_POST || 'writes').toLowerCase();
// Auth/session infra is NEVER blocked — aborting the token refresh would kill
// the session and bounce every route back to /login.
const AUTH_ALLOW_RE = /\/(oidc|auth|authorize|token|session|refresh|login|logout|sso|callback|userinfo|\.well-known)\b|accounts\.google\.com|login\.microsoftonline\.com|login\.live\.com|okta\.com|auth0\.com|aadcdn\.msftauth\.net/i;
// Read-shaped POSTs (search/query/graphql/…) are reads, not creates — allow.
const READ_POST_RE = /\/(search|query|list|filter|graphql|batch|export|report|count|lookup|resolve|validate|preview|autocomplete|suggest)\b/i;

function isWriteRequest(method, url) {
  const m = (method || 'GET').toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS' || m === 'TRACE') return false;
  if (m === 'POST') {
    if (INTERCEPT_BLOCK_POST === 'none') return false;
    if (INTERCEPT_BLOCK_POST === 'all')  return true;
    return !READ_POST_RE.test(url);   // 'writes': block POST unless read-shaped
  }
  return true;   // PUT / PATCH / DELETE / unknown verb → treat as a write
}

// Per-page click cap. Default `Infinity` = exhaustive (the user's stated
// agenda: click EVERY non-destructive clickable on every page). Set to a
// finite integer to keep runs bounded on data-table-heavy pages.
const SAFE_CLICK_MAX_PER_PAGE = (() => {
  const v = process.env.SAFE_CLICK_MAX_PER_PAGE;
  if (v == null || v === '' || v === 'infinity' || v === 'Infinity') return Infinity;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : Infinity;
})();
// Recursive click-graph DFS budget. The interact pass starts from each
// page captured by the main BFS, but when a click discovers a NEW URL we
// push it for further exploration up to MAX_INTERACT_DEPTH click-hops
// and MAX_INTERACT_PAGES total nodes.
const MAX_INTERACT_DEPTH = Number(process.env.MAX_INTERACT_DEPTH || 5);
const MAX_INTERACT_PAGES = Number(process.env.MAX_INTERACT_PAGES || 200);
// Wall-clock safety: the unified walker terminates gracefully after this
// many ms and writes a partial graph. Tunable for slow remote SPAs.
const CRAWL_BUDGET_MS = Number(process.env.CRAWL_BUDGET_MS || 600_000);

// Output dir is overridable so the LLM-primary `crawler-llm` extractor
// can write to `output/crawler-llm/` without clobbering the heuristic
// crawler's output.
const OUT_DIR_NAME = process.env.CRAWLER_OUT_DIR_NAME || 'crawler';
const OUT_DIR = path.join(REPO_ROOT, 'output', OUT_DIR_NAME);
// auth-state.json is SHARED across all crawler variants — it represents
// the user's SSO session for the target app, not per-extractor state.
// Both `crawler` and `crawler-llm` read/write the same file. The wipe
// step still preserves it because we copy it out before the rmSync.
const SHARED_AUTH_DIR = path.join(REPO_ROOT, 'output', 'crawler');
const RAW_DIR = path.join(OUT_DIR, 'raw');
const BODIES_DIR = path.join(OUT_DIR, 'bodies');
const SHOTS_DIR = path.join(OUT_DIR, 'screenshots');
const DATA_DIR = path.join(OUT_DIR, 'data');
// auth-state.json is intentionally OUTSIDE OUT_DIR so a single SSO covers
// every crawler variant (heuristic `crawler`, LLM-primary `crawler-llm`,
// future siblings). Lives in output/crawler/auth-state.json — the
// historical location, preserved for backward compat.
const AUTH_STATE = path.join(SHARED_AUTH_DIR, 'auth-state.json');

// Preserve auth-state.json across wipes (it's user-owned via login-once.mjs).
// We read it from the SHARED location, wipe OUT_DIR (which may be the
// shared location for the default crawler — that's fine), then write it
// back to the shared location.
let preservedAuthState = null;
if (fs.existsSync(AUTH_STATE)) {
  preservedAuthState = fs.readFileSync(AUTH_STATE);
}

fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.mkdirSync(RAW_DIR, { recursive: true });
fs.mkdirSync(BODIES_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
if (CAPTURE_SCREENSHOTS) fs.mkdirSync(SHOTS_DIR, { recursive: true });
// Ensure the shared auth dir exists too (only matters when this run is
// crawler-llm and the user has never run plain crawler before).
fs.mkdirSync(SHARED_AUTH_DIR, { recursive: true });

if (preservedAuthState) {
  fs.writeFileSync(AUTH_STATE, preservedAuthState);
}

// Parse the auth state (if any) for cookie/localStorage injection. MUTABLE —
// after the auth warm-up establishes a session, we replace this with the
// fresh (rotated) storageState so the fan-out workers inject the LIVE token,
// not the stale one, and we persist it back to disk for the next run.
let authState = fs.existsSync(AUTH_STATE)
  ? JSON.parse(fs.readFileSync(AUTH_STATE, 'utf8'))
  : null;

// Serialize session recovery: with a single-use rotating refresh token, two
// contexts refreshing at once invalidate each other. This chain ensures only
// ONE recoverSession() runs at a time — each rotation completes before the
// next begins.
let _recoveryChain = Promise.resolve();
function serializedRecover(fn) {
  const run = _recoveryChain.then(fn, fn);
  _recoveryChain = run.catch(() => {});   // never let a rejection break the chain
  return run;
}

const streams = {
  req: fs.createWriteStream(path.join(RAW_DIR, 'requests.ndjson')),
  res: fs.createWriteStream(path.join(RAW_DIR, 'responses.ndjson')),
  pages: fs.createWriteStream(path.join(RAW_DIR, 'pages.ndjson')),
  console: fs.createWriteStream(path.join(RAW_DIR, 'console.ndjson')),
  failed: fs.createWriteStream(path.join(RAW_DIR, 'failed.ndjson')),
  ws: fs.createWriteStream(path.join(RAW_DIR, 'websockets.ndjson')),
  // spec-15: write requests the mutation-guard blocked at the wire. Each is a
  // test candidate (method + path + body + auth header) for the host to
  // classify and the generator to turn into a curl.
  blocked: fs.createWriteStream(path.join(RAW_DIR, 'blocked-mutations.ndjson')),
};
function writeNd(stream, obj) { stream.write(JSON.stringify(obj) + '\n'); }

const SKIP_RESOURCE_TYPES = new Set([
  'image', 'font', 'media', 'stylesheet', 'manifest',
]);
const seenBodyHashes = new Set();

function safeFileName(url) {
  return url.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 100);
}

// ----- per-page DOM/storage/timing capture -----
// Runs entirely in the browser context. Returns plain-JSON data.
async function snapshotPageInBrowser(page) {
  return await page.evaluate(() => {
    const text = el => (el?.textContent || '').trim().slice(0, 200);
    const meta = [...document.querySelectorAll('meta')].map(m => ({
      name: m.getAttribute('name') || m.getAttribute('property') || null,
      content: (m.getAttribute('content') || '').slice(0, 500),
    })).filter(m => m.name);
    const headings = [...document.querySelectorAll('h1,h2,h3,h4')].map(h => ({
      tag: h.tagName.toLowerCase(), text: text(h),
    }));
    const forms = [...document.querySelectorAll('form')].map(f => ({
      action: f.getAttribute('action') || null,
      resolvedAction: f.action || null,
      method: (f.getAttribute('method') || 'get').toLowerCase(),
      id: f.id || null,
      name: f.getAttribute('name') || null,
      fields: [...f.querySelectorAll('input,select,textarea')].map(i => {
        // Try to resolve an associated label (via for= or wrapping)
        let labelText = null;
        if (i.id) {
          const lbl = document.querySelector(`label[for='${CSS.escape(i.id)}']`);
          if (lbl) labelText = (lbl.textContent || '').trim().slice(0, 100);
        }
        if (!labelText) {
          const wrap = i.closest('label');
          if (wrap) labelText = (wrap.textContent || '').trim().slice(0, 100);
        }
        return {
          name: i.name || null,
          id: i.id || null,
          ariaLabel: i.getAttribute('aria-label') || null,
          labelText,
          type: i.type || i.tagName.toLowerCase(),
          placeholder: i.getAttribute('placeholder') || null,
          required: i.required || false,
          value: i.type === 'password' ? '<redacted>' : (i.value || '').slice(0, 200),
          options: i.tagName === 'SELECT'
            ? [...i.options].map(o => ({ value: o.value, label: o.textContent.trim() })).slice(0, 50)
            : undefined,
        };
      }),
      buttons: [...f.querySelectorAll('button,input[type=submit],input[type=button]')].map(b => ({
        text: text(b) || b.value || null,
        type: b.type || 'submit',
      })),
    }));
    const buttonsOutsideForms = [...document.querySelectorAll('button')]
      .filter(b => !b.closest('form'))
      .map(b => ({
        text: text(b),
        type: b.type || 'button',
        disabled: b.disabled,
        ariaLabel: b.getAttribute('aria-label') || null,
        dataAttrs: Object.fromEntries(Object.entries(b.dataset || {})),
      }));
    const links = [...document.querySelectorAll('a[href]')].map(a => ({
      href: a.href,
      text: text(a),
      target: a.target || null,
      rel: a.rel || null,
    }));
    const images = [...document.querySelectorAll('img')].map(i => ({
      src: i.src, alt: i.alt || null, width: i.naturalWidth, height: i.naturalHeight,
    }));
    const iframes = [...document.querySelectorAll('iframe')].map(f => ({
      src: f.src || null, name: f.name || null, id: f.id || null,
    }));
    const scripts = [...document.querySelectorAll('script[src]')].map(s => s.src);
    let localStorageKv = {}, sessionStorageKv = {};
    try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); localStorageKv[k] = (localStorage.getItem(k) || '').slice(0, 500); } } catch {}
    try { for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); sessionStorageKv[k] = (sessionStorage.getItem(k) || '').slice(0, 500); } } catch {}
    const timing = {};
    try {
      const nav = performance.getEntriesByType('navigation')[0];
      if (nav) {
        timing.domContentLoadedMs = Math.round(nav.domContentLoadedEventEnd);
        timing.loadMs = Math.round(nav.loadEventEnd);
        timing.responseEndMs = Math.round(nav.responseEnd);
        timing.transferSize = nav.transferSize;
      }
    } catch {}
    return {
      title: document.title || null,
      lang: document.documentElement.lang || null,
      url: location.href,
      meta, headings, forms,
      buttonsOutsideForms, links, images, iframes, scripts,
      localStorage: localStorageKv,
      sessionStorage: sessionStorageKv,
      timing,
      domNodeCount: document.querySelectorAll('*').length,
    };
  });
}

// ----- listeners attached once per page -----
function attachListeners(page, pageUrlHint) {
  const currentPageUrl = () => {
    const live = page.url();
    return (live && live !== 'about:blank') ? live : pageUrlHint;
  };

  // ── mutation guard: intercept BEFORE the request leaves the browser ──────
  // Reads (and all auth/session infra) continue untouched; writes are aborted
  // and captured. This is the deterministic safety net for every click — even
  // the icon-only delete the label-regex misses, and even the final Confirm.
  if (INTERCEPT_MODE !== 'off') {
    page.route('**/*', async (route) => {
      let req, method, url;
      try { req = route.request(); method = req.method(); url = req.url(); }
      catch { return route.continue().catch(() => {}); }
      if (AUTH_ALLOW_RE.test(url) || !isWriteRequest(method, url)) {
        return route.continue().catch(() => {});
      }
      try {
        writeNd(streams.blocked, {
          ts: Date.now(),
          pageUrl: currentPageUrl(),
          method, url,
          resourceType: req.resourceType(),
          headers: req.headers(),                       // carries Authorization: Bearer …
          postData: req.postData()?.slice(0, 20_000) ?? null,
          action: INTERCEPT_MODE,
        });
      } catch {}
      if (INTERCEPT_MODE === 'mock') {
        return route.fulfill({
          status: 200, contentType: 'application/json',
          body: '{"ok":true,"_interceptedByCrawler":true}',
        }).catch(() => {});
      }
      return route.abort('blockedbyclient').catch(() => {});
    }).catch(() => {});
  }

  page.on('request', request => {
    if (SKIP_RESOURCE_TYPES.has(request.resourceType())) return;
    const redirectedFrom = request.redirectedFrom();
    const _method = request.method();
    const _url = request.url();
    // Did the mutation-guard intercept this (abort/mock) → it never reached the
    // real server? Same deterministic decision as the route handler above, so
    // EVERY request is saved here (blocked or not) with the flag. The host/LLM
    // decides what to do: a blocked DELETE is still a real, testable endpoint —
    // we clicked the control, captured the request, just didn't let it fire.
    const blocked = INTERCEPT_MODE !== 'off'
      && !AUTH_ALLOW_RE.test(_url)
      && isWriteRequest(_method, _url);
    writeNd(streams.req, {
      ts: Date.now(),
      pageUrl: currentPageUrl(),
      url: _url,
      method: _method,
      resourceType: request.resourceType(),
      headers: request.headers(),
      postData: request.postData()?.slice(0, 20_000) ?? null,
      redirectedFromUrl: redirectedFrom?.url() ?? null,
      blocked,                                   // true = guard aborted/mocked it (no server hit)
      reachedServer: !blocked,                   // convenience inverse for the host
      interceptAction: blocked ? INTERCEPT_MODE : null,   // 'abort' | 'mock' | null
    });
  });

  page.on('response', async response => {
    const r = response.request();
    if (SKIP_RESOURCE_TYPES.has(r.resourceType())) return;
    let bodyHash = null, bodyLen = 0, bodyTooBig = false;
    try {
      const body = await response.body();
      bodyLen = body.length;
      if (bodyLen > 0 && bodyLen <= 2_000_000) {
        bodyHash = createHash('sha256').update(body).digest('hex').slice(0, 16);
        if (!seenBodyHashes.has(bodyHash)) {
          seenBodyHashes.add(bodyHash);
          fs.writeFileSync(path.join(BODIES_DIR, `${bodyHash}.bin`), body);
        }
      } else if (bodyLen > 2_000_000) bodyTooBig = true;
    } catch {}
    writeNd(streams.res, {
      ts: Date.now(),
      pageUrl: currentPageUrl(),
      url: response.url(),
      method: r.method(),
      status: response.status(),
      resourceType: r.resourceType(),
      contentType: response.headers()['content-type'] || null,
      headers: response.headers(),
      requestHeaders: r.headers(),
      bodyHash, bodyLen, bodyTooBig,
      timingMs: (() => { try { return Math.round(response.request().timing()?.responseEnd ?? 0); } catch { return 0; } })(),
    });
  });

  page.on('requestfailed', request => {
    writeNd(streams.failed, {
      ts: Date.now(),
      pageUrl: currentPageUrl(),
      url: request.url(),
      method: request.method(),
      resourceType: request.resourceType(),
      errorText: request.failure()?.errorText || null,
    });
  });

  page.on('console', msg => {
    const type = msg.type();
    if (type !== 'error' && type !== 'warning') return;
    writeNd(streams.console, {
      ts: Date.now(),
      pageUrl: currentPageUrl(),
      type,
      text: msg.text().slice(0, 2000),
      location: msg.location ? { url: msg.location().url, line: msg.location().lineNumber } : null,
    });
  });

  page.on('pageerror', err => {
    writeNd(streams.console, {
      ts: Date.now(),
      pageUrl: currentPageUrl(),
      type: 'pageerror',
      text: (err?.message || String(err)).slice(0, 2000),
      stack: (err?.stack || '').slice(0, 4000),
    });
  });

  page.on('websocket', ws => {
    writeNd(streams.ws, {
      ts: Date.now(), pageUrl: currentPageUrl(), event: 'open', url: ws.url(),
    });
    let sent = 0, received = 0;
    ws.on('framesent', () => sent++);
    ws.on('framereceived', () => received++);
    ws.on('close', () => writeNd(streams.ws, {
      ts: Date.now(), pageUrl: currentPageUrl(), event: 'close', url: ws.url(), framesSent: sent, framesReceived: received,
    }));
  });
}

// Block until the page.url() has been unchanged for `idleMs` consecutive ms,
// or `maxMs` total elapses. Catches client-side `router.push` redirects that
// happen after `networkidle` (e.g. /logout → /login via JS).
async function waitForUrlStable(page, idleMs = URL_STABLE_IDLE_MS, maxMs = URL_STABLE_MAX_MS) {
  const start = Date.now();
  let lastUrl = page.url();
  let lastChangeAt = Date.now();
  while (Date.now() - start < maxMs) {
    await page.waitForTimeout(150);
    const cur = page.url();
    if (cur !== lastUrl) {
      lastUrl = cur;
      lastChangeAt = Date.now();
    } else if (Date.now() - lastChangeAt >= idleMs) {
      return;
    }
  }
}

// ── LLM auth-flow advisor helpers ─────────────────────────────────────────
//
// `classifyAuthFlow` extracts a small DOM excerpt and asks the advisor
// what kind of page this is. The result is consumed by `maybeLogin`
// just below to decide whether to fill creds, follow SSO steps, or
// skip the page entirely.

async function classifyAuthFlow(page, log) {
  let url = '';
  let title = '';
  let dom = '';
  try {
    url = page.url();
    title = await page.title().catch(() => '');
    // Truncated DOM excerpt — focus on forms, buttons, headings, top-level
    // structure. Avoid sending huge HTML (cost + token budget).
    dom = await page.evaluate(() => {
      const grab = (sel) => [...document.querySelectorAll(sel)].slice(0, 25);
      const lines = [];
      lines.push(`<title>${document.title}</title>`);
      for (const h of grab('h1, h2, h3, legend')) lines.push(`<${h.tagName.toLowerCase()}>${h.textContent?.trim().slice(0, 120) || ''}</${h.tagName.toLowerCase()}>`);
      for (const f of grab('form')) {
        const action = f.getAttribute('action') || '';
        const method = f.getAttribute('method') || '';
        lines.push(`<form action="${action}" method="${method}">`);
        for (const inp of [...f.querySelectorAll('input, select, textarea')].slice(0, 20)) {
          const attrs = [
            inp.type ? `type="${inp.type}"` : '',
            inp.name ? `name="${inp.name}"` : '',
            inp.id ? `id="${inp.id}"` : '',
            inp.getAttribute('placeholder') ? `placeholder="${inp.getAttribute('placeholder')}"` : '',
            inp.getAttribute('aria-label') ? `aria-label="${inp.getAttribute('aria-label')}"` : '',
          ].filter(Boolean).join(' ');
          lines.push(`  <input ${attrs}/>`);
        }
        for (const b of [...f.querySelectorAll('button, input[type=submit]')].slice(0, 6)) {
          lines.push(`  <button>${(b.textContent || b.value || '').trim().slice(0, 80)}</button>`);
        }
        lines.push('</form>');
      }
      // Top-level buttons + links not inside forms (often the SSO buttons).
      for (const b of grab('body > * button, body > * a[role=button]').slice(0, 10)) {
        lines.push(`<button>${b.textContent?.trim().slice(0, 80) || ''}</button>`);
      }
      for (const a of grab('a').slice(0, 10)) {
        const href = a.getAttribute('href') || '';
        lines.push(`<a href="${href.slice(0, 120)}">${a.textContent?.trim().slice(0, 60) || ''}</a>`);
      }
      return lines.join('\n');
    }).catch(() => '');
  } catch {
    return null;
  }

  const advice = await adviseOn({
    kind: 'auth-detect',
    input: { url, title, dom },
  });
  return advice?.recommendation ?? null;
}


// Runs an LLM-recommended sequence of click/fill/wait steps. Used for
// SSO flows where the standard fill-creds path can't deal with the
// multi-page redirect dance.
async function executeAuthSteps(page, steps, log) {
  const creds = {
    'creds.email':    LOGIN_EMAIL,
    'creds.password': LOGIN_PASSWORD,
  };
  for (const step of steps) {
    try {
      if (step.op === 'click') {
        const sel = step.selector;
        if (!sel) continue;
        // `text=` selector form lets the LLM target by visible label.
        await page.locator(sel).first().click({ timeout: 5_000 });
      } else if (step.op === 'fill') {
        const sel = step.selector;
        const val = creds[step.valueSource] ?? '';
        if (!sel || !val) continue;
        await page.locator(sel).first().fill(val, { timeout: 5_000 });
      } else if (step.op === 'wait') {
        if (step.for === 'navigation') {
          await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
          await waitForUrlStable(page);
        } else if (step.for?.startsWith('selector:')) {
          await page.locator(step.for.slice('selector:'.length)).first()
            .waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {});
        }
      }
    } catch (e) {
      (log?.warning ?? console.warn).call(log || console,
        `[auth-detect] step failed (${step.op} ${step.selector ?? step.for ?? ''}): ${e.message}`);
      return false;
    }
  }
  return true;
}


async function maybeLogin(page, log) {
  // No creds → no login attempt. Lets the crawler work on apps with no
  // auth wall without requiring fake/placeholder credentials.
  if (!LOGIN_EMAIL || !LOGIN_PASSWORD) return false;

  // ── LLM advisor: classify the auth flow BEFORE attempting it ─────────────
  //
  // Old behaviour: the heuristic fired on any URL matching /login/ and
  // happily clicked a "Sign in" button. On /register (a sign-up form)
  // that button doesn't exist → 5s timeout → crawl gets stuck on the
  // auth wall.
  //
  // New: ask the advisor what kind of page this is and what to do.
  // The advisor handles its own timeout + falls back to null. When it
  // returns null we use the rule-based path below (today's behaviour).
  const advice = await classifyAuthFlow(page, log);
  if (advice) {
    const { type, action, reasoning } = advice;
    (log?.info ?? console.log).call(log || console,
      `[auth-detect] type=${type} action=${action} — ${reasoning}`);

    if (action === 'skip' || action === 'log_and_continue') {
      // Registration / password-reset / not-auth → don't attempt login.
      return false;
    }
    if (type === 'sso_redirect' && action === 'click_sso_button') {
      return await executeAuthSteps(page, advice.steps ?? [], log);
    }
    // Otherwise fall through to the email/password fill path below.
  }

  const emailLoc = page.locator(LOGIN_EMAIL_SELECTOR).first();
  const pwdLoc   = page.locator(LOGIN_PASSWORD_SELECTOR).first();
  // Wait up to 4s for either the email or password field to materialize (some
  // login pages render after async JS / IdP redirect).
  await Promise.race([
    emailLoc.waitFor({ state: 'visible', timeout: 4_000 }).catch(() => {}),
    pwdLoc.waitFor({ state: 'visible', timeout: 4_000 }).catch(() => {}),
  ]);
  const hasEmail = await emailLoc.isVisible({ timeout: 400 }).catch(() => false);
  const hasPwd   = await pwdLoc.isVisible({ timeout: 400 }).catch(() => false);
  if (!hasEmail || !hasPwd) {
    // No fillable form on the app's own login page — it may be a pure
    // "Sign in with <provider>" button (Google/Microsoft/GitHub/Okta/…).
    // Click it and drive the resulting IdP's native login deterministically;
    // this stops at MFA/CAPTCHA/popup, which the interactive fallback handles.
    if (LOGIN_URL_REGEX.test(page.url()) && (LOGIN_EMAIL || LOGIN_PASSWORD)) {
      const isDone = (u) => !LOGIN_URL_REGEX.test(u) && !EXTERNAL_IDP_RE.test(u);
      const sso = await attemptSsoLogin(page, { email: LOGIN_EMAIL, password: LOGIN_PASSWORD, isDone, log: log || console });
      if (sso.ok) {
        (log?.info ?? console.log).call(log || console, `[auth] SSO login OK — landed at ${sso.landedUrl}`);
        return true;
      }
      (log?.info ?? console.log).call(log || console, `[auth] SSO auto-drive stopped: ${sso.reason}`);
    }
    if (LOGIN_URL_REGEX.test(page.url())) {
      // Dump diagnostic so the user can see what's on the page and override
      // LOGIN_EMAIL_SELECTOR / LOGIN_PASSWORD_SELECTOR / LOGIN_SUBMIT_TEXT.
      const diag = await page.evaluate(() => ({
        title: document.title,
        url:   location.href,
        inputs: [...document.querySelectorAll('input')].slice(0, 20).map(i => ({
          tag: 'input', type: i.type, name: i.name || null, id: i.id || null,
          placeholder: i.getAttribute('placeholder') || null,
          ariaLabel: i.getAttribute('aria-label') || null,
          visible: i.offsetParent !== null,
        })),
        buttons: [...document.querySelectorAll('button, input[type=submit], a[role=button]')].slice(0, 15).map(b => ({
          tag: b.tagName.toLowerCase(), text: (b.textContent || b.value || '').trim().slice(0, 60),
          type: b.type || null, id: b.id || null,
        })),
      })).catch(() => null);
      const hint = authState
        ? `→ login URL matched but no fillable form (auth-state.json may be expired — re-run \`npm run login\`)`
        : `→ login URL matched but no fillable form. THIS LOOKS LIKE SSO — run \`npm run login\` FIRST to save an authenticated session, then re-run this command.`;
      (log?.info ?? console.log).call(log || console,
        `${hint}\n  DOM diag: ${JSON.stringify(diag, null, 2)}`);
    }
    return false;
  }
  (log?.info ?? console.log).call(log || console, '→ login form detected, signing in');
  try {
    // CRITICAL: React controlled inputs ignore Playwright's .fill() in some
    // cases — fill() sets the DOM value but doesn't fire the synthetic
    // React onChange event the component listens for. Result: React state
    // stays empty, the submit handler thinks the fields are blank, the
    // form falls through to its HTML default (often GET to the same URL),
    // and we see `finalUrl=/login` with `triggeredApis: []`.
    //
    // .pressSequentially() types character-by-character, which fires
    // input events React actually picks up.
    await emailLoc.click({ timeout: 5_000 }).catch(() => {});
    await emailLoc.fill('', { timeout: 5_000 }).catch(() => {});       // clear first
    await emailLoc.pressSequentially(LOGIN_EMAIL, { delay: 15, timeout: 8_000 });

    await pwdLoc.click({ timeout: 5_000 }).catch(() => {});
    await pwdLoc.fill('', { timeout: 5_000 }).catch(() => {});
    await pwdLoc.pressSequentially(LOGIN_PASSWORD, { delay: 15, timeout: 8_000 });

    const submit = LOGIN_SUBMIT_SELECTOR
      ? page.locator(LOGIN_SUBMIT_SELECTOR).first()
      : page.locator('button[type=submit]', { hasText: new RegExp(`^${LOGIN_SUBMIT_TEXT}$`, 'i') }).first();
    // Race the click with a navigation listener so we definitively know
    // whether the click triggered a real submit (vs. silently no-op'ing).
    const navPromise = page.waitForNavigation({ timeout: 8_000, waitUntil: 'domcontentloaded' }).catch(() => null);
    await submit.click({ timeout: 5_000 });
    const nav = await navPromise;
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    await waitForUrlStable(page);
    const postUrl = page.url();
    if (LOGIN_URL_REGEX.test(postUrl)) {
      (log?.warning ?? console.warn).call(log || console,
        `[auth] login click fired but URL is still ${postUrl} — credentials may be invalid or React form didn't accept the value`);
      return false;
    }
    (log?.info ?? console.log).call(log || console,
      `[auth] login OK — landed at ${postUrl}${nav ? '' : ' (no navigation event)'}`);
    return true;
  } catch (e) {
    (log?.warning ?? console.warn).call(log || console, `login failed: ${e.message}`);
    return false;
  }
}

// Capture rich page record + screenshot + cookies + DOM snapshot.
async function recordPage(page, requestedUrl, navStatus, phase = 'crawl', extra = {}) {
  const finalUrl = page.url();
  const safe = safeFileName(finalUrl);
  let screenshotPath = null;
  if (CAPTURE_SCREENSHOTS) {
    try {
      const file = path.join(SHOTS_DIR, `${safe}.png`);
      await page.screenshot({ path: file, fullPage: true, timeout: 5_000 });
      screenshotPath = path.relative(OUT_DIR, file);
    } catch {}
  }
  let snap = null;
  if (CAPTURE_DOM) {
    try { snap = await snapshotPageInBrowser(page); } catch (e) {
      snap = { error: e.message };
    }
  }
  let cookies = [];
  try { cookies = await page.context().cookies(); } catch {}
  writeNd(streams.pages, {
    ts: Date.now(),
    phase,
    requestedUrl,
    finalUrl,
    navStatus,
    screenshotPath,
    cookies,
    snapshot: snap,
    ...extra,
  });
}

// ────────────────────────────────────────────────────────────────────────
// ── SSO session recovery — the refresh-cookie race ───────────────────────
//
// Apps that keep the ACCESS token in memory and mint it from an httpOnly
// REFRESH cookie (e.g. `surface_refresh`) via `POST /oidc/refresh` bounce a
// HARD navigation to /login whenever the route guard checks for a token
// BEFORE the silent refresh XHR returns. There is no form to fill (it's
// SSO), so `maybeLogin` correctly gives up — but the session is perfectly
// valid. We recover by letting the refresh settle and RE-navigating the
// intended route (the refresh cookie is re-sent each time). This is why a
// route reached by an in-app click worked but a direct goto bounced.
const _IDP_RE = EXTERNAL_IDP_RE;

async function recoverSession(page, intendedUrl, log) {
  if (!authState) return false;                    // nothing saved → can't recover, fall back to form login
  const say = (m) => (log?.info ?? console.log).call(log || console, m);
  const target = intendedUrl || page.url();
  // Recovered = we're on a REAL app page: not the login route, and not parked
  // on an external IdP mid-handshake.
  const looksRecovered = () => {
    const u = page.url();
    return !LOGIN_URL_REGEX.test(u) && !_IDP_RE.test(u);
  };
  // The app self-heals a stale access token via SILENT SSO: refresh 401 →
  // /oidc/login/<idp>?prompt=none → IdP round-trip (saved cookies, no UI) →
  // /oidc/callback → refresh 200. That chain takes 10-20s and MUST NOT be
  // interrupted — the old bug re-navigated after 8s and killed it mid-flight.
  // So: navigate once, then POLL for it to land (no interrupting goto).
  const settle = async (ms) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (looksRecovered()) { await waitForUrlStable(page).catch(() => {}); if (looksRecovered()) return true; }
      await page.waitForTimeout(500);
    }
    return looksRecovered();
  };
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
    if (await settle(22_000)) {              // generous — covers the IdP round-trip
      say(`[auth] session recovered via silent SSO (attempt ${attempt}) → ${page.url()}`);
      return true;
    }
  }
  say(`[auth] session recovery failed after 3 attempts — still at ${page.url()}`);
  return false;
}

// ── interactive manual-login fallback ────────────────────────────────────
// When automatic recovery fails (dead session / silent SSO won't fire), open a
// VISIBLE browser (login-once.mjs) and let the human sign in — SSO, MFA, the
// works. login-once auto-detects the authenticated landing, saves the session
// to auth-state.json, and exits; we reload it and resume the crawl. Runs at
// most ONCE per crawl (promise-guarded) so we never pop 8 windows. Disable in
// headless/CI with CRAWL_INTERACTIVE_LOGIN=0.
const INTERACTIVE_LOGIN = (process.env.CRAWL_INTERACTIVE_LOGIN ?? '1') !== '0';
let _interactiveLoginPromise = null;

function _spawnLoginOnce() {
  return new Promise((resolve) => {
    const script = path.join(__dirname, 'login-once.mjs');
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, BASE_URL, SEED_PATH },
      stdio: 'inherit',   // the user sees login-once's prompts; a real window opens
    });
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

async function ensureInteractiveLogin() {
  if (!INTERACTIVE_LOGIN) return false;
  if (_interactiveLoginPromise) return _interactiveLoginPromise;   // already running/done → all workers await it
  _interactiveLoginPromise = (async () => {
    console.log('\n[auth] ⚠ automatic sign-in failed — opening a browser window for MANUAL login.');
    console.log('[auth]   Complete the SSO / MFA in the window; it saves and closes automatically once you reach the app.\n');
    const code = await _spawnLoginOnce();
    if (code === 0 && fs.existsSync(AUTH_STATE)) {
      try { authState = JSON.parse(fs.readFileSync(AUTH_STATE, 'utf8')); }
      catch { return false; }
      console.log('[auth] ✓ manual login captured — resuming the crawl with the fresh session.\n');
      return true;
    }
    console.warn(`[auth] manual login did not complete (login-once exit ${code}) — continuing unauthenticated.`);
    return false;
  })();
  return _interactiveLoginPromise;
}

// Session injection is handled by the walker pool at CONTEXT CREATION via
// browser.newContext({ storageState }) (see storageStateProvider below) — the
// single source of truth for cookies + localStorage + IndexedDB. There is no
// per-page re-injection helper any more: re-adding cookies after creation
// double-injected and could reintroduce a rotated SSO cookie (the multi-worker
// race). Mid-run interactive-login recovery does its own targeted addCookies.

// ── unified parallel DFS walker (single pass — Crawlee BFS retired) ─────
//
// The crawl is now ONE pass: each worker gets its own BrowserContext,
// shares a single in-process SharedState for dedup, and walks every
// clickable + every redirect + every state-change. Anchors, buttons,
// ARIA-role widgets, and cursor:pointer SPA divs are all enumerated in
// the SAME scan per page (vs. the old BFS-of-anchors + DFS-of-buttons
// two-pass split).
//
// Seeds = SEED_PATHS ∪ POST_CRAWL_URLS. The post-crawl URLs (default
// `/logout`) are tagged with `phase: 'post-crawl'` so `recordPage`
// snapshots stay distinguishable in `output/crawler/raw/pages.ndjson`.
//
// CRAWL_WORKERS=1 reproduces sequential single-context behaviour for
// parity testing. Default is 4 — wall-clock drops ~Nx with N workers.
//
// CRAWL_DISABLED=1 short-circuits the walker (just keeps the existing
// auth-state.json + NDJSON dirs); useful when something else needs to
// run setup-only without crawling.
const CRAWL_DISABLED = (process.env.CRAWL_DISABLED ?? '0') === '1';
if (CRAWL_DISABLED) {
  console.log('[crawl] CRAWL_DISABLED=1 — skipping walker (no pages crawled)');
} else {
  const sameOrigin = (() => { try { return new URL(BASE_URL).origin; } catch { return null; } })();
  // Default bumped 4 → 8: with the pre-discovery phase + dynamic sizing
  // in pool.mjs, this is the *upper bound*. It's not "always spawn 8";
  // it's "spawn up to 8 if the discovery phase finds that many routes."
  const CRAWL_WORKERS = Number(process.env.CRAWL_WORKERS || 8);

  const seedTasks = [
    ...SEED_PATHS.map(p     => ({ url: `${BASE_URL}${p}`, depth: 0, phase: 'seed' })),
    ...POST_CRAWL_URLS.map(p => ({ url: `${BASE_URL}${p}`, depth: 0, phase: 'post-crawl' })),
  ];

  console.log(`[crawl] parallel-DFS walker — seeds=${seedTasks.length}  workers=${CRAWL_WORKERS}  headless=${HEADLESS}`);
  seedTasks.forEach(t => console.log(`        seed [${t.phase}]: ${t.url}`));
  if (authState) {
    const idbDbs = (authState.origins || []).reduce((n, o) => n + (o.indexedDB?.length || 0), 0);
    console.log(`[crawl] using saved auth-state.json (${authState.cookies?.length || 0} cookies, ${idbDbs} IndexedDB db(s))`);
    // A session with NO cookies and NO IndexedDB is an empty shell (e.g. a
    // Firebase-auth app captured without indexedDB:true) — every worker will
    // bounce to /login. Warn loudly instead of looping silently.
    if (!(authState.cookies?.length) && !idbDbs) {
      console.warn('[crawl] ⚠ saved session has no cookies and no IndexedDB — it cannot authenticate anything. Re-run `npm run login` (the login now captures IndexedDB too).');
    }
  }
  console.log(`[crawl]   safe:        /${SAFE_CLICK_REGEX.source}/i`);
  console.log(`[crawl]   destructive (flag, still clicked): /${DESTRUCTIVE_CLICK_REGEX.source}/i`);
  console.log(`[crawl]   never-click (session-breakers, skipped): /${NEVER_CLICK_REGEX.source}/i`);
  console.log(`[crawl]   max-clicks-per-page=${SAFE_CLICK_MAX_PER_PAGE === Infinity ? 'unbounded' : SAFE_CLICK_MAX_PER_PAGE}  max-depth=${MAX_INTERACT_DEPTH}  max-pages=${MAX_INTERACT_PAGES}  budget=${Math.round(CRAWL_BUDGET_MS/1000)}s`);

  const serialized = await runWalkerPool({
    seeds: seedTasks,
    workers: CRAWL_WORKERS,
    sameOrigin,
    safeRe:  SAFE_CLICK_REGEX.source,
    destrRe: DESTRUCTIVE_CLICK_REGEX.source,
    neverRe: NEVER_CLICK_REGEX.source,
    maxClicksPerPage: SAFE_CLICK_MAX_PER_PAGE,
    maxDepth: MAX_INTERACT_DEPTH,
    maxPages: MAX_INTERACT_PAGES,
    budgetMs: CRAWL_BUDGET_MS,
    headless: HEADLESS,
    postNavWaitMs: POST_NAV_WAIT_MS,
    // Periodic on-disk save so a mid-run kill leaves usable data.
    // The pool also writes the final state to this same path on success.
    checkpointPath: path.join(DATA_DIR, 'click-graph.json'),
    // Optional: LLM-primary scanner. Default (undefined) → worker uses
    // the heuristic scanInteractables. crawler-llm extractor switches.
    scannerFn,

    // Saved session is injected at CONTEXT CREATION (not post-hoc): this is
    // the only way IndexedDB-based sessions (Firebase Auth) restore — they
    // have zero cookies, so addCookies() alone leaves workers logged out.
    // Provider (not value) so contexts created after the warm-up rotation
    // pick up the freshest state.
    storageStateProvider: () => authState,

    // Auth warm-up: when we have a saved session, bring up ONE context first
    // (it completes the silent-SSO handshake serially), then fan out the rest
    // seeded with the resulting session — avoids the parallel refresh race.
    serializeAuth: !!authState,
    onAuthWarmed: async (fresh) => {
      if (!fresh) return;
      // The pool captures the discovery/warm-up context UNCONDITIONALLY — even
      // when that context never authenticated (it bounced to /login and only
      // collected IdP iframe cookies). Adopting such a capture clobbers a good
      // session-bearing auth-state with an empty shell: IndexedDB dbs exist but
      // hold ZERO records (Firebase keeps the signed-in user as a record in
      // firebaseLocalStorageDb), and every later run bounces straight back to
      // /login. Guard: never replace state that has storage-side session
      // material with a capture that has none.
      const sessionMaterial = (st) => (st?.origins || []).reduce((n, o) =>
        n + (o.localStorage?.length || 0) +
        (o.indexedDB || []).reduce((m, db) =>
          m + (db.stores || []).reduce((k, s) => k + (s.records?.length || 0), 0), 0), 0);
      if (sessionMaterial(fresh) === 0 && sessionMaterial(authState) > 0) {
        console.warn('[auth] warm-up capture carries no session material (0 localStorage/IndexedDB records) — keeping the existing auth-state.json');
        return;
      }
      authState = fresh;                                  // fan-out workers now inject the LIVE token
      try {
        fs.writeFileSync(AUTH_STATE, JSON.stringify(fresh));   // persist the rotated session for next run
        console.log(`[auth] warm-up captured a fresh session → re-saved auth-state.json (${(fresh.cookies || []).length} cookies)`);
      } catch (e) { console.warn(`[auth] could not re-save auth-state.json: ${e.message}`); }
    },

    // ── per-context setup ──────────────────────────────────────────────
    // Each worker's context starts fresh. Inject the saved auth state,
    // attach the same NDJSON listeners the main crawler uses (so the
    // walker's network traffic lands in the same logs), then verify the
    // session is actually logged in. The check matters because the
    // auth-state.json on disk may be for a different target entirely.
    onContextReady: async (ctx, page, workerId) => {
      // NOTE: no injectAuthState() here — the pool creates every context via
      // browser.newContext({ storageState }) using storageStateProvider (→ the
      // live `authState`), so cookies + localStorage + IndexedDB are already
      // restored at CREATION time. Re-adding them here would double-inject and
      // could reintroduce a stale/rotated cookie (the multi-worker SSO race).
      attachListeners(page, BASE_URL);
      await page.goto(`${BASE_URL}${SEED_PATH}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      await waitForUrlStable(page);
      if (/\/(login|signin|sign-in|auth|sso)\b/i.test(page.url())) {
        console.log(`[interact] w${workerId} redirected to ${page.url()} — recovering session`);
        // Serialize recovery (single-use rotating token) → wait for the silent
        // SSO to settle; only fall back to form-fill when there's no session.
        const recovered = await serializedRecover(() => recoverSession(page, `${BASE_URL}${SEED_PATH}`, console));
        if (!recovered) await maybeLogin(page, console);
        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      }
      // Automatic recovery failed → offer a MANUAL login (visible browser, once
      // per crawl). On success, seed this context with the fresh session + reload.
      if (/\/(login|signin|sign-in)\b/i.test(page.url())) {
        const ok = await ensureInteractiveLogin();
        if (ok) {
          // Cookie-based sessions can be adopted mid-run; IndexedDB-based ones
          // (Firebase) can only be injected at context creation — this worker
          // stays unauthenticated for THIS run, but the state is saved so the
          // NEXT run starts fully logged in (via storageStateProvider).
          if (!(authState.cookies?.length)) {
            console.warn(`[interact] w${workerId} manual login saved, but the session is IndexedDB-based — cannot adopt it into a live context. Re-run the scan; it will start authenticated.`);
          }
          try { await page.context().addCookies(authState.cookies || []); } catch {}
          await page.goto(`${BASE_URL}${SEED_PATH}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
          await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
          await waitForUrlStable(page).catch(() => {});
        }
      }
      if (/\/(login|signin|sign-in)\b/i.test(page.url())) {
        console.warn(`[interact] w${workerId} still on login page (${page.url()}) — this worker will see only the login form`);
      } else {
        console.log(`[interact] w${workerId} authenticated at ${page.url()}`);
      }
    },

    // Mid-DFS re-auth: a HARD navigation to a guarded route can bounce to
    // /login while the app's silent token-refresh is still in flight (SSO
    // refresh-cookie race), or a click slipped past the destructive filter
    // and hit /logout. Recover THIS worker's context (re-navigate the
    // intended route once the token settles) without affecting siblings.
    reAuth: async (page, intendedUrl) => {
      const recovered = authState
        ? await serializedRecover(() => recoverSession(page, intendedUrl, console))
        : false;
      if (!recovered) await maybeLogin(page, console);
    },

    // Hook into the existing per-page snapshot writer (forms, links,
    // buttons → output/crawler/raw/pages.ndjson). Best-effort; the
    // walker continues if a single snapshot fails.
    recordPage: async (page, label, depth, phase, extras) => {
      try { await recordPage(page, label, depth, phase, extras); } catch {}
    },
  });

  // click-graph.json is already on disk — runWalkerPool() writes it
  // periodically as a checkpoint during the run AND once more on natural
  // completion. No additional write needed here.
}

await Promise.all(Object.values(streams).map(s => new Promise(r => s.end(r))));

console.log('[crawl] done.');
console.log(`        output:  output/crawler/   (${seenBodyHashes.size} unique bodies)`);
console.log('[next]  node analyze.mjs && node spec.mjs && node mindmap.mjs');
