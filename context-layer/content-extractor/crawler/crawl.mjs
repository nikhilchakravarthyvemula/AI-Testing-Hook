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
// in-house unified parallel-DFS walker (./walker/). The
// walker handles its own browser lifecycle, BFS-or-DFS traversal, click-
// graph synthesis, and per-context auth refresh.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import * as auth from './lib/auth-classify.mjs';
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

// Preserve auth-state.json across wipes (produced by ensureAuthenticated()).
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

// Parse the auth state (if any) for cookie/localStorage injection.
// `let` (not const) — ensureAuthenticated() refreshes it after a fresh login.
let authState = fs.existsSync(AUTH_STATE)
  ? JSON.parse(fs.readFileSync(AUTH_STATE, 'utf8'))
  : null;

// `--classify-only` (or AUTH_CLASSIFY_ONLY=1): dry-run the LLM auth classifier
// against the login page and exit — the one-command way to verify SSO-vs-normal
// detection without filling anything.
const AUTH_CLASSIFY_ONLY = process.argv.includes('--classify-only')
  || process.env.AUTH_CLASSIFY_ONLY === '1';

const streams = {
  req: fs.createWriteStream(path.join(RAW_DIR, 'requests.ndjson')),
  res: fs.createWriteStream(path.join(RAW_DIR, 'responses.ndjson')),
  pages: fs.createWriteStream(path.join(RAW_DIR, 'pages.ndjson')),
  console: fs.createWriteStream(path.join(RAW_DIR, 'console.ndjson')),
  failed: fs.createWriteStream(path.join(RAW_DIR, 'failed.ndjson')),
  ws: fs.createWriteStream(path.join(RAW_DIR, 'websockets.ndjson')),
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

  page.on('request', request => {
    if (SKIP_RESOURCE_TYPES.has(request.resourceType())) return;
    const redirectedFrom = request.redirectedFrom();
    writeNd(streams.req, {
      ts: Date.now(),
      pageUrl: currentPageUrl(),
      url: request.url(),
      method: request.method(),
      resourceType: request.resourceType(),
      headers: request.headers(),
      postData: request.postData()?.slice(0, 20_000) ?? null,
      redirectedFromUrl: redirectedFrom?.url() ?? null,
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

// ── Auth ──────────────────────────────────────────────────────────────────
// All login logic lives in ./lib/auth-classify.mjs (one brain shared by the
// pre-crawl ensureAuthenticated, the per-worker reAuth, and mid-crawl
// maybeLogin): LLM classifies the page + supplies selectors/steps, with
// static heuristics as fallback.


// Mid-crawl / per-worker login (headless, no human escalation). Classify the
// page and fill/SSO via the shared module. Headed MFA is handled once up front
// by ensureAuthenticated(); here we just recover a worker that hit /login.
async function maybeLogin(page, log) {
  if (!LOGIN_EMAIL || !LOGIN_PASSWORD) return false;
  const { ok } = await auth.attemptLogin(page, log);
  return ok;
}

// Pre-crawl login — runs ONCE before the worker pool. Tries headless first;
// if the page needs a human (MFA / CAPTCHA / SSO consent) it relaunches a
// HEADED browser and pauses, then saves auth-state.json for the headless
// workers to reuse. Replaces the old `login-once.mjs` + `--sso` flag.
async function ensureAuthenticated() {
  const url = `${BASE_URL}${SEED_PATHS[0] || '/'}`;

  // `--classify-only`: dry-run the LLM classifier and exit (verification).
  if (AUTH_CLASSIFY_ONLY) {
    const b = await chromium.launch({ headless: true });
    const page = await (await b.newContext()).newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 6_000 }).catch(() => {});
    const advice = await auth.classifyAuthFlow(page);
    console.log(`[auth --classify-only] url=${page.url()}\n` +
      (advice ? JSON.stringify(advice, null, 2)
              : 'LLM returned null (disabled / unavailable / unparseable) — would use heuristic fallback'));
    await b.close();
    process.exit(0);
  }

  if (!LOGIN_EMAIL || !LOGIN_PASSWORD) return;          // no creds → nothing to do
  if (authState) {                                       // already have a saved session
    console.log('[auth] reusing existing auth-state.json (delete it to force re-login)');
    return;
  }

  // ── headless attempt ────────────────────────────────────────────────────
  let b = await chromium.launch({ headless: true });
  let ctx = await b.newContext();
  let page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
  let humanNeeded = false;
  if (auth.isLoginUrl(page.url())) {
    const r = await auth.attemptLogin(page, console);
    if (!r.ok) await auth.waitForAuthenticatedLanding(page, { maxWaitMs: 8_000, stableMs: 1_500 });
    // Only a GENUINE human-needed signal (MFA / CAPTCHA / SSO stuck) escalates
    // to headed. A normal-login failure (bad creds/selector) is NOT human-needed
    // — opening a browser wouldn't help; report it and let workers reAuth retry.
    humanNeeded = r.humanNeeded;
  }
  if (auth.isAppAuthenticated(page.url())) {
    await ctx.storageState({ path: AUTH_STATE });
    authState = JSON.parse(fs.readFileSync(AUTH_STATE, 'utf8'));
    console.log(`[auth] headless login OK → saved auth-state.json (${authState.cookies?.length || 0} cookies)`);
    await b.close();
    return;
  }
  await b.close();
  if (!humanNeeded) {
    console.warn('[auth] headless login did not authenticate and no human interaction was detected — ' +
      'check credentials/selectors. Continuing; workers will retry via reAuth.');
    return;
  }

  // ── escalate to headed + human ───────────────────────────────────────────
  if (HEADLESS) {
    // Crawl itself is headless, but login needs a human — open a visible window.
    console.log('\n[auth] login needs a human (MFA / CAPTCHA / SSO consent) — opening a browser. Finish login in it.\n');
  }
  b = await chromium.launch({ headless: false });
  ctx = await b.newContext();
  page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await auth.attemptLogin(page, console).catch(() => {});   // drive what we can; the human finishes
  let landed = await auth.waitForAuthenticatedLanding(page, { maxWaitMs: 300_000, stableMs: 3_000 });
  if (!landed) {
    await auth.pauseForHuman('  → if you ARE logged in, press Enter to save state (Ctrl+C to abort) … ');
    landed = page.url();
  }
  await ctx.storageState({ path: AUTH_STATE });
  authState = JSON.parse(fs.readFileSync(AUTH_STATE, 'utf8'));
  console.log(`[auth] saved auth-state.json — landed at ${landed} (${authState.cookies?.length || 0} cookies)`);
  await b.close();
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
// Shared helper: inject saved auth-state.json cookies + localStorage into
// a fresh BrowserContext. The walker calls this once per worker context
// during onContextReady.
// ────────────────────────────────────────────────────────────────────────
const injectedContexts = new WeakSet();
async function injectAuthState(page) {
  if (!authState) return;
  const ctx = page.context();
  if (injectedContexts.has(ctx)) return;
  injectedContexts.add(ctx);
  if (authState.cookies?.length) await ctx.addCookies(authState.cookies);
  for (const origin of authState.origins || []) {
    const items = (origin.localStorage || []).map(i => [i.name, i.value]);
    if (!items.length) continue;
    await ctx.addInitScript(({ origin: o, items: kv }) => {
      if (window.location.origin === o) {
        for (const [k, v] of kv) { try { localStorage.setItem(k, v); } catch {} }
      }
    }, { origin: origin.origin, items });
  }
}

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
// Intelligent pre-crawl login (headless → headed escalation on human-needed).
// Also handles `--classify-only` (dry-run + exit). Runs before any worker.
await ensureAuthenticated();

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
  if (authState) console.log(`[crawl] using saved auth-state.json (${authState.cookies?.length || 0} cookies)`);
  console.log(`[crawl]   safe:        /${SAFE_CLICK_REGEX.source}/i`);
  console.log(`[crawl]   destructive: /${DESTRUCTIVE_CLICK_REGEX.source}/i`);
  console.log(`[crawl]   max-clicks-per-page=${SAFE_CLICK_MAX_PER_PAGE === Infinity ? 'unbounded' : SAFE_CLICK_MAX_PER_PAGE}  max-depth=${MAX_INTERACT_DEPTH}  max-pages=${MAX_INTERACT_PAGES}  budget=${Math.round(CRAWL_BUDGET_MS/1000)}s`);

  const serialized = await runWalkerPool({
    seeds: seedTasks,
    workers: CRAWL_WORKERS,
    sameOrigin,
    safeRe:  SAFE_CLICK_REGEX.source,
    destrRe: DESTRUCTIVE_CLICK_REGEX.source,
    username: LOGIN_EMAIL,   // account/avatar controls showing this → skip (logout guard)
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

    // ── per-context setup ──────────────────────────────────────────────
    // Each worker's context starts fresh. Inject the saved auth state,
    // attach the same NDJSON listeners the main crawler uses (so the
    // walker's network traffic lands in the same logs), then verify the
    // session is actually logged in. The check matters because the
    // auth-state.json on disk may be for a different target entirely.
    onContextReady: async (ctx, page, workerId) => {
      await injectAuthState(page);
      attachListeners(page, BASE_URL);
      await page.goto(`${BASE_URL}${SEED_PATH}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      await waitForUrlStable(page);
      if (/\/(login|signin|sign-in|auth|sso)\b/i.test(page.url())) {
        console.log(`[interact] w${workerId} redirected to ${page.url()} — running maybeLogin`);
        await maybeLogin(page, console);
        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      }
      if (/\/(login|signin|sign-in)\b/i.test(page.url())) {
        console.warn(`[interact] w${workerId} still on login page (${page.url()}) — this worker will see only the login form`);
      } else {
        console.log(`[interact] w${workerId} authenticated at ${page.url()}`);
      }
    },

    // Mid-DFS re-auth: when a click slips past the destructive filter
    // and lands on /logout, the next page.goto comes back as /login.
    // Workers call reAuth() to recover their own context without
    // affecting siblings.
    reAuth: async (page) => {
      await maybeLogin(page, console);
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
