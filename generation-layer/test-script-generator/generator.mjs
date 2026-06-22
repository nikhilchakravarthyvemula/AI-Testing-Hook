// Generate runnable Playwright UI tests from a crawl.
//
// Reads:  output/crawler/routes.json + output/crawler/pages.json
// Writes: output/crawler/tests/
//           playwright.config.mjs
//           helpers/config.mjs       (runtime env defaults captured from the crawl)
//           helpers/login.mjs        (shared login function)
//           auth.spec.mjs            (login positive + auth-gate negative + logout)
//           redirects.spec.mjs       (client/server nav redirects)
//           sections/<name>.spec.mjs (one smoke test per page in that section)
//           forms.spec.mjs           (form-fill+submit tests, all .skip by default)
//           README.md
//
// Generated tests are GENERIC: they read BASE_URL / creds / selectors from
// process.env at runtime, defaulting to values that were active when this
// generator ran. So the same tests can be re-pointed at staging/prod by
// exporting different env vars.
//
// Usage: node scripts/crawler/generator/generator.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');   // generation-layer/test-script-generator/ → repo
const OUT_DIR = path.join(REPO_ROOT, 'output', 'crawler');
const DATA_DIR = path.join(OUT_DIR, 'data');
const TESTS_DIR = path.join(REPO_ROOT, 'tests');   // top-level, not buried under output/
const ROUTES_JSON = path.join(DATA_DIR, 'routes.json');
const PAGES_JSON = path.join(DATA_DIR, 'pages.json');

if (!fs.existsSync(ROUTES_JSON) || !fs.existsSync(PAGES_JSON)) {
  console.error('[generate] missing routes.json or pages.json. Run `npm run all` first.');
  process.exit(1);
}
const routes = JSON.parse(fs.readFileSync(ROUTES_JSON, 'utf8'));
const pagesData = JSON.parse(fs.readFileSync(PAGES_JSON, 'utf8'));
const pagesByUrl = new Map(pagesData.pages.map(p => [p.finalUrl, p]));

// ----- crawl-time defaults baked into config.mjs (override at runtime via env) -----
// We deliberately re-read process.env at generator time so the defaults track
// whatever env the crawl ran with.
const CFG = {
  BASE_URL: process.env.BASE_URL || routes.summary.origins[0] || 'http://localhost:3000',
  // Empty defaults — generated tests use these literal strings, so we
  // do NOT bake in a fake admin account. testo scan sets them from --user / --pass.
  LOGIN_EMAIL: process.env.LOGIN_EMAIL || '',
  LOGIN_PASSWORD: process.env.LOGIN_PASSWORD || '',
  LOGIN_URL_REGEX: process.env.LOGIN_URL_REGEX || '/(login|sign-?in|signin|auth)',
  LOGIN_EMAIL_SELECTOR: process.env.LOGIN_EMAIL_SELECTOR
    || "input[type='email'], input[name='email'], input[name='username'], input[id='username']",
  LOGIN_PASSWORD_SELECTOR: process.env.LOGIN_PASSWORD_SELECTOR
    || "input[type='password'], input[name='password']",
  LOGIN_SUBMIT_SELECTOR: process.env.LOGIN_SUBMIT_SELECTOR || '',
  LOGIN_SUBMIT_TEXT: process.env.LOGIN_SUBMIT_TEXT || 'Sign in',
};

fs.rmSync(TESTS_DIR, { recursive: true, force: true });
fs.mkdirSync(path.join(TESTS_DIR, 'helpers'), { recursive: true });
fs.mkdirSync(path.join(TESTS_DIR, 'sections'), { recursive: true });

// Symlink node_modules from the crawler workspace so tests run out-of-the-box.
// If the user wants to detach tests, they can rm the symlink + npm install.
const CRAWLER_DIR = path.resolve(__dirname, '..');
const symlinkPath = path.join(TESTS_DIR, 'node_modules');
const relTarget = path.relative(TESTS_DIR, path.join(CRAWLER_DIR, 'node_modules'));
try { fs.symlinkSync(relTarget, symlinkPath, 'dir'); } catch (e) {
  console.warn(`[generate] could not symlink node_modules: ${e.message}. Tests may need: cd output/crawler/tests && npm install`);
}

