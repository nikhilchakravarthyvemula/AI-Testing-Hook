// Harvest a live bearer token from an authenticated browser session.
//
// WHY THIS EXISTS: OIDC / Firebase apps mint their backend access token inside
// the page's JS (from an in-browser identity SDK) and attach it as
// `Authorization: Bearer …` to every backend fetch. That token lives in neither
// a cookie nor a POST-login JSON response, so the api-test-generator's
// credential-POST login flow can't obtain it — and raw curls / Playwright
// request contexts therefore 401 against every authenticated endpoint.
//
// This script loads the crawler's saved session (output/crawler/auth-state.json)
// into a headless context, drives a few authenticated routes to make the app
// issue its backend calls, and captures the Authorization header off the wire.
// It writes output/crawler/auth-token.json — the single source of truth both
// the Python curl builder and the Playwright API specs read to authenticate.
//
// Tokens are short-lived by design, so this runs at execute-time, not once.
//
// Usage: BASE_URL=https://<target> node testo/src/crawler/harvest-token.mjs
// Exit 0 = token written · 1 = no token seen (suites fall back to unauthenticated).
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attemptSsoLogin, tryPlainFormLogin } from './auth/sso.mjs';
import { shouldPersist } from './lib/session-material.mjs';
import { loadAuthProfile } from './auth/profile.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const OUT_DIR = path.join(REPO_ROOT, 'output', 'crawler');
const AUTH_STATE = path.join(OUT_DIR, 'auth-state.json');
const TOKEN_FILE = path.join(OUT_DIR, 'auth-token.json');
const ROUTES_FILE = path.join(OUT_DIR, 'data', 'routes.json');

const HEADLESS = process.env.HEADLESS !== '0';
const HARVEST_TIMEOUT_MS = Number(process.env.HARVEST_TIMEOUT_MS || 45_000);
const LOGIN_EMAIL = process.env.LOGIN_EMAIL || '';
const LOGIN_PASSWORD = process.env.LOGIN_PASSWORD || '';
const LOGIN_URL_RE = /\/(login|signin|sign-in|auth|sso)\b/i;

function log(m) { console.log(`[harvest-token] ${m}`); }

// The saved storageState alone may not authenticate (OIDC refresh cookie
// rotated, or the app re-checks on load and bounces to /login). Recover the
// same way the crawler does: try the plain form first, then fall back to the
// deterministic SSO/form driver, which fills creds and clicks
// "Sign in with <provider>", stopping cleanly at MFA/popup.
async function ensureAuthed(page, baseUrl) {
  await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
  if (!LOGIN_URL_RE.test(page.url())) return true;
  log(`bounced to ${page.url()} — recovering session`);

  if (await tryPlainFormLogin(page, { email: LOGIN_EMAIL, password: LOGIN_PASSWORD })) {
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
    if (!LOGIN_URL_RE.test(page.url())) { log(`recovered via plain form → ${page.url()}`); return true; }
  }

  log(`trying SSO/form driver`);
  const isDone = (u) => !LOGIN_URL_RE.test(u);
  const sso = await attemptSsoLogin(page, {
    email: LOGIN_EMAIL, password: LOGIN_PASSWORD, isDone, log: console,
  }).catch((e) => ({ ok: false, reason: e.message }));
  await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
  if (sso.ok || !LOGIN_URL_RE.test(page.url())) { log(`recovered → ${page.url()}`); return true; }
  log(`recovery did not complete (${sso.reason}) — will still try to capture any token`);
  return false;
}

function detectBaseUrl() {
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/$/, '');
  try {
    const routes = JSON.parse(fs.readFileSync(ROUTES_FILE, 'utf8'));
    const first = (routes.pages || [])[0]?.url;
    if (first) return new URL(first).origin;
  } catch {}
  return null;
}

// Authenticated routes to visit until a backend call carries a bearer. Prefer
// data-heavy pages (they fetch immediately); fall back to the app root.
function routesToVisit(baseUrl) {
  const paths = new Set();
  try {
    const routes = JSON.parse(fs.readFileSync(ROUTES_FILE, 'utf8'));
    for (const p of (routes.pages || [])) {
      try {
        const u = new URL(p.url || p);
        if (u.origin === baseUrl) paths.add(u.pathname + u.search);
      } catch {}
      if (paths.size >= 6) break;
    }
  } catch {}
  // Sensible defaults for a dashboard-style app if routes.json is thin.
  ['/', '/graph', '/inventory', '/endpoints', '/sessions'].forEach((p) => paths.add(p));
  return [...paths].slice(0, 8);
}

