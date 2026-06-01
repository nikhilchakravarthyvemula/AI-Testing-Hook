// Automatic interactive login. Saves the browser's authenticated state to
// disk so subsequent crawls can skip login entirely. Designed to handle:
//   - Plain email/password forms
//   - Identity-first flows (email only first, password next)
//   - Keycloak / OIDC / "Sign in with SSO" intermediates
//   - Google / Microsoft IDP two-step pages (email → Next → password → Next)
//
// Flow:
//   1. Opens a visible Chrome at BASE_URL.
//   2. Auto-detects + fills any login form it sees. Loops up to 8 times (for
//      multi-page IDP flows). Tries common submit-button labels.
//   3. While auto-fill runs, you CAN intervene in the browser (CAPTCHA, MFA,
//      "click on your phone", etc.) — the script keeps polling.
//   4. When the URL settles on the app's domain AND doesn't look like a login
//      page, saves cookies + localStorage to output/crawler/auth-state.json.
//   5. crawl.mjs picks up that file on subsequent runs.
//
// If auto-detection times out (default 5 min), prompts you to press Enter.
//
// Usage:
//   BASE_URL=... LOGIN_EMAIL=... LOGIN_PASSWORD=... npm run login

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.join(REPO_ROOT, 'output', 'crawler');
const AUTH_STATE = path.join(OUT_DIR, 'auth-state.json');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const SEED_PATH = process.env.SEED_PATH || '/';
const LOGIN_EMAIL = process.env.LOGIN_EMAIL || '';
const LOGIN_PASSWORD = process.env.LOGIN_PASSWORD || '';
const MAX_WAIT_MS = Number(process.env.LOGIN_MAX_WAIT_MS || 300_000);    // 5 min default
const POLL_INTERVAL_MS = 500;
const URL_STABLE_MS = Number(process.env.LOGIN_URL_STABLE_MS || 3000);   // landing must be stable for 3s

const APP_HOST = new URL(BASE_URL).hostname;
const APP_REGISTRABLE = APP_HOST.split('.').slice(-2).join('.'); // e.g. superalign.ai

// URL "looks like login" if it contains common login keywords OR is on a known IDP.
function isLoginUrl(u) {
  return /(login|sign[-_ ]?in|signin|auth|realm|oauth|sso|saml|identifier|password|consent|challenge)/i.test(u)
      || /accounts\.google\.com|login\.microsoftonline\.com|login\.live\.com|okta\.com|onelogin\.com|auth0\.com/i.test(u);
}

// True if we appear to have landed on an authenticated page of the target app.
function isAppAuthenticated(u) {
  try {
    const url = new URL(u);
    if (url.hostname === APP_HOST) return !isLoginUrl(u);
    // Allow sibling subdomain landings (e.g. console-preview vs console)
    if (url.hostname.endsWith('.' + APP_REGISTRABLE) && !/^auth\./.test(url.hostname)) {
      return !isLoginUrl(u);
    }
    return false;
  } catch { return false; }
}

const EMAIL_SELECTORS = [
  "input[type='email']:visible",
  "input[name='email']:visible",
  "input[name='username']:visible",
  "input[id='username']:visible",
  "input[id='identifierId']:visible",         // Google
  "input[name='identifier']:visible",         // Google secondary
  "input[name='loginfmt']:visible",           // Microsoft
];
const PASSWORD_SELECTORS = [
  "input[type='password']:visible",
  "input[name='password']:visible",
  "input[name='Passwd']:visible",             // Google
  "input[name='passwd']:visible",             // Microsoft
];
const SUBMIT_SELECTORS_BY_PRIORITY = [
  "#identifierNext button",                   // Google email step
  "#passwordNext button",                     // Google password step
  "input[type='submit'][value*='Sign in' i]",
  "input[type='submit']",
  "button:has-text('Sign in with SSO')",
  "button:has-text('Sign in')",
  "button:has-text('Log in')",
  "button:has-text('Log In')",
  "button:has-text('Continue')",
  "button:has-text('Next')",
  "button[type='submit']",
];

async function firstVisible(page, selectors) {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible({ timeout: 150 }).catch(() => false)) return loc;
  }
  return null;
}

