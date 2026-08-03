// Deterministic (no-LLM) "sign in with provider" automation.
//
// Covers the gap between plain username/password forms (handled directly by
// the caller) and full enterprise SSO+MFA (which still needs a human). Two
// jobs, both pattern-matching only — no live LLM call:
//
//   1. findSsoButton()   — detect + click a provider button on the APP's own
//                           login page ("Sign in with Google", "Continue with
//                           Microsoft", "Sign in with SSO", …). Before this
//                           module existed, headless recovery gave up the
//                           instant no email/password <input> was visible,
//                           and the interactive fallback (login-once.mjs)
//                           required a HUMAN to find and click this button
//                           themselves before its own automation could help.
//
//   2. attemptSsoLogin() — after the click, drive the resulting IdP's native
//                          login form (email step → password step) using
//                          per-provider selectors, until either the app is
//                          reached, an MFA/CAPTCHA challenge is detected, or
//                          the flow can't be driven further. MFA is a hard
//                          stop by design — that step always needs a human
//                          (or a trusted-device session, handled elsewhere).
//
// Shared by crawl.mjs (headless recovery/re-auth) and login-once.mjs
// (interactive bootstrap) so "click the SSO button" and "fill the IdP's
// form" exist in exactly one place.

// ── external IdP hosts — used both to know when a redirect chain is still
// mid-flight (not done yet) and, together with KNOWN_IDPS below, to pick the
// right selectors once we land there. Extend this list as new IdPs show up.
export const EXTERNAL_IDP_RE =
  /accounts\.google\.com|login\.microsoftonline\.com|login\.live\.com|aadcdn\.msftauth\.net|github\.com\/(login|sessions)|gitlab\.com\/users\/sign_in|\.okta\.com|\.oktapreview\.com|onelogin\.com|auth0\.com|pingone\.com|pingidentity\.com|duosecurity\.com/i;

// ── provider buttons on the app's OWN login page ───────────────────────────
const SSO_BUTTON_TEXT_RE =
  /\b(sign in|log ?in|continue|authenticate)\b.{0,12}\bwith\b|^\s*(sso|single sign[- ]?on)\s*$/i;

const PROVIDER_HINTS = [
  { provider: 'google', re: /google/i },
  { provider: 'microsoft', re: /microsoft|azure|office\s*365|entra/i },
  { provider: 'github', re: /github/i },
  { provider: 'gitlab', re: /gitlab/i },
  { provider: 'okta', re: /okta/i },
  { provider: 'generic-sso', re: /\bsso\b|single sign/i },
];

// Finds the first visible clickable whose text reads like a provider login
// button. Returns null if none found (plain form, or truly nothing to do).
export async function findSsoButton(page) {
  const candidates = page.locator('button, a[role=button], a');
  const count = await candidates.count().catch(() => 0);
  for (let i = 0; i < Math.min(count, 40); i++) {
    const el = candidates.nth(i);
    const text = ((await el.textContent().catch(() => '')) || '').trim();
    if (!text || text.length > 80 || !SSO_BUTTON_TEXT_RE.test(text)) continue;
    if (!(await el.isVisible().catch(() => false))) continue;
    const hint = PROVIDER_HINTS.find((h) => h.re.test(text));
    return { locator: el, text, provider: hint?.provider || 'unknown' };
  }
  return null;
}

// ── known-IdP native login selectors ────────────────────────────────────────
// email/password/submit tried in order; mfaRe matches a URL path fragment
// that means "this step needs a human" (TOTP, push approval, "verify it's
// you", KMSI, etc.) — driveIdpStep stops immediately when it sees this
// rather than clicking blindly into a challenge it can't solve.
const KNOWN_IDPS = [
  {
    name: 'google',
    hostRe: /(^|\.)accounts\.google\.com$/,
    email: ["input#identifierId", "input[name='identifier']", "input[type='email']"],
    password: ["input[name='Passwd']", "input[type='password']"],
    submit: ["#identifierNext button", "#passwordNext button", "button:has-text('Next')"],
    mfaRe: /challenge\/(totp|ipp|az|dp|selection|iap)|signin\/v2\/challenge/i,
  },
  {
    name: 'microsoft',
    hostRe: /(^|\.)login\.microsoftonline\.com$|(^|\.)login\.live\.com$/,
    email: ["input[name='loginfmt']", "input[type='email']"],
    password: ["input[name='passwd']", "input[type='password']"],
    submit: ["input[type='submit']", "button:has-text('Next')", "button:has-text('Sign in')"],
    mfaRe: /\/(kmsi|proofup|sas)\b/i,
  },
  {
    name: 'github',
    hostRe: /(^|\.)github\.com$/,
    email: ["input#login_field"],
    password: ["input#password"],
    submit: ["input[type='submit'][value='Sign in']", "button:has-text('Sign in')"],
    mfaRe: /\/sessions\/two-factor/i,
  },
  {
    name: 'okta',
    hostRe: /\.okta(preview)?\.com$/,
    email: ["input#okta-signin-username", "input[name='identifier']"],
    password: ["input#okta-signin-password", "input[name='credentials.passcode']"],
    submit: ["#okta-signin-submit", "button[type='submit']"],
    mfaRe: /\/signin\/verify/i,
  },
];

