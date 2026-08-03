// Shared auth + form helpers for the generated e2e specs.
//
// login(page): normally a NO-OP — playwright.config.mjs pre-seeds every
// context with output/crawler/auth-state.json (incl. IndexedDB, so Firebase
// sessions restore too). If the app still bounces to /login (expired
// session), we retry with the crawler's deterministic SSO driver; it stops
// cleanly at MFA/popup instead of hanging.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attemptSsoLogin, tryPlainFormLogin } from '../../testo/src/crawler/auth/sso.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_STATE = path.resolve(__dirname, '..', '..', 'output', 'crawler', 'auth-state.json');

const LOGIN_URL_RE = /\/(login|signin|sign-in|auth)\b/i;
const LOGIN_EMAIL = process.env.LOGIN_EMAIL || '';
const LOGIN_PASSWORD = process.env.LOGIN_PASSWORD || '';

export async function login(page) {
  await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
  if (!LOGIN_URL_RE.test(page.url())) return true;   // session held — nothing to do

  if (await tryPlainFormLogin(page, { email: LOGIN_EMAIL, password: LOGIN_PASSWORD })) {
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
    if (!LOGIN_URL_RE.test(page.url())) return true;
  }

  const isDone = (u) => !LOGIN_URL_RE.test(u);
  const sso = await attemptSsoLogin(page, {
    email: LOGIN_EMAIL, password: LOGIN_PASSWORD, isDone, log: console,
  });
  if (sso.ok) return true;
  throw new Error(
    `login helper: still on ${page.url()} (sso: ${sso.reason}). ` +
    `Saved session likely expired — re-run: node testo/src/crawler/login-once.mjs`,
  );
}

// Non-throwing session guard for the flow specs. The pre-seeded storageState
// normally authenticates, but SSO/OIDC apps re-check on a cold context load and
// can bounce to /login (their session refresh is single-use). Recover this
// context in place, then re-navigate the route the flow intended. This is safe
// to call unconditionally at the top of a flow; it's a no-op when the session
// held. Serialized by playwright.config's workers:1 — no parallel refresh race.
// Returns true when we end up on an app (non-login) page.
export async function ensureAuthed(page, intendedPath) {
  await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
  if (!LOGIN_URL_RE.test(page.url())) return true;

  const formFilled = await tryPlainFormLogin(page, { email: LOGIN_EMAIL, password: LOGIN_PASSWORD }).catch(() => false);
  if (!formFilled) {
    const isDone = (u) => !LOGIN_URL_RE.test(u);
    await attemptSsoLogin(page, {
      email: LOGIN_EMAIL, password: LOGIN_PASSWORD, isDone, log: console,
    }).catch(() => {});
  }
  await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});

  const recovered = !LOGIN_URL_RE.test(page.url());
  if (recovered) {
    // Propagate the freshly-rotated session to the shared storageState so the
    // NEXT serialized spec starts authenticated instead of bouncing + re-doing
    // this ~20s SSO round-trip (the crawler's warm-up-and-propagate pattern).
    // Safe because playwright.config runs workers:1 — no concurrent writer.
    await page.context().storageState({ path: AUTH_STATE, indexedDB: true }).catch(() => {});
  }

  // attemptSsoLogin lands on the app's default page; return to the flow's start.
  if (intendedPath && recovered) {
    await page.goto(intendedPath).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
  }
  return !LOGIN_URL_RE.test(page.url());
}

// Locate a field by the metadata the crawler captured (name/id/placeholder/
// aria-label/label text, in that priority) and fill it.
export async function fillField(page, f, value) {
  const candidates = [
    f.name && `[name=${JSON.stringify(f.name)}]`,
    f.id && `#${cssEscape(f.id)}`,
    f.placeholder && `[placeholder=${JSON.stringify(f.placeholder)}]`,
    f.ariaLabel && `[aria-label=${JSON.stringify(f.ariaLabel)}]`,
  ].filter(Boolean);

  for (const sel of candidates) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible({ timeout: 300 }).catch(() => false)) {
      await loc.fill(String(value));
      return true;
    }
  }
  if (f.labelText) {
    const loc = page.getByLabel(f.labelText, { exact: false }).first();
    if (await loc.isVisible({ timeout: 300 }).catch(() => false)) {
      await loc.fill(String(value));
      return true;
    }
  }
  return false;   // field not found — the spec's own assertions surface this
}

// Minimal CSS.escape for id selectors (Node has no global CSS object).
function cssEscape(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}
