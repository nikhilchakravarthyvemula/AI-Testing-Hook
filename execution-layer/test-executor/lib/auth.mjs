// Run-level authentication for the tests the executor drives.
//
// Both halves of a run's auth come from ONE source: the storage state that
// `npm run login` (scripts/crawler/login-once.mjs) captured from a real login.
//
//   UI tests  → browser.newContext({ storageState })  — cookies + localStorage
//   API tests → an `Authorization: Bearer <token>` header
//
// The token is deliberately NOT configured per application. It is HARVESTED: we
// open the target in a logged-in browser and read the bearer off the app's own
// outbound requests. That works whatever the app calls its token and wherever it
// keeps it (localStorage, sessionStorage, memory), because we watch the network,
// not the storage. TEST_BEARER/AUTH_TOKEN stay as an escape hatch for logins we
// cannot automate (SSO/MFA).
//
// Nothing here throws: missing or stale auth is a DEGRADATION the report
// discloses, never a stage failure. A run against a login-walled app with no
// saved session still completes — it just says, loudly, why everything failed.
//
// The harvest is adapted from the proven captureToken() in
// scripts/crawler/openapi-test-gen.mjs, which has driven the legacy API tests.

import fs from 'node:fs';
import path from 'node:path';

// Where `npm run login` actually writes: scripts/crawler/login-once.mjs puts it
// under output/crawler/ (its OUT_DIR), which crawl.mjs and openapi-test-gen.mjs
// also read. output/auth-state.json is checked as a fallback so a hand-placed
// file still works.
const AUTH_STATE_CANDIDATES = [
  path.join('output', 'crawler', 'auth-state.json'),
  path.join('output', 'auth-state.json'),
];
const HARVEST_TIMEOUT_MS = Number(process.env.AUTH_HARVEST_TIMEOUT_MS || 20_000);

// A landing URL that looks like a sign-in screen is how a STALE storage state
// announces itself — the single most useful thing to tell an operator, because
// otherwise every test just fails with a confusing assertion.
const LOGIN_URL = /\/(login|signin|sign-in|auth\/login)(\/|\?|#|$)/i;

/** The saved login state, or null. AUTH_STATE_FILE overrides the search. */
export function authStatePath(repoRoot) {
  if (process.env.AUTH_STATE_FILE) {
    return fs.existsSync(process.env.AUTH_STATE_FILE) ? process.env.AUTH_STATE_FILE : null;
  }
  for (const rel of AUTH_STATE_CANDIDATES) {
    const p = path.join(repoRoot ?? '.', rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Login credentials from the environment, or null. */
export function readCredentials() {
  const email = process.env.LOGIN_EMAIL || '';
  const password = process.env.LOGIN_PASSWORD || '';
  return email && password ? { email, password } : null;
}

// Generic enough for the ordinary email/password form, including the two-step
// (email → then password) variant. Not a login framework: an app whose sign-in
// needs more than this supplies TEST_BEARER instead.
const EMAIL_SEL = 'input[type=email], input[name*=email i], input[id*=email i]';
const PWD_SEL = 'input[type=password]';
const SUBMIT_SEL = [
  'button[type=submit]', 'button:has-text("Sign in")', 'button:has-text("Log in")',
  'button:has-text("Login")', 'button:has-text("Continue")',
].join(', ');

/** Watch a page for the first `Authorization: Bearer` it sends. */
function watchForBearer(page, sink) {
  page.on('request', (req) => {
    const a = req.headers()['authorization'];
    if (!sink.token && a && /^bearer\s+/i.test(a)) sink.token = a.replace(/^bearer\s+/i, '').trim();
  });
}

/**
 * Sign in for real, then read the bearer off the app's own requests.
 *
 * This — not storage-state restore — is the reliable path. An app may keep its
 * token in memory only (no cookie, no localStorage, no sessionStorage), in which
 * case there is literally nothing for a saved session to restore and only an
 * actual login produces a usable credential. Logging in works for the
 * cookie/localStorage apps too, so it is tried first whenever we have
 * credentials.
 */
export async function harvestWithLogin({ baseUrl, email, password, timeoutMs = HARVEST_TIMEOUT_MS }) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  const sink = { token: null };
  let landedUrl = null;

  try {
    const page = await (await browser.newContext()).newPage();
    watchForBearer(page, sink);

    const deadline = Date.now() + timeoutMs;
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: Math.max(5000, timeoutMs / 2) })
      .catch(() => {});

    // Up to four passes: a two-step form needs one per field, plus slack.
    for (let step = 0; step < 4 && Date.now() < deadline; step++) {
      const emailBox = page.locator(EMAIL_SEL).first();
      const pwdBox = page.locator(PWD_SEL).first();
      if (await emailBox.count() && !(await emailBox.inputValue().catch(() => ''))) {
        await emailBox.fill(email).catch(() => {});
      }
      if (await pwdBox.count()) await pwdBox.fill(password).catch(() => {});
      await page.locator(SUBMIT_SEL).first().click().catch(() => {});
      await page.waitForTimeout(2500);
      if (!LOGIN_URL.test(page.url())) break;         // left the sign-in screen
    }

    // The token rides the first authenticated call, which lands after hydration.
    while (!sink.token && Date.now() < deadline) await page.waitForTimeout(250);
    landedUrl = page.url();
  } finally {
    await browser.close().catch(() => {});
  }

  return { token: sink.token, landedUrl };
}

/**
 * Restore a saved session and read the bearer off it. Works for apps that
 * persist their auth (cookie or localStorage); yields nothing for a
 * memory-only-token app, which is why harvestWithLogin is preferred.
 */
export async function harvestBearer({ baseUrl, storageState, timeoutMs = HARVEST_TIMEOUT_MS }) {
  const { chromium } = await import('playwright');   // lazy: only when auth exists
  const browser = await chromium.launch({ headless: true });
  const sink = { token: null };
  let landedUrl = null;

  try {
    const page = await (await browser.newContext({ storageState })).newPage();
    watchForBearer(page, sink);

    const deadline = Date.now() + timeoutMs;
    await page
      .goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: Math.max(5000, timeoutMs / 2) })
      .catch(() => {});
    // The app fires its authenticated calls after hydration, not on first paint.
    while (!sink.token && Date.now() < deadline) await page.waitForTimeout(250);
    landedUrl = page.url();
  } finally {
    await browser.close().catch(() => {});
  }

  return { token: sink.token, landedUrl };
}