// Generic fallback selectors — tried when the current host doesn't match any
// KNOWN_IDPS entry (unlisted IdP, or the app's own domain doing an
// identity-first redirect before bouncing to the real IdP).
const GENERIC_IDP = {
  name: 'generic',
  email: ["input[type='email']", "input[name='email']", "input[name='username']"],
  password: ["input[type='password']"],
  submit: ["button[type='submit']", "input[type='submit']", "button:has-text('Sign in')", "button:has-text('Continue')", "button:has-text('Next')"],
  mfaRe: null,
};

function matchKnownIdp(url) {
  let host;
  try { host = new URL(url).hostname; } catch { return null; }
  return KNOWN_IDPS.find((idp) => idp.hostRe.test(host)) || null;
}

async function firstVisible(page, selectors) {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible({ timeout: 150 }).catch(() => false)) return loc;
  }
  return null;
}

async function typeInto(loc, value) {
  await loc.click({ timeout: 3_000 }).catch(() => {});
  await loc.fill('', { timeout: 3_000 }).catch(() => {});
  await loc.pressSequentially(value, { delay: 12, timeout: 6_000 }).catch(() => loc.fill(value).catch(() => {}));
}

// One step of a known/generic-IdP flow: fill whatever's visible, click
// submit. Returns 'filled' | 'clicked-only' | 'nothing' | 'mfa-detected'.
async function driveIdpStep(page, idp, creds) {
  if (idp.mfaRe && idp.mfaRe.test(page.url())) return 'mfa-detected';

  const emailLoc = await firstVisible(page, idp.email);
  const pwdLoc = await firstVisible(page, idp.password);
  if (!emailLoc && !pwdLoc) return 'nothing';

  let filled = false;
  if (emailLoc && creds.email) {
    const cur = await emailLoc.inputValue().catch(() => '');
    if (!cur) { await typeInto(emailLoc, creds.email); filled = true; }
  }
  if (pwdLoc && creds.password) {
    await typeInto(pwdLoc, creds.password);
    filled = true;
  }

  const submit = await firstVisible(page, idp.submit);
  if (submit) {
    await submit.click({ timeout: 5_000 }).catch(() => {});
    return filled ? 'filled' : 'clicked-only';
  }
  return filled ? 'filled' : 'nothing';
}

