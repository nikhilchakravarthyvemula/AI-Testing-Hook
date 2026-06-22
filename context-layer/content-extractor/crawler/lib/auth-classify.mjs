// Shared, intelligent auth helpers — ONE brain for every login path
// (crawl.mjs's pre-crawl ensureAuthenticated, its per-worker reAuth, and the
// mid-crawl maybeLogin). Replaces the old split between crawl.mjs (LLM) and
// login-once.mjs (heuristics-only). The LLM classifies the page and supplies
// the actual selectors/steps; static heuristics are the fallback when the LLM
// is off/unavailable.

import readline from 'node:readline/promises';
import { adviseOn } from '../llm-advisor/index.mjs';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
export const LOGIN_EMAIL = process.env.LOGIN_EMAIL || '';
export const LOGIN_PASSWORD = process.env.LOGIN_PASSWORD || '';

// Static fallback selectors (union of crawl.mjs defaults + IDP-specific ones
// from the old login-once). Used only when the LLM doesn't supply selectors.
const FALLBACK_EMAIL = process.env.LOGIN_EMAIL_SELECTOR ||
  "input[type='email'], input[name='email'], input[name='username'], input[id='username'], input[id='identifierId'], input[name='identifier'], input[name='loginfmt']";
const FALLBACK_PASSWORD = process.env.LOGIN_PASSWORD_SELECTOR ||
  "input[type='password'], input[name='password'], input[name='Passwd'], input[name='passwd']";
const FALLBACK_SUBMIT_SELECTOR = process.env.LOGIN_SUBMIT_SELECTOR || '';
const FALLBACK_SUBMIT_TEXT = process.env.LOGIN_SUBMIT_TEXT || 'Sign in';
const SUBMIT_BY_PRIORITY = [
  "#identifierNext button", "#passwordNext button",
  "input[type='submit'][value*='Sign in' i]", "input[type='submit']",
  "button:has-text('Sign in')", "button:has-text('Log in')",
  "button:has-text('Log In')", "button:has-text('Continue')",
  "button:has-text('Next')", "button[type='submit']",
];

const _appHost = (() => { try { return new URL(BASE_URL).hostname; } catch { return ''; } })();
const _appRegistrable = _appHost.split('.').slice(-2).join('.');

export function llmStatus() {
  return { enabled: (process.env.CRAWLER_LLM ?? '1') !== '0' };
}

export function isLoginUrl(u) {
  return /(login|sign[-_ ]?in|signin|auth|realm|oauth|sso|saml|identifier|password|consent|challenge)/i.test(u)
      || /accounts\.google\.com|login\.microsoftonline\.com|login\.live\.com|okta\.com|onelogin\.com|auth0\.com/i.test(u);
}

export function isAppAuthenticated(u) {
  try {
    const url = new URL(u);
    if (url.hostname === _appHost) return !isLoginUrl(u);
    if (url.hostname.endsWith('.' + _appRegistrable) && !/^auth\./.test(url.hostname)) return !isLoginUrl(u);
    return false;
  } catch { return false; }
}


// ── classification ──────────────────────────────────────────────────────────

