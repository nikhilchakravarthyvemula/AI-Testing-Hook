// ensureFreshAuth — the pipeline-wide auth pre-flight.
//
// Every stage that touches the live app (harvest, execute, generate-with-URL)
// used to assume output/crawler/auth-state.json was still alive; on short-TTL
// targets it usually wasn't, and each stage failed in its own way (harvest
// captured nothing, Playwright specs 401'd, curls fell back to
// unauthenticated). This module is the ONE staleness check + renewal they all
// share: called before a stage runs, it renews the saved session while
// everything is still headless and recoverable, instead of mid-stage.
//
//   node testo/src/crawler/auth/ensure-fresh.mjs        (BASE_URL required)
//   import { ensureFreshAuth } from '.../ensure-fresh.mjs'
//
// Policy:
//   - no auth-state.json → skip (exit 0): unauthenticated targets are legal.
//   - age < renewal threshold → fresh, do nothing. Threshold is
//     ttlSeconds * refreshAtFraction from auth-profile.json when a TTL is
//     declared, else AUTH_MAX_AGE_S (default 1800s).
//   - stale → drive the saved session through the target's silent-refresh
//     flow headlessly; fall back to form/SSO login (creds from env), then to
//     the interactive login-once window (disable with
//     CRAWL_INTERACTIVE_LOGIN=0). The renewed capture is persisted through
//     the same shouldPersist guard as every other save path.
//
// Exit codes (CLI): 0 = fresh/renewed/skipped-no-state, 1 = renewal failed
// (stages may still proceed — they just risk running unauthenticated).
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { attemptSsoLogin, tryPlainFormLogin } from './sso.mjs';
import { loadAuthProfile } from './profile.mjs';
import { shouldPersist, totalMaterial } from '../lib/session-material.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const AUTH_STATE = path.join(REPO_ROOT, 'output', 'crawler', 'auth-state.json');

const LOGIN_URL_RE = /\/(login|signin|sign-in|auth|sso)\b/i;
const LOGIN_EMAIL = process.env.LOGIN_EMAIL || '';
const LOGIN_PASSWORD = process.env.LOGIN_PASSWORD || '';

async function settleAuthed(page, { maxMs = 25_000 } = {}) {
  // Silent SSO (refresh 401 → prompt=none round-trip → callback) takes
  // 10-20s; poll instead of trusting the first URL.
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (!LOGIN_URL_RE.test(page.url())) return true;
    await page.waitForTimeout(500);
  }
  return !LOGIN_URL_RE.test(page.url());
}

function spawnLoginOnce(env) {
  return new Promise((resolve) => {
    const script = path.join(__dirname, '..', 'login-once.mjs');
    const child = spawn(process.execPath, [script], { env, stdio: 'inherit' });
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

export async function ensureFreshAuth({ baseUrl, seedPath = process.env.SEED_PATH || '/', log = console.log } = {}) {
  const say = (m) => log(`[ensure-auth] ${m}`);

  if (!fs.existsSync(AUTH_STATE)) {
    say('no auth-state.json — nothing to keep fresh (unauthenticated target, or run `npm run login` first)');
    return { ok: true, action: 'skipped', reason: 'no-auth-state' };
  }
  if (!baseUrl) {
    say('no BASE_URL — cannot validate the session against the target; skipping');
    return { ok: true, action: 'skipped', reason: 'no-base-url' };
  }

  const profile = loadAuthProfile(REPO_ROOT, { log });
  const ageMs = Date.now() - fs.statSync(AUTH_STATE).mtimeMs;
  const maxAgeMs = profile.ttlSeconds
    ? profile.ttlSeconds * 1000 * profile.refreshAtFraction
    : Number(process.env.AUTH_MAX_AGE_S || 1800) * 1000;
  if (ageMs < maxAgeMs) {
    say(`auth-state is ${Math.round(ageMs / 1000)}s old (< ${Math.round(maxAgeMs / 1000)}s threshold) — fresh enough`);
    return { ok: true, action: 'fresh', reason: null };
  }
  say(`auth-state is ${Math.round(ageMs / 1000)}s old (threshold ${Math.round(maxAgeMs / 1000)}s) — renewing before the stage runs`);

  const target = baseUrl.replace(/\/$/, '') + seedPath;
  const browser = await chromium.launch({ headless: process.env.HEADLESS !== '0' });
  try {
    const ctx = await browser.newContext({
      storageState: AUTH_STATE,
      ...(profile.ignoreHTTPSErrors ? { ignoreHTTPSErrors: true } : {}),
    });
    const page = await ctx.newPage();
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
    let authed = await settleAuthed(page);

    if (!authed && LOGIN_EMAIL && LOGIN_PASSWORD) {
      if (profile.formFirst && await tryPlainFormLogin(page, { email: LOGIN_EMAIL, password: LOGIN_PASSWORD })) {
        authed = await settleAuthed(page, { maxMs: 10_000 });
      }
      if (!authed) {
        const sso = await attemptSsoLogin(page, {
          email: LOGIN_EMAIL, password: LOGIN_PASSWORD,
          isDone: (u) => !LOGIN_URL_RE.test(u), log: console,
        }).catch(() => ({ ok: false }));
        authed = sso.ok || await settleAuthed(page, { maxMs: 5_000 });
      }
    }

    if (authed) {
      const fresh = await ctx.storageState({ indexedDB: true });
      let prior = null;
      try { prior = JSON.parse(fs.readFileSync(AUTH_STATE, 'utf8')); } catch {}
      const verdict = shouldPersist(fresh, prior);
      if (verdict.ok) {
        fs.writeFileSync(AUTH_STATE, JSON.stringify(fresh));
        say(`✓ renewed session → auth-state.json (material=${totalMaterial(fresh)})`);
        return { ok: true, action: 'renewed', reason: null };
      }
      say(`renewal landed authenticated but ${verdict.reason} — keeping the previous state`);
      return { ok: true, action: 'kept', reason: verdict.reason };
    }
  } finally {
    await browser.close().catch(() => {});
  }

  // Headless renewal failed → interactive backup (visible window, human
  // completes SSO/MFA; login-once saves auth-state.json itself).
  if ((process.env.CRAWL_INTERACTIVE_LOGIN ?? '1') !== '0') {
    say('headless renewal failed — opening the interactive login window');
    const code = await spawnLoginOnce({ ...process.env, BASE_URL: baseUrl, SEED_PATH: seedPath });
    if (code === 0) {
      say('✓ interactive login captured a fresh session');
      return { ok: true, action: 'interactive', reason: null };
    }
  }
  say('⚠ could not renew the session — stages will run with the stale state (expect 401s/login bounces)');
  return { ok: false, action: 'failed', reason: 'renewal-failed' };
}

// ── CLI ──────────────────────────────────────────────────────────────────
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const res = await ensureFreshAuth({ baseUrl: process.env.BASE_URL || null });
  process.exit(res.ok ? 0 : 1);
}