// Plain email/password form on the app's OWN login page. Some apps (forge)
// render both a fillable form AND a "Sign in with <provider>" button on the
// same page; callers should try this FIRST — attemptSsoLogin() below always
// prefers the button, and for popup-based OAuth (signInWithPopup) that stalls
// headless (COOP severs the popup→opener channel). Filling the plain form
// sidesteps the popup entirely when it's available.
export async function tryPlainFormLogin(page, { email, password } = {}) {
  if (!email || !password) return false;
  const emailLoc = page.locator("input[type='email'], input[name='email'], input[name='username']").first();
  const pwdLoc = page.locator("input[type='password']").first();
  // isVisible() alone doesn't poll — the form may still be rendering (async
  // JS) when the caller lands here. Wait for either field first, the same
  // way crawl.mjs's maybeLogin() does, before the immediate isVisible check.
  await Promise.race([
    emailLoc.waitFor({ state: 'visible', timeout: 4_000 }).catch(() => {}),
    pwdLoc.waitFor({ state: 'visible', timeout: 4_000 }).catch(() => {}),
  ]);
  const hasEmail = await emailLoc.isVisible().catch(() => false);
  const hasPwd = await pwdLoc.isVisible().catch(() => false);
  if (!hasEmail || !hasPwd) return false;

  await emailLoc.click({ timeout: 5_000 }).catch(() => {});
  await emailLoc.fill('', { timeout: 5_000 }).catch(() => {});
  await emailLoc.pressSequentially(email, { delay: 15, timeout: 8_000 }).catch(() => {});
  await pwdLoc.click({ timeout: 5_000 }).catch(() => {});
  await pwdLoc.fill('', { timeout: 5_000 }).catch(() => {});
  await pwdLoc.pressSequentially(password, { delay: 15, timeout: 8_000 }).catch(() => {});

  const submit = page.locator("button[type='submit'], input[type='submit']", { hasText: /sign in|log ?in/i }).first();
  const navPromise = page.waitForNavigation({ timeout: 8_000, waitUntil: 'domcontentloaded' }).catch(() => null);
  await submit.click({ timeout: 5_000 }).catch(() => {});
  await navPromise;
  return true;
}

/**
 * Click the app's "Sign in with <provider>" button (if any) and drive the
 * resulting IdP flow deterministically until `isDone(url)` is true, an MFA/
 * challenge step is detected, or the flow can't be advanced further.
 *
 * @param {import('playwright').Page} page
 * @param {Object} opts
 * @param {string} opts.email
 * @param {string} opts.password
 * @param {(url: string) => boolean} opts.isDone   true once back on the app
 * @param {number} [opts.maxSteps=8]
 * @param {Object} [opts.log=console]
 * @returns {Promise<{ok:true, landedUrl:string} | {ok:false, reason:string}>}
 */
export async function attemptSsoLogin(page, { email, password, isDone, maxSteps = 8, log = console } = {}) {
  const say = (m) => (log.info ?? log.log ?? console.log).call(log, m);
  const ctx = page.context();

  // Popup-based OAuth (signInWithPopup et al) isn't driven here yet — flag
  // it clearly instead of silently timing out, so it's obvious why auto-login
  // stalled (falls through to the interactive fallback, where a human can
  // complete the popup by hand).
  let popup = null;
  const onPopup = (p) => { popup = p; };
  ctx.on('page', onPopup);

  const button = await findSsoButton(page);
  if (button) {
    say(`[sso] clicking "${button.text}" (provider=${button.provider})`);
    const navPromise = page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {});
    await button.locator.click({ timeout: 5_000 }).catch(() => {});
    await navPromise;
    await page.waitForTimeout(500);
  }

  if (popup) {
    ctx.off('page', onPopup);
    say(`[sso] provider opened a popup window (${popup.url()}) — popup-driven OAuth isn't automated yet; complete it by hand.`);
    return { ok: false, reason: 'popup-unsupported' };
  }

  if (!button) {
    ctx.off('page', onPopup);
    return { ok: false, reason: 'no-button' };
  }

  for (let i = 0; i < maxSteps; i++) {
    await page.waitForLoadState('networkidle', { timeout: 6_000 }).catch(() => {});
    if (isDone(page.url())) { ctx.off('page', onPopup); return { ok: true, landedUrl: page.url() }; }

    const idp = matchKnownIdp(page.url()) || GENERIC_IDP;
    const result = await driveIdpStep(page, idp, { email, password });
    say(`[sso] step ${i + 1} at ${page.url().slice(0, 90)} (${idp.name}) → ${result}`);

    if (result === 'mfa-detected') { ctx.off('page', onPopup); return { ok: false, reason: 'mfa-detected' }; }
    if (result === 'nothing') { ctx.off('page', onPopup); return { ok: false, reason: 'exhausted' }; }

    await page.waitForTimeout(1_200);
    await page.waitForLoadState('networkidle', { timeout: 6_000 }).catch(() => {});
    if (isDone(page.url())) { ctx.off('page', onPopup); return { ok: true, landedUrl: page.url() }; }
    if (popup) { ctx.off('page', onPopup); say(`[sso] provider opened a popup mid-flow (${popup.url()}) — complete it by hand.`); return { ok: false, reason: 'popup-unsupported' }; }
  }
  ctx.off('page', onPopup);
  return { ok: false, reason: 'exhausted' };
}