async function main() {
  const baseUrl = detectBaseUrl();
  if (!baseUrl) { log('no BASE_URL and no routes.json — cannot harvest'); process.exit(1); }
  if (!fs.existsSync(AUTH_STATE)) { log(`no saved session at ${path.relative(REPO_ROOT, AUTH_STATE)}`); process.exit(1); }

  log(`base=${baseUrl} · driving authenticated routes to capture the app's bearer…`);
  const profile = loadAuthProfile(REPO_ROOT, { log });
  const browser = await chromium.launch({ headless: HEADLESS });
  const ctx = await browser.newContext({
    storageState: AUTH_STATE,
    ...(profile.ignoreHTTPSErrors ? { ignoreHTTPSErrors: true } : {}),
  });
  const page = await ctx.newPage();

  let captured = null;   // { token, scheme, origin, header }
  const onRequest = (req) => {
    if (captured) return;
    const headers = req.headers();
    const auth = headers['authorization'];
    if (!auth) return;
    const m = /^(bearer)\s+(.+)$/i.exec(auth.trim());
    if (!m) return;
    let origin = null;
    try { origin = new URL(req.url()).origin; } catch {}
    // Ignore the identity provider's own calls — we want the app's BACKEND token.
    if (origin && /accounts\.google\.com|identitytoolkit|login\.microsoftonline/.test(origin)) return;
    captured = { token: m[2], scheme: 'Bearer', origin, sampleUrl: req.url() };
    log(`captured bearer from ${req.method()} ${req.url().slice(0, 80)} (${m[2].length} chars)`);
  };
  ctx.on('request', onRequest);   // context-level: catches sub-resource + fetch on any page

  const deadline = Date.now() + HARVEST_TIMEOUT_MS;
  const routes = routesToVisit(baseUrl);
  for (let i = 0; i < routes.length; i++) {
    if (captured || Date.now() > deadline) break;
    const url = baseUrl + routes[i];
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 });
      // First landing: make sure we're actually authenticated before counting
      // on backend calls to appear (they won't fire on the login page).
      if (i === 0) await ensureAuthed(page, baseUrl);
      await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
    } catch (e) { log(`nav ${routes[i]} warn: ${e.message.split('\n')[0].slice(0, 80)}`); }
    // Give the app a beat to fire follow-up fetches.
    if (!captured) await page.waitForTimeout(1_500);
  }

  // Persist the REFRESHED session so the Playwright UI specs start authenticated
  // without each doing its own login. This is the single auth action per run:
  // the crawler's warm-up + this harvest both feed one auth-state.json, and no
  // spec logs in on its own (which, with parallel workers, raced on the
  // single-use SSO refresh token and left the page blank — the bucket-2 bug).
  // Guard: URL check alone false-positives — a route guard that fails open
  // renders the shell at a real path while the session is hollow, and saving
  // that capture clobbers a good auth-state with one that has no session
  // material. So: on an app page AND the capture carries at least as much
  // session material as the saved state (shouldPersist, shared with the
  // crawler's persistSession / onAuthWarmed guards).
  const authed = !LOGIN_URL_RE.test(page.url());
  if (authed) {
    try {
      const fresh = await ctx.storageState({ indexedDB: true });
      let prior = null;
      try { prior = JSON.parse(fs.readFileSync(AUTH_STATE, 'utf8')); } catch {}
      const verdict = shouldPersist(fresh, prior);
      if (verdict.ok) {
        fs.writeFileSync(AUTH_STATE, JSON.stringify(fresh));
        log(`✓ refreshed session → ${path.relative(REPO_ROOT, AUTH_STATE)}`);
      } else {
        log(`not re-saving session — ${verdict.reason}; leaving auth-state.json untouched`);
      }
    } catch (e) { log(`could not re-save auth-state.json: ${e.message}`); }
  } else {
    log('not on an authenticated page — leaving auth-state.json untouched');
  }

  await browser.close();

  if (!captured) {
    log('no bearer observed on any authenticated route — leaving auth-token.json untouched');
    // Non-fatal for the UI suite (storageState may have been refreshed above);
    // exit 1 signals the caller that curls/API specs lack a bearer.
    process.exit(1);
  }

  const payload = { ...captured, harvestedAt: new Date().toISOString(), baseUrl };
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(payload, null, 2));
  log(`✓ wrote ${path.relative(REPO_ROOT, TOKEN_FILE)} (scheme=${captured.scheme}, origin=${captured.origin})`);
  process.exit(0);
}

main().catch((e) => { log(`failed: ${e.message}`); process.exit(1); });