// Standalone package.json so the tests dir can be detached + npm install elsewhere.
fs.writeFileSync(path.join(TESTS_DIR, 'package.json'),
`{
  "name": "crawler-generated-tests",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "scripts": {
    "test": "playwright test --config=playwright.config.mjs"
  },
  "devDependencies": {
    "@playwright/test": "^1.60.0"
  }
}
`);

// ---- helpers/config.mjs ----
fs.writeFileSync(path.join(TESTS_DIR, 'helpers', 'config.mjs'),
`// Runtime config for generated tests. Override any value via env at test time.
// Defaults are baked in from the crawl env so tests work out-of-the-box.
export const cfg = {
  baseUrl:               process.env.BASE_URL                 || ${JSON.stringify(CFG.BASE_URL)},
  loginEmail:            process.env.LOGIN_EMAIL              || ${JSON.stringify(CFG.LOGIN_EMAIL)},
  loginPassword:         process.env.LOGIN_PASSWORD           || ${JSON.stringify(CFG.LOGIN_PASSWORD)},
  loginUrlRegex:    new RegExp(process.env.LOGIN_URL_REGEX    || ${JSON.stringify(CFG.LOGIN_URL_REGEX)}),
  loginEmailSelector:    process.env.LOGIN_EMAIL_SELECTOR     || ${JSON.stringify(CFG.LOGIN_EMAIL_SELECTOR)},
  loginPasswordSelector: process.env.LOGIN_PASSWORD_SELECTOR  || ${JSON.stringify(CFG.LOGIN_PASSWORD_SELECTOR)},
  loginSubmitSelector:   process.env.LOGIN_SUBMIT_SELECTOR    || ${JSON.stringify(CFG.LOGIN_SUBMIT_SELECTOR)},
  loginSubmitText:       process.env.LOGIN_SUBMIT_TEXT        || ${JSON.stringify(CFG.LOGIN_SUBMIT_TEXT)},
};
`);