/**
 * Resolve the run's auth once, before any test runs.
 *
 * @param {object} args { repoRoot, baseUrl, log }
 * @returns {Promise<{ storageState: string|null, token: string|null, degraded: object[] }>}
 */
export async function resolveAuth({ repoRoot, baseUrl, log = () => {} }) {
  const degraded = [];
  const storageState = authStatePath(repoRoot);
  const credentials = readCredentials();
  const override = process.env.TEST_BEARER || process.env.AUTH_TOKEN || null;
  const base = { storageState, credentials };

  if (override) {
    log('auth: bearer token taken from the environment');
    return { ...base, token: override, degraded };
  }
  if (!baseUrl) return { ...base, token: null, degraded };

  // Prefer an actual login. A saved session only helps an app that PERSISTS its
  // auth; a memory-only-token app has nothing to restore, and signing in works
  // for both. Storage state is still carried for whoever can use it.
  let harvest = { token: null, landedUrl: null };
  const how = credentials ? 'login' : storageState ? 'storage-state' : null;

  if (!how) {
    degraded.push({
      useCase: 'auth', stage: 'execute',
      reason: 'no credentials and no saved login — tests run unauthenticated',
      fallback: 'set LOGIN_EMAIL/LOGIN_PASSWORD (or TEST_BEARER); until then anything behind a login wall fails',
    });
    log('auth: no credentials — tests will run unauthenticated');
    return { ...base, token: null, degraded };
  }

  try {
    harvest = how === 'login'
      ? await harvestWithLogin({ baseUrl, ...credentials })
      : await harvestBearer({ baseUrl, storageState });
  } catch (e) {
    degraded.push({
      useCase: 'auth', stage: 'execute',
      reason: `could not obtain a bearer token via ${how}: ${e.message}`,
      fallback: 'API tests run unauthenticated; set TEST_BEARER to supply one directly',
    });
    log(`auth: token harvest failed (${e.message})`);
    return { ...base, token: null, degraded };
  }

  // Still on a sign-in screen ⇒ the credentials or the saved session did not
  // take. Say so once, here, rather than letting it surface as N unrelated
  // assertion failures across the suite.
  if (harvest.landedUrl && LOGIN_URL.test(harvest.landedUrl)) {
    degraded.push({
      useCase: 'auth', stage: 'execute',
      reason: `authentication did not take (${how}) — ${baseUrl} stayed on ${harvest.landedUrl}`,
      fallback: 'check LOGIN_EMAIL/LOGIN_PASSWORD, or supply TEST_BEARER; tests run unauthenticated',
    });
    log(`auth: ⚠ sign-in did not take (landed on ${harvest.landedUrl})`);
    return { ...base, token: harvest.token, degraded };
  }

  if (!harvest.token) {
    // Not automatically a problem: a cookie-authenticated app never sends a
    // bearer, and its cookies ride along in the browser context.
    log(`auth: signed in via ${how}; no bearer seen (cookie-authenticated app?)`);
    return { ...base, token: null, degraded };
  }

  log(`auth: signed in via ${how}; bearer token obtained for API tests`);
  return { ...base, token: harvest.token, degraded };
}

/**
 * The env a test child needs to authenticate itself.
 *
 * Aliases are deliberate: a generated test picks its own name for the token, and
 * we would rather satisfy the common ones than have a correct test fail on a
 * variable-name mismatch. `ctx.authToken` (harness.mjs) is the canonical form the
 * session prompt teaches.
 */
export function authEnv({ storageState, token, credentials } = {}) {
  return {
    STORAGE_STATE: storageState ?? '',
    AUTH_TOKEN: token ?? '',
    BEARER_TOKEN: token ?? '',
    AUTH_BEARER_TOKEN: token ?? '',
    TEST_BEARER: token ?? '',
    // Sign-in credentials reach the test processes because an app that holds its
    // token in memory cannot be authenticated any other way — a UI test has to
    // perform the login itself. Operator-approved, and scoped to this run's
    // children; tests are told never to print them.
    LOGIN_EMAIL: credentials?.email ?? '',
    LOGIN_PASSWORD: credentials?.password ?? '',
  };
}