export async function extractAuthDom(page) {
  return page.evaluate(() => {
    const grab = (sel) => [...document.querySelectorAll(sel)].slice(0, 25);
    const lines = [`<title>${document.title}</title>`];
    for (const h of grab('h1, h2, h3, legend')) lines.push(`<${h.tagName.toLowerCase()}>${(h.textContent || '').trim().slice(0, 120)}</${h.tagName.toLowerCase()}>`);
    for (const f of grab('form')) {
      lines.push(`<form action="${f.getAttribute('action') || ''}" method="${f.getAttribute('method') || ''}">`);
      for (const inp of [...f.querySelectorAll('input, select, textarea')].slice(0, 20)) {
        const attrs = [
          inp.type ? `type="${inp.type}"` : '', inp.name ? `name="${inp.name}"` : '',
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
    for (const b of grab('body > * button, body > * a[role=button]').slice(0, 10)) lines.push(`<button>${(b.textContent || '').trim().slice(0, 80)}</button>`);
    for (const a of grab('a').slice(0, 10)) lines.push(`<a href="${(a.getAttribute('href') || '').slice(0, 120)}">${(a.textContent || '').trim().slice(0, 60)}</a>`);
    return lines.join('\n');
  }).catch(() => '');
}

/** LLM auth classification → {type, action, fields, steps, reasoning, confidence} | null. */
export async function classifyAuthFlow(page) {
  let url = '', title = '', dom = '';
  try {
    url = page.url();
    title = await page.title().catch(() => '');
    dom = await extractAuthDom(page);
  } catch { return null; }
  const advice = await adviseOn({ kind: 'auth-detect', input: { url, title, dom } });
  return advice?.recommendation ?? null;
}

const _log = (log, msg, warn = false) => ((warn ? (log?.warning ?? console.warn) : (log?.info ?? console.log)).call(log || console, msg));


// ── filling ───────────────────────────────────────────────────────────────

// First selector in the list whose .first() is actually visible (so a bad LLM
// selector falls back to the static ones instead of timing out on a click).
async function _firstVisibleLoc(page, selectors, totalWaitMs = 4_000) {
  const sels = selectors.filter(Boolean);
  const deadline = totalWaitMs;
  for (const sel of sels) {
    const loc = page.locator(sel).first();
    if (await loc.waitFor({ state: 'visible', timeout: Math.max(400, deadline / sels.length) }).then(() => true).catch(() => false)) {
      return loc;
    }
  }
  return null;
}

async function _resolveSubmit(page, advice) {
  // Try, in order: LLM selector → configured fallback → text match → priority
  // list → any submit button. Each candidate must be VISIBLE (the LLM sometimes
  // returns over-broad selectors like `button:not(:empty)` that match a hidden
  // element and make .click() time out).
  const candidates = [
    advice?.fields?.submitSelector,
    FALLBACK_SUBMIT_SELECTOR,
    ...SUBMIT_BY_PRIORITY,
  ].filter(Boolean);
  const byText = page.locator('button[type=submit]', { hasText: new RegExp(`^${FALLBACK_SUBMIT_TEXT}$`, 'i') }).first();
  if (await byText.isVisible({ timeout: 300 }).catch(() => false)) return byText;
  for (const sel of candidates) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible({ timeout: 150 }).catch(() => false)) return loc;
  }
  return null;   // caller falls back to pressing Enter
}

/** Fill an email/password form and submit. Uses LLM-provided selectors when
 *  present (advice.fields.*), else the static fallback selectors. React-aware
 *  typing. Returns true if we left the login URL. */
export async function fillNormalLogin(page, advice, log) {
  if (!LOGIN_EMAIL || !LOGIN_PASSWORD) return false;
  // LLM selector first, then static fallback — whichever is actually visible.
  const emailLoc = await _firstVisibleLoc(page, [advice?.fields?.emailSelector, FALLBACK_EMAIL]);
  const pwdLoc   = await _firstVisibleLoc(page, [advice?.fields?.passwordSelector, FALLBACK_PASSWORD]);
  if (!emailLoc || !pwdLoc) {
    _log(log, `[auth] no fillable email/password field found (LLM + fallback selectors all missed)`, true);
    return false;
  }
  try {
    // .pressSequentially fires the synthetic events React controlled inputs need.
    await emailLoc.click({ timeout: 5_000 }).catch(() => {});
    await emailLoc.fill('', { timeout: 5_000 }).catch(() => {});
    await emailLoc.pressSequentially(LOGIN_EMAIL, { delay: 15, timeout: 8_000 });
    await pwdLoc.click({ timeout: 5_000 }).catch(() => {});
    await pwdLoc.fill('', { timeout: 5_000 }).catch(() => {});
    await pwdLoc.pressSequentially(LOGIN_PASSWORD, { delay: 15, timeout: 8_000 });
    const submit = await _resolveSubmit(page, advice);
    const navPromise = page.waitForNavigation({ timeout: 8_000, waitUntil: 'domcontentloaded' }).catch(() => null);
    if (submit) {
      // Don't let one over-broad selector wedge us — fall back to Enter on failure.
      await submit.click({ timeout: 5_000 }).catch(() => pwdLoc.press('Enter').catch(() => {}));
    } else {
      await pwdLoc.press('Enter').catch(() => {});   // no button found — submit via Enter
    }
    await navPromise;
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    const ok = !isLoginUrl(page.url());
    if (!ok) _log(log, `[auth] fill submitted but still on login (${page.url()}) — bad creds or React form rejected input`, true);
    return ok;
  } catch (e) {
    _log(log, `[auth] fillNormalLogin failed: ${e.message}`, true);
    return false;
  }
}

/** Run LLM-provided SSO steps (click/fill/wait). Returns true if it left login. */
export async function executeAuthSteps(page, steps, log) {
  const creds = { 'creds.email': LOGIN_EMAIL, 'creds.password': LOGIN_PASSWORD };
  for (const step of steps || []) {
    try {
      if (step.op === 'click' && step.selector) {
        await page.locator(step.selector).first().click({ timeout: 5_000 });
      } else if (step.op === 'fill' && step.selector) {
        const val = creds[step.valueSource] ?? '';
        if (val) await page.locator(step.selector).first().fill(val, { timeout: 5_000 });
      } else if (step.op === 'wait') {
        if (step.for === 'navigation') await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
        else if (step.for?.startsWith('selector:')) await page.locator(step.for.slice(9)).first().waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {});
      }
    } catch (e) {
      _log(log, `[auth] SSO step failed (${step.op} ${step.selector ?? step.for ?? ''}): ${e.message}`, true);
      return false;
    }
  }
  return !isLoginUrl(page.url());
}