// ---- helpers/login.mjs ----
fs.writeFileSync(path.join(TESTS_DIR, 'helpers', 'login.mjs'),
`import { cfg } from './config.mjs';

// Drives the login form discovered during the crawl. Idempotent: noop if the
// page has no fillable email/password form (so the same helper works whether
// we're already authenticated, on an OAuth broker redirector, or on a real
// login form).
export async function login(page, { email = cfg.loginEmail, password = cfg.loginPassword } = {}) {
  // Give the login form a moment to render after any pending nav.
  if (cfg.loginUrlRegex.test(page.url())) {
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
  } else {
    await page.waitForURL(cfg.loginUrlRegex, { timeout: 3000 }).catch(() => {});
  }
  const emailLoc = page.locator(cfg.loginEmailSelector).first();
  const pwdLoc   = page.locator(cfg.loginPasswordSelector).first();
  const hasEmail = await emailLoc.isVisible({ timeout: 800 }).catch(() => false);
  const hasPwd   = await pwdLoc.isVisible({ timeout: 800 }).catch(() => false);
  if (!hasEmail || !hasPwd) return; // no login form here
  await emailLoc.fill(email);
  await pwdLoc.fill(password);
  const submit = cfg.loginSubmitSelector
    ? page.locator(cfg.loginSubmitSelector).first()
    : page.locator('button', { hasText: new RegExp(\`^\${cfg.loginSubmitText}$\`, 'i') }).first();
  await submit.click();
  await page.waitForURL(url => !cfg.loginUrlRegex.test(url.toString()), { timeout: 10000 }).catch(() => {});
}

// Track all XHR/fetch responses on a page. Returns the array (mutated as
// requests fire) — read after navigation completes.
export function trackApiCalls(page) {
  const calls = [];
  page.on('response', resp => {
    const req = resp.request();
    const type = req.resourceType();
    if (type !== 'xhr' && type !== 'fetch') return;
    try {
      const u = new URL(resp.url());
      calls.push({ method: req.method(), url: u.origin + u.pathname });
    } catch {}
  });
  return calls;
}

// Capture console errors + page errors with their source URL so tests can
// filter out noise from third-party scripts (analytics, ads, etc.).
export function trackConsoleErrors(page) {
  const errors = [];
  page.on('console', msg => {
    if (msg.type() !== 'error') return;
    const loc = msg.location?.() || {};
    errors.push({ type: 'error', text: msg.text(), url: loc.url || null });
  });
  page.on('pageerror', err => errors.push({ type: 'pageerror', text: err.message, url: null }));
  return errors;
}

// Filter errors to those that look like they come from the app under test.
// Strategy: include if URL is empty (pageerror — no source) OR same origin as
// baseUrl, unless URL matches an entry in IGNORE_PAGEERROR_DOMAINS (regex).
export function appOriginErrors(errors) {
  const appOrigin = new URL(cfg.baseUrl).origin;
  const ignoreList = (process.env.IGNORE_PAGEERROR_DOMAINS || '')
    .split(',').map(s => s.trim()).filter(Boolean).map(s => new RegExp(s));
  return errors.filter(e => {
    if (!e.url) return true;                                          // no source = include
    if (!e.url.startsWith(appOrigin)) return false;                   // third party = skip
    if (ignoreList.some(re => re.test(e.url))) return false;          // user-ignored = skip
    return true;
  });
}

// Smart fill that tries name → id → placeholder → ariaLabel → labelText
// against the field record from pages.json.
export async function fillField(page, field, value) {
  if (field.name) return page.fill(\`[name='\${field.name}']\`, value);
  if (field.id) return page.fill(\`#\${field.id}\`, value);
  if (field.placeholder) return page.getByPlaceholder(field.placeholder).fill(value);
  if (field.ariaLabel) return page.getByLabel(field.ariaLabel).fill(value);
  if (field.labelText) return page.getByLabel(field.labelText).fill(value);
  throw new Error(\`Cannot identify field (type=\${field.type})\`);
}
`);

// ---- playwright.config.mjs ----
fs.writeFileSync(path.join(TESTS_DIR, 'playwright.config.mjs'),
`import { defineConfig, devices } from '@playwright/test';
import { cfg } from './helpers/config.mjs';

export default defineConfig({
  testDir: '.',
  fullyParallel: false,   // login state isn't shared across workers
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { outputFolder: '_report', open: 'never' }]],
  use: {
    baseURL: cfg.baseUrl,
    headless: true,
    viewport: { width: 1280, height: 800 },
    actionTimeout: 10000,
    navigationTimeout: 20000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
`);

// ---- helpers: which pages need login? ----
// Page needs auth if any of its triggered APIs require Bearer OR a session
// cookie. This works for both token-auth and cookie-auth apps.
const bearerEndpoints = new Set(routes.authObservations.endpointsRequiringBearer || []);
const cookieEndpoints = new Set(routes.authObservations.endpointsRequiringCookie || []);
function pageRequiresAuth(page) {
  if (page.section === 'Auth') return false;
  return (page.triggeredApis || []).some(t => bearerEndpoints.has(t) || cookieEndpoints.has(t));
}

// Multi-step login detection: if the crawl visited the login URL more than
// once before reaching the seed (e.g. email then password on two pages), the
// generated single-page login() helper probably won't work as-is. Emit a
// README note so the user knows to customize.
const loginPageVisits = (pagesData.pages || []).filter(p => /login/i.test(p.finalUrl || '')).length;
const multiStepLoginHint = loginPageVisits > 2; // 1 = forward to login, 2 = post-login bounce-back are normal

// ---- auth.spec.mjs ----
const authPages = pagesData.pages.filter(p => p.section === 'Auth');
const authedPages = pagesData.pages.filter(pageRequiresAuth);
const samplePathForAuthGate = authedPages[0]?.finalUrl
  ? new URL(authedPages[0].finalUrl).pathname + (new URL(authedPages[0].finalUrl).search || '')
  : '/';