async function tryFillLoginStep(page) {
  const emailLoc = await firstVisible(page, EMAIL_SELECTORS);
  const pwdLoc   = await firstVisible(page, PASSWORD_SELECTORS);
  if (!emailLoc && !pwdLoc) return 'nothing-here';

  let filled = false;
  if (emailLoc && LOGIN_EMAIL) {
    const cur = await emailLoc.inputValue().catch(() => '');
    if (!cur) { await emailLoc.fill(LOGIN_EMAIL).catch(() => {}); filled = true; }
  }
  if (pwdLoc && LOGIN_PASSWORD) {
    await pwdLoc.fill(LOGIN_PASSWORD).catch(() => {});
    filled = true;
  }

  const submit = await firstVisible(page, SUBMIT_SELECTORS_BY_PRIORITY);
  if (submit) {
    await submit.click().catch(() => {});
    return filled ? 'filled-and-clicked' : 'just-clicked';
  }
  return filled ? 'filled-no-submit' : 'no-submit-found';
}

async function autoLoginLoop(page) {
  console.log('[login-once] starting auto-login loop (up to 8 attempts)…');
  for (let i = 0; i < 8; i++) {
    await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
    const before = page.url();
    if (isAppAuthenticated(before)) { console.log(`  ✓ already authenticated (${before})`); return; }

    const action = await tryFillLoginStep(page);
    console.log(`  step ${i + 1}: at ${before.slice(0, 90)}${before.length > 90 ? '…' : ''}  → ${action}`);
    if (action === 'nothing-here') return;
    await page.waitForTimeout(1500);
    await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});

    const after = page.url();
    if (isAppAuthenticated(after)) { console.log(`  ✓ authenticated (${after})`); return; }
  }
  console.log('[login-once] auto-loop exhausted; if more steps are needed (CAPTCHA, MFA), complete them in the browser.');
}

async function waitForAuthenticatedLanding(page) {
  console.log(`[login-once] watching for authenticated landing (stable for ${URL_STABLE_MS}ms, max ${MAX_WAIT_MS}ms)…`);
  const start = Date.now();
  let stableSince = null;
  let lastUrl = page.url();
  while (Date.now() - start < MAX_WAIT_MS) {
    const cur = page.url();
    if (cur !== lastUrl) { lastUrl = cur; stableSince = null; }
    if (isAppAuthenticated(cur)) {
      if (stableSince == null) stableSince = Date.now();
      if (Date.now() - stableSince >= URL_STABLE_MS) return cur;
    } else {
      stableSince = null;
    }
    await page.waitForTimeout(POLL_INTERVAL_MS);
  }
  return null;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (!LOGIN_EMAIL) console.warn('[login-once] LOGIN_EMAIL not set; auto-fill of email steps will be skipped.');

  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  const url = `${BASE_URL}${SEED_PATH}`;
  console.log(`\n[login-once] opening ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(e => console.warn(`  nav warn: ${e.message}`));

  await autoLoginLoop(page);

  let landed = await waitForAuthenticatedLanding(page);
  if (!landed) {
    console.log('\n[login-once] couldn\'t auto-detect login completion within timeout.');
    console.log('  if you ARE logged in, press Enter to save state now. Ctrl+C to abort.\n');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    await rl.question('  → press Enter to save state ... ');
    rl.close();
    landed = page.url();
  }

  const cookies = await ctx.cookies();
  await ctx.storageState({ path: AUTH_STATE });
  const saved = JSON.parse(fs.readFileSync(AUTH_STATE, 'utf8'));
  const lsCount = (saved.origins || []).reduce((n, o) => n + (o.localStorage?.length || 0), 0);

  console.log(`\n[login-once] saved ${path.relative(REPO_ROOT, AUTH_STATE)}`);
  console.log(`  landed at:         ${landed}`);
  console.log(`  cookies:           ${cookies.length}`);
  console.log(`  localStorage keys: ${lsCount} across ${saved.origins?.length || 0} origin(s)\n`);
  console.log('[login-once] next:  npm run all\n');

  await browser.close();
}

main().catch(e => {
  console.error(`[login-once] failed: ${e.message}`);
  process.exit(1);
});