// ── headed-escalation helpers (used by ensureAuthenticated) ─────────────────

export async function waitForAuthenticatedLanding(page, { maxWaitMs = 300_000, stableMs = 3_000, pollMs = 500 } = {}) {
  const start = Date.now();
  let stableSince = null, lastUrl = page.url();
  while (Date.now() - start < maxWaitMs) {
    const cur = page.url();
    if (cur !== lastUrl) { lastUrl = cur; stableSince = null; }
    if (isAppAuthenticated(cur)) {
      if (stableSince == null) stableSince = Date.now();
      if (Date.now() - stableSince >= stableMs) return cur;
    } else stableSince = null;
    await page.waitForTimeout(pollMs);
  }
  return null;
}

export async function pauseForHuman(message) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await rl.question(message || '  → finish login in the browser, then press Enter to save state … ');
  rl.close();
}

/** One attempt on the current page: classify, then fill/SSO/skip. Returns
 *  { ok, advice, humanNeeded }. ok=true means we left the login URL. */
export async function attemptLogin(page, log) {
  const advice = await classifyAuthFlow(page);
  const status = llmStatus();
  if (advice) {
    _log(log, `[auth] LLM=on → verdict=${advice.type} action=${advice.action} (conf ${advice.confidence}) — ${advice.reasoning}`);
    if (advice.action === 'skip') return { ok: false, advice, humanNeeded: false };
    if (advice.action === 'log_and_continue' || advice.type === 'mfa') return { ok: false, advice, humanNeeded: advice.type === 'mfa' };
    if (advice.type === 'sso_redirect') {
      const ok = await executeAuthSteps(page, advice.steps, log);
      return { ok, advice, humanNeeded: !ok };   // SSO ran but still on login → likely human (MFA/consent)
    }
    // normal_login → fill with LLM selectors
    const ok = await fillNormalLogin(page, advice, log);
    return { ok, advice, humanNeeded: false };
  }
  // LLM unavailable/disabled → heuristic fallback
  _log(log, status.enabled
    ? `[auth] LLM unavailable (MINIMAX_API_KEY missing or call failed) → heuristic fallback`
    : `[auth] LLM disabled (--no-LLM / CRAWLER_LLM=0) → heuristic fallback`, true);
  const ok = await fillNormalLogin(page, null, log);
  return { ok, advice: null, humanNeeded: false };
}
