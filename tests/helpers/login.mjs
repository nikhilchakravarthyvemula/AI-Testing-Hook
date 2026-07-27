// Shared auth + form helpers for the generated e2e specs.
//
// login(page): normally a NO-OP — playwright.config.mjs pre-seeds every
// context with output/crawler/auth-state.json (incl. IndexedDB, so Firebase
// sessions restore too). If the app still bounces to /login (expired
// session), we retry with the crawler's deterministic SSO driver; it stops
// cleanly at MFA/popup instead of hanging.
import { attemptSsoLogin } from '../../testo/src/crawler/auth/sso.mjs';

const LOGIN_URL_RE = /\/(login|signin|sign-in|auth)\b/i;
const LOGIN_EMAIL = process.env.LOGIN_EMAIL || '';
const LOGIN_PASSWORD = process.env.LOGIN_PASSWORD || '';

export async function login(page) {
  await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
  if (!LOGIN_URL_RE.test(page.url())) return true;   // session held — nothing to do

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