const postLoginExpectedPath = routes.clientNavRedirects.find(r => /login/.test(r.from) && !/login/.test(r.to))?.to;

fs.writeFileSync(path.join(TESTS_DIR, 'auth.spec.mjs'),
`import { test, expect } from '@playwright/test';
import { cfg } from './helpers/config.mjs';
import { login } from './helpers/login.mjs';

test.describe('Auth', () => {
  test('valid credentials sign in successfully', async ({ page }) => {
    await page.goto('/');
    await login(page);
    // After login we should NOT be on /login anymore.
    expect(cfg.loginUrlRegex.test(page.url())).toBe(false);
${postLoginExpectedPath ? `    // Captured post-login destination from the crawl:
    await expect(page).toHaveURL(new RegExp(${JSON.stringify(postLoginExpectedPath.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&'))}));
` : ''}  });

  test('unauthenticated request to a protected page is redirected to login', async ({ page }) => {
    // Fresh context — no cookies.
    await page.goto(${JSON.stringify(samplePathForAuthGate)});
    await page.waitForURL(cfg.loginUrlRegex, { timeout: 5000 });
    expect(cfg.loginUrlRegex.test(page.url())).toBe(true);
  });
});
`);

// ---- redirects.spec.mjs ----
const redirectFlows = [
  ...routes.serverRedirects.map(r => ({ ...r, kind: 'server' })),
  ...routes.clientNavRedirects.map(r => ({ ...r, kind: 'client' })),
].filter(r => r.from && r.to);

const seenTitles = new Map();
function uniq(t) {
  const n = (seenTitles.get(t) || 0) + 1;
  seenTitles.set(t, n);
  return n === 1 ? t : `${t} (#${n})`;
}
const redirectTests = redirectFlows.map(r => {
  const fromIsLogin = /login/i.test(r.from);
  const fromIsClick = !!r.clickSelector;
  const realFrom = r.from;
  const fromPath = realFrom.startsWith('/') ? realFrom : `/${realFrom}`;
  const toPattern = r.to.startsWith('/') ? r.to : `/${r.to}`;
  const label = fromIsClick ? `${realFrom} +click → ${r.to}` : `${realFrom} → ${r.to}`;
  const title = uniq(`${r.kind} redirect: ${label}`);
  if (fromIsLogin) {
    // Need to actually login to trigger this redirect
    return `  test(${JSON.stringify(title)}, async ({ page }) => {
    await page.goto(${JSON.stringify(fromPath)});
    await login(page);
    await page.waitForURL(${JSON.stringify(new RegExp(toPattern).source)}.includes('login') ? cfg.loginUrlRegex : new RegExp(${JSON.stringify(toPattern.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&'))}), { timeout: 8000 }).catch(() => {});
    expect(page.url()).toContain(${JSON.stringify(toPattern)});
  });`;
  }
  if (fromIsClick) {
    return `  test(${JSON.stringify(title)}, async ({ page }) => {
    await page.goto(${JSON.stringify(fromPath)});
    await login(page);
    await page.locator(${JSON.stringify(r.clickSelector)}).first().click();
    await page.waitForURL(new RegExp(${JSON.stringify(toPattern.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&'))}), { timeout: 8000 });
    expect(page.url()).toContain(${JSON.stringify(toPattern)});
  });`;
  }
  // Plain auth-gate / 3xx redirect
  return `  test(${JSON.stringify(title)}, async ({ page }) => {
    await page.goto(${JSON.stringify(fromPath)});
    await page.waitForURL(new RegExp(${JSON.stringify(toPattern.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&'))}), { timeout: 8000 });
    expect(page.url()).toContain(${JSON.stringify(toPattern)});
  });`;
}).join('\n\n');

fs.writeFileSync(path.join(TESTS_DIR, 'redirects.spec.mjs'),
`import { test, expect } from '@playwright/test';
import { cfg } from './helpers/config.mjs';
import { login } from './helpers/login.mjs';

test.describe('Navigation & redirect flows', () => {
${redirectTests || '  test.skip("no redirects captured", () => {});'}
});
`);

// ---- sections/<name>.spec.mjs ----
const pagesBySection = new Map();
for (const p of pagesData.pages) {
  if (!pagesBySection.has(p.section)) pagesBySection.set(p.section, []);
  pagesBySection.get(p.section).push(p);
}

function sectionFileName(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'other';
}

for (const [section, pages] of pagesBySection.entries()) {
  if (section === 'Auth') continue; // covered by auth.spec.mjs
  const fname = sectionFileName(section);
  const needsLogin = pages.some(pageRequiresAuth);
  const tests = pages.map(p => {
    const u = new URL(p.finalUrl);
    const pathRel = u.pathname + (u.search || '');
    const title = p.title || pathRel;
    // ALL backend APIs the crawler captured for this page — already filtered
    // by analyze.mjs's isApi() heuristic, so no further regex needed here.
    const expectedApis = p.triggeredApis || [];
    return `  test(${JSON.stringify(`${pathRel} loads + triggers expected APIs`)}, async ({ page }) => {
    const apiCalls = trackApiCalls(page);
    const errors = trackConsoleErrors(page);
    await page.goto(${JSON.stringify(pathRel)});
${needsLogin ? `    await login(page);
    if (!page.url().includes(${JSON.stringify(pathRel)})) {
      await page.goto(${JSON.stringify(pathRel)});
    }
` : ''}    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
${title ? `    await expect(page).toHaveTitle(/${title.replace(/[.*+?^${}()|[\\]\\\\\/]/g, '\\\\$&')}/i);\n` : ''}    // Filter pageerrors to same-origin only (ignore third-party scripts).
    const appErrors = appOriginErrors(errors);
    expect(appErrors.filter(e => e.type === 'pageerror'), JSON.stringify(appErrors)).toEqual([]);
${expectedApis.length > 0 ? `    await page.waitForTimeout(1500);
    const expectedApis = ${JSON.stringify(expectedApis)};
    const seenPaths = apiCalls.map(c => \`\${c.method} \${c.url}\`);
    const hits = expectedApis.filter(e => seenPaths.includes(e));
    expect(hits.length, \`no expected backend APIs fired. expected any of: \${expectedApis.join(', ')}. saw: \${seenPaths.join(', ')}\`).toBeGreaterThan(0);
    for (const expected of expectedApis) {
      expect.soft(seenPaths, \`expected (soft): \${expected}\`).toContain(expected);
    }
` : ''}  });`;
  }).join('\n\n');

  fs.writeFileSync(path.join(TESTS_DIR, 'sections', `${fname}.spec.mjs`),
`import { test, expect } from '@playwright/test';
import { cfg } from '../helpers/config.mjs';
import { login, trackApiCalls, trackConsoleErrors, appOriginErrors } from '../helpers/login.mjs';

test.describe('Section: ${section}', () => {
${tests}
});
`);
}

// ---- forms.spec.mjs (all .skip by default — opt-in) ----
function fillValueLiteral(field) {
  switch (field.type) {
    case 'email':    return "'test@example.com'";
    case 'password': return "'TestPassword123!'";
    case 'number':   return "'1'";
    case 'date':     return "new Date().toISOString().slice(0,10)";
    case 'tel':      return "'5551234567'";
    case 'url':      return "'https://example.com'";
    default:         return "'test-value'";
  }
}

const formTests = [];
for (const p of pagesData.pages) {
  for (const form of (p.forms || [])) {
    const u = new URL(p.finalUrl);
    const pathRel = u.pathname + (u.search || '');
    const needsLogin = pageRequiresAuth(p);
    if (form.fields?.some(f => f.type === 'password') && /login/.test(pathRel)) continue;
    // Smart-fill each field via the fillField() helper (tries name→id→placeholder→aria→label).
    const fills = (form.fields || []).filter(f => f.name || f.id || f.placeholder || f.ariaLabel || f.labelText).map(f => {
      const fieldJson = JSON.stringify({
        name: f.name, id: f.id, placeholder: f.placeholder,
        ariaLabel: f.ariaLabel, labelText: f.labelText, type: f.type,
      });
      return `    await fillField(page, ${fieldJson}, ${fillValueLiteral(f)});`;
    }).join('\n');
    formTests.push(`  test.skip(${JSON.stringify(`form on ${pathRel} (action=${form.resolvedAction || form.action || '?'} method=${(form.method || 'get').toUpperCase()})`)}, async ({ page }) => {
    await page.goto(${JSON.stringify(pathRel)});
${needsLogin ? '    await login(page);\n' : ''}${fills || '    // no identifiable fields to fill'}
    await page.locator("button[type='submit']").first().click();
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    // TODO: assert success criteria (URL change, toast text, new row, etc.)
  });`);
  }
}

fs.writeFileSync(path.join(TESTS_DIR, 'forms.spec.mjs'),
`import { test, expect } from '@playwright/test';
import { cfg } from './helpers/config.mjs';
import { login, fillField } from './helpers/login.mjs';

// Form-fill tests are .skip by default — they can mutate state. Remove .skip
// per test once you've confirmed the test is safe to run against your env
// and added success assertions.

test.describe('Forms (opt-in)', () => {
${formTests.join('\n\n') || '  test.skip("no forms captured", () => {});'}
});
`);

// ---- README ----
fs.writeFileSync(path.join(TESTS_DIR, 'README.md'),
`# Generated Playwright tests

Auto-generated from \`output/crawler/routes.json\` + \`output/crawler/pages.json\`
by \`scripts/crawler/generator/generator.mjs\`. Regenerated each time you run
\`npm run all\` from \`scripts/crawler\` — local edits will be overwritten.

## What's here

| File | What it tests |
|---|---|
| \`auth.spec.mjs\` | Login succeeds with seeded creds; unauthenticated request to a protected page is redirected. |
| \`redirects.spec.mjs\` | Every server-side 3xx + client-side router push captured during the crawl. |
| \`sections/<name>.spec.mjs\` | Per-section page tests: loads, no same-origin pageerrors, at least one expected backend API fires + soft warnings on each missing one. |
| \`forms.spec.mjs\` | Form-fill + submit (all \`.skip\` by default — opt in once you've added success assertions). |

## Run

From \`scripts/crawler\`:

\`\`\`bash
npm test
\`\`\`

Or from this directory:

\`\`\`bash
npx playwright test --config playwright.config.mjs
\`\`\`

## Re-target to another environment

All URLs / credentials / selectors read \`process.env\` at runtime. Defaults are
baked in from the crawl env. Override any of:

\`\`\`bash
BASE_URL=https://staging.example.com \\
LOGIN_EMAIL=qa@example.com \\
LOGIN_PASSWORD=... \\
LOGIN_URL_REGEX='/sign-in' \\
LOGIN_EMAIL_SELECTOR="input[type='email']" \\
LOGIN_SUBMIT_TEXT="Log in" \\
IGNORE_PAGEERROR_DOMAINS='analytics\\\\.com,sentry\\\\.io' \\
npx playwright test --config playwright.config.mjs
\`\`\`

${multiStepLoginHint ? `## ⚠️ Multi-step login detected

The crawl visited the login URL **${loginPageVisits}** times, which usually
means the app has a multi-step login (e.g. enter email → click Continue →
enter password → click Sign in). The auto-generated \`helpers/login.mjs\`
assumes a single-page form. **Edit \`helpers/login.mjs\` by hand** to add the
intermediate clicks/fills before tests will pass.

` : ''}## Regenerate

\`\`\`bash
cd scripts/crawler
npm run all
\`\`\`
`);

// ---- summary log ----
const sectionCount = pagesBySection.size;
const totalTests = (formTests.length) + redirectFlows.length + pagesData.pages.filter(p => p.section !== 'Auth').length + 2 /* auth */;
console.log(`[generate] ${sectionCount} section files, ${redirectFlows.length} redirect tests, ${formTests.length} form tests (skip), 2 auth tests`);
console.log(`[generate] wrote ${path.relative(REPO_ROOT, TESTS_DIR)}/`);
console.log(`[generate] run with:  npx playwright test ${path.relative(REPO_ROOT, TESTS_DIR)}`);
