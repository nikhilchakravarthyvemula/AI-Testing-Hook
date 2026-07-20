#!/usr/bin/env node
// ui-test-generator — scenario.json → runnable Playwright UI test + Web Vitals.
//
// Deterministic, zero-LLM, zero-install. Mirrors the house style of
// api-test-generator (read context → emit artifact → run → report) but stays
// in pure Node: it emits a self-contained script that imports the `playwright`
// LIBRARY directly (chromium.launch) — NOT @playwright/test, which isn't
// installed. Chromium binaries already live in ~/Library/Caches/ms-playwright
// (the crawler uses them), so nothing needs installing.
//
// Pipeline:
//   1. read + validate scenario.json
//   2. emit  output/generation/ui-tests/<name>.ui.mjs   (login + steps + vitals)
//   3. node --check it                                   (parse/validation gate)
//   4. run it with `node` (unless --no-run)              (writes run-result.json)
//   5. read run-result.json → write results.json + report.md  (house shape)
//
// Usage:
//   node generation-layer/ui-test-generator/gen.mjs scenario.json
//   node generation-layer/ui-test-generator/gen.mjs scenario.json --no-run
//   node generation-layer/ui-test-generator/gen.mjs scenario.json --url https://staging... --output-dir output/generation/ui-tests
//
// Credentials: never baked into the emitted script. The scenario's
// $LOGIN_EMAIL/$LOGIN_PASSWORD are resolved from the environment (repo .env is
// auto-loaded) and passed to the child process via env, so the artifact on
// disk stays secret-free.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadRepoEnv } from '../../testo/_lib/load-env.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

loadRepoEnv(REPO_ROOT);

// ── argv ─────────────────────────────────────────────────────────────────────

const opts = parseArgs(process.argv.slice(2));
if (opts.help || !opts.scenario) {
  printHelp();
  process.exit(opts.help ? 0 : 2);
}

const scenarioPath = path.resolve(process.cwd(), opts.scenario);
if (!fs.existsSync(scenarioPath)) {
  console.error(`ui-test-generator: scenario not found: ${scenarioPath}`);
  process.exit(2);
}

// ── load + validate scenario ─────────────────────────────────────────────────

let scenario;
try {
  scenario = JSON.parse(fs.readFileSync(scenarioPath, 'utf8'));
} catch (e) {
  console.error(`ui-test-generator: scenario.json is not valid JSON — ${e.message}`);
  process.exit(2);
}

const problems = validateScenario(scenario);
if (problems.length) {
  console.error('ui-test-generator: scenario validation failed:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(2);
}

// ── resolve config (env substitution; secrets kept out of the artifact) ──────

const baseUrl = (opts.url || subst(scenario.baseUrl) || process.env.BASE_URL || '').replace(/\/$/, '');
if (!baseUrl) {
  console.error('ui-test-generator: no baseUrl (set scenario.baseUrl, --url, or BASE_URL).');
  process.exit(2);
}

const email = subst(scenario.auth?.email ?? '');
const password = subst(scenario.auth?.password ?? '');

const outDir = path.resolve(REPO_ROOT, opts.outputDir || 'output/generation/ui-tests');
fs.mkdirSync(outDir, { recursive: true });

// storageState (the repo's SSO pattern): reuse a session saved by
// `npm run login` (context-layer/content-extractor/crawler/login-once.mjs → output/crawler/auth-state.json).
// This is how we authenticate against Google-SSO targets like superalign, which
// can't be driven through a headless username/password form.
const loginUrlRegex = scenario.auth?.loginUrlRegex || '/(login|sign-?in|auth|realms)';
const stateRel = scenario.auth?.storageStatePath || 'output/crawler/auth-state.json';
const statePath = path.resolve(REPO_ROOT, stateRel);
const stateCookies = readStateCookies(statePath);
const hasState = stateCookies > 0;

// type: storageState | login-form | none | auto (auto = storageState if a saved
// session exists, else login-form).
let authType = opts.storageState ? 'storageState' : (scenario.auth?.type || 'auto');
if (authType === 'auto') authType = hasState ? 'storageState' : 'login-form';
if (authType === 'storageState' && !hasState) {
  console.warn(`  ⚠ auth: storageState requested but no saved session at ${stateRel} (${fs.existsSync(statePath) ? '0 cookies' : 'missing'}).`);
  console.warn(`    One-time interactive login required for SSO targets:  (cd context-layer/content-extractor/crawler && npm run login)`);
  console.warn('    Proceeding WITHOUT auth — auth-gated steps will fail.');
  authType = 'none';
}

// Config baked into the emitted script — NO credentials (those go via env).
const config = {
  name: scenario.name,
  baseUrl,
  timeoutMs: scenario.timeoutMs || 30000,
  // Before each screenshot, wait (bounded) for loading indicators to clear so
  // we capture rendered content, not a spinner. Resolves instantly when none.
  screenshotSettleMs: scenario.screenshotSettleMs || 10000,
  loaderSelector: scenario.loaderSelector || '.animate-spin, [aria-busy="true"], [role="progressbar"]',
  storageState: authType === 'storageState' ? statePath : null,
  auth: authType === 'login-form'
    ? {
        type: 'login-form',
        loginUrlRegex,
        emailSelector: scenario.auth.emailSelector,
        passwordSelector: scenario.auth.passwordSelector,
        submitSelector: scenario.auth.submitSelector,
        postLoginUrlContains: scenario.auth.postLoginUrlContains || '',
      }
    : authType === 'storageState'
      ? { type: 'storageState', loginUrlRegex }
      : { type: 'none', loginUrlRegex },
  steps: scenario.steps,
  thresholds: scenario.perf?.webVitals?.thresholds || {},
  outDir,
};

// ── emit the runnable test ───────────────────────────────────────────────────

const specName = `${safeName(scenario.name)}.ui.mjs`;
const specPath = path.join(outDir, specName);
fs.writeFileSync(specPath, emitSpec(config));
fs.chmodSync(specPath, 0o755);

console.log('━━━━━━━━━━ ui-test-generator ━━━━━━━━━━');
console.log(`  scenario    ${scenario.name}`);
console.log(`  baseUrl     ${baseUrl}`);
console.log(`  login       ${authBanner(config.auth.type, email, stateCookies)}`);
console.log(`  steps       ${scenario.steps.length}`);
console.log(`  emitted     ${path.relative(REPO_ROOT, specPath)}`);

// ── validate (parse gate) ────────────────────────────────────────────────────

const check = spawnSync(process.execPath, ['--check', specPath], { encoding: 'utf8' });
if (check.status !== 0) {
  console.error('ui-test-generator: emitted script failed `node --check`:');
  console.error(check.stderr || check.stdout);
  process.exit(1);
}
console.log('  validate    ✓ node --check passed');

if (opts.noRun) {
  console.log('  run         SKIPPED (--no-run)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  process.exit(0);
}

// ── run ──────────────────────────────────────────────────────────────────────

if (config.auth.type === 'login-form' && (!email || !password)) {
  console.warn('  ⚠ login form configured but LOGIN_EMAIL/LOGIN_PASSWORD not set — login will be skipped; auth-gated steps may fail.');
}

console.log('  run         launching chromium…');
const run = spawnSync(process.execPath, [specPath], {
  encoding: 'utf8',
  stdio: 'inherit',
  env: { ...process.env, UI_LOGIN_EMAIL: email, UI_LOGIN_PASSWORD: password },
});

// ── report ───────────────────────────────────────────────────────────────────

const runResultPath = path.join(outDir, 'run-result.json');
if (!fs.existsSync(runResultPath)) {
  console.error('ui-test-generator: test did not produce run-result.json (it likely crashed before writing). See output above.');
  process.exit(1);
}

const runResult = JSON.parse(fs.readFileSync(runResultPath, 'utf8'));
writeReports(outDir, runResult);

const failedSteps = runResult.steps.filter((s) => !s.ok).length;
const vitalsFailed = (runResult.vitals?.checks || []).filter((c) => !c.ok).length;
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`  steps       ${runResult.steps.length - failedSteps}/${runResult.steps.length} passed`);
console.log(`  web-vitals  ${(runResult.vitals?.checks || []).length - vitalsFailed}/${(runResult.vitals?.checks || []).length} within threshold`);
console.log(`  report      ${path.relative(REPO_ROOT, path.join(outDir, 'report.md'))}`);

process.exit(run.status === 0 && failedSteps === 0 ? 0 : 1);

// ── emit ─────────────────────────────────────────────────────────────────────

function emitSpec(cfg) {
  // CONFIG is JSON (selectors/URLs/steps safely serialised). The driver
  // functions below are static — no user strings interpolated into code.
  return `#!/usr/bin/env node
// GENERATED by ui-test-generator from a scenario. Re-runnable standalone:
//   UI_LOGIN_EMAIL=a@b.com UI_LOGIN_PASSWORD=secret node ${specName}
// Uses the 'playwright' library directly (no @playwright/test).

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const CONFIG = ${JSON.stringify(cfg, null, 2)};
const EMAIL = process.env.UI_LOGIN_EMAIL || '';
const PASSWORD = process.env.UI_LOGIN_PASSWORD || '';

// Registered before any page script runs, so LCP/CLS observers see everything.
function installVitals() {
  window.__vitals = { lcp: 0, cls: 0 };
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const t = e.renderTime || e.loadTime || e.startTime || 0;
        if (t > window.__vitals.lcp) window.__vitals.lcp = t;
      }
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch {}
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (!e.hadRecentInput) window.__vitals.cls += e.value;
    }).observe({ type: 'layout-shift', buffered: true });
  } catch {}
}

function readVitals() {
  const nav = performance.getEntriesByType('navigation')[0] || {};
  const paint = performance.getEntriesByType('paint') || [];
  const fcp = (paint.find((p) => p.name === 'first-contentful-paint') || {}).startTime || 0;
  const v = window.__vitals || { lcp: 0, cls: 0 };
  return {
    lcpMs: Math.round(v.lcp || 0),
    clsScore: Math.round((v.cls || 0) * 10000) / 10000,
    fcpMs: Math.round(fcp),
    ttfbMs: Math.round(nav.responseStart || 0),
    loadMs: Math.round(nav.loadEventEnd || nav.duration || 0),
    domContentLoadedMs: Math.round(nav.domContentLoadedEventEnd || 0),
  };
}

function absUrl(u) {
  if (/^https?:\\/\\//.test(u)) return u;
  return CONFIG.baseUrl.replace(/\\/$/, '') + '/' + String(u).replace(/^\\//, '');
}

async function maybeLogin(page, login) {
  if (CONFIG.auth.type === 'none') {
    // Still land on the app so the first step doesn't run on about:blank.
    await page.goto(CONFIG.baseUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.timeoutMs }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    login.skipped = 'no auth configured';
    login.finalUrl = page.url();
    return;
  }
  if (CONFIG.auth.type === 'storageState') {
    // Session was injected into the context; just land on the app and confirm
    // we're not bounced to the IdP.
    await page.goto(CONFIG.baseUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.timeoutMs }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    login.skipped = 'using saved storageState';
    login.finalUrl = page.url();
    login.ok = !new RegExp(CONFIG.auth.loginUrlRegex).test(page.url());
    return;
  }
  await page.goto(CONFIG.baseUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.timeoutMs }).catch(() => {});
  // SPAs redirect to the IdP via client-side JS AFTER domcontentloaded, so a
  // naive immediate check races the redirect and wrongly sees "no login form".
  // Let the network settle and give the login form a chance to appear.
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.locator(CONFIG.auth.emailSelector).first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
  const onLogin = new RegExp(CONFIG.auth.loginUrlRegex).test(page.url());
  const emailVisible = await page.locator(CONFIG.auth.emailSelector).first().isVisible().catch(() => false);
  if (!onLogin && !emailVisible) { login.skipped = 'already authenticated'; return; }
  if (!EMAIL || !PASSWORD) { login.skipped = 'no credentials in env'; return; }
  try {
    await page.locator(CONFIG.auth.emailSelector).first().fill(EMAIL, { timeout: CONFIG.timeoutMs });
    // Some IdPs (Keycloak) show email first, password after a "Next". Try to
    // fill password if present now; otherwise submit and fill on the next view.
    const pwNow = await page.locator(CONFIG.auth.passwordSelector).first().isVisible().catch(() => false);
    if (pwNow) await page.locator(CONFIG.auth.passwordSelector).first().fill(PASSWORD, { timeout: CONFIG.timeoutMs });
    await Promise.all([
      page.waitForNavigation({ timeout: CONFIG.timeoutMs }).catch(() => {}),
      page.locator(CONFIG.auth.submitSelector).first().click({ timeout: CONFIG.timeoutMs }),
    ]);
    if (!pwNow) {
      await page.locator(CONFIG.auth.passwordSelector).first().fill(PASSWORD, { timeout: CONFIG.timeoutMs });
      await Promise.all([
        page.waitForNavigation({ timeout: CONFIG.timeoutMs }).catch(() => {}),
        page.locator(CONFIG.auth.submitSelector).first().click({ timeout: CONFIG.timeoutMs }),
      ]);
    }
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    login.finalUrl = page.url();
    login.ok = CONFIG.auth.postLoginUrlContains
      ? page.url().includes(CONFIG.auth.postLoginUrlContains)
      : !new RegExp(CONFIG.auth.loginUrlRegex).test(page.url());
  } catch (e) {
    login.ok = false;
    login.error = String(e.message || e);
  }
}

async function runStep(page, step) {
  switch (step.action) {
    case 'navigate': {
      try {
        await page.goto(absUrl(step.url), { waitUntil: step.waitFor || 'load', timeout: CONFIG.timeoutMs });
      } catch (e) {
        // Rich SPAs routinely (a) abort a full goto via client-side routing
        // (net::ERR_ABORTED), or (b) never reach the wait state because of
        // persistent websockets/polling (Timeout). Tolerate both AS LONG AS we
        // still land where the step expects; otherwise it's a real failure.
        const msg = String(e.message || e);
        if (!/ERR_ABORTED|Timeout/i.test(msg)) throw e;
        await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
        if (step.expectUrl && !page.url().includes(step.expectUrl)) throw e;
      }
      if (step.expectUrl && !page.url().includes(step.expectUrl))
        throw new Error('expected url to contain ' + step.expectUrl + ', got ' + page.url());
      return;
    }
    case 'click':
      await page.locator(step.selector).first().click({ timeout: CONFIG.timeoutMs });
      if (step.waitFor) await page.waitForLoadState(step.waitFor, { timeout: 8000 }).catch(() => {});
      return;
    case 'fill':
      await page.locator(step.selector).first().fill(step.value ?? '', { timeout: CONFIG.timeoutMs });
      return;
    case 'waitFor':
      if (step.selector) await page.locator(step.selector).first().waitFor({ timeout: CONFIG.timeoutMs });
      else if (step.ms) await page.waitForTimeout(step.ms);
      return;
    case 'assert':
      return runAssert(page, step);
    default:
      throw new Error('unknown action: ' + step.action);
  }
}

async function runAssert(page, step) {
  switch (step.type) {
    case 'urlContains':
      if (!page.url().includes(step.value)) throw new Error('url ' + page.url() + ' missing ' + step.value);
      return;
    case 'titleContains': {
      const t = await page.title();
      if (!t.toLowerCase().includes(String(step.value).toLowerCase())) throw new Error('title "' + t + '" missing ' + step.value);
      return;
    }
    case 'visible':
      if (!(await page.locator(step.selector).first().isVisible())) throw new Error('not visible: ' + step.selector);
      return;
    case 'textContains': {
      const txt = await page.locator(step.selector || 'body').first().innerText().catch(() => '');
      if (!txt.includes(step.value)) throw new Error('text missing: ' + step.value);
      return;
    }
    default:
      throw new Error('unknown assert type: ' + step.type);
  }
}

function checkVitals(vitals) {
  const T = CONFIG.thresholds || {};
  const checks = [];
  const cmp = (key, val, max, unit) => {
    if (max == null) return;
    checks.push({ metric: key, value: val, threshold: max, unit, ok: val <= max });
  };
  cmp('lcpMs', vitals.lcpMs, T.lcpMs, 'ms');
  cmp('fcpMs', vitals.fcpMs, T.fcpMs, 'ms');
  cmp('ttfbMs', vitals.ttfbMs, T.ttfbMs, 'ms');
  cmp('loadMs', vitals.loadMs, T.loadMs, 'ms');
  cmp('clsScore', vitals.clsScore, T.clsScore, '');
  return checks;
}

function classifyNet(type) {
  if (type === 'xhr' || type === 'fetch') return 'api';
  if (type === 'document') return 'document';
  return 'object';
}

// Per-route navigation timing (TTFB / DOMContentLoaded / load) for the current document.
async function routeTiming(page, route) {
  const t = await page.evaluate(() => {
    const n = performance.getEntriesByType('navigation')[0] || {};
    return {
      ttfbMs: Math.round(n.responseStart || 0),
      domContentLoadedMs: Math.round(n.domContentLoadedEventEnd || 0),
      loadMs: Math.round(n.loadEventEnd || 0),
      durationMs: Math.round(n.duration || 0),
    };
  }).catch(() => ({}));
  return { route, url: page.url(), ...t };
}

async function main() {
  const result = {
    name: CONFIG.name,
    baseUrl: CONFIG.baseUrl,
    ranAt: new Date().toISOString(),
    login: { ok: null, skipped: null, finalUrl: null, error: null },
    steps: [],
    vitals: null,
  };
  // Perf data: timing for every UI route, every API call, and every object load.
  const perf = { routes: [], network: [], resources: [] };
  const shotsDir = path.join(CONFIG.outDir, 'screenshots');
  fs.mkdirSync(shotsDir, { recursive: true });

  // Headless Chromium needs no display (works on terminal-only VMs).
  // --no-sandbox is required when running as root (containers / CI) — auto-on.
  const noSandbox = process.env.PW_NO_SANDBOX === '1' || (typeof process.getuid === 'function' && process.getuid() === 0);
  const browser = await chromium.launch({ headless: true, args: noSandbox ? ['--no-sandbox', '--disable-dev-shm-usage'] : [] });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    ...(CONFIG.storageState ? { storageState: CONFIG.storageState } : {}),
  });
  await context.addInitScript(installVitals);
  const page = await context.newPage();

  // Network timing across the WHOLE flow — APIs (xhr/fetch) and objects
  // (images/scripts/styles/fonts). Accumulates across navigations.
  page.on('requestfinished', async (req) => {
    try {
      const resp = await req.response();
      const tm = req.timing();
      const dur = tm && tm.responseEnd >= 0 ? Math.round(tm.responseEnd) : null;
      perf.network.push({
        url: req.url(), method: req.method(), type: req.resourceType(),
        kind: classifyNet(req.resourceType()),
        status: resp ? resp.status() : null, durationMs: dur,
      });
    } catch {}
  });

  const shoot = async (tag) => {
    // Capture rendered content, not a loading state:
    //  1. DOM ready, 2. wait (bounded) for loaders (spinner) to clear — this
    //  resolves the moment content appears and instantly when none exist,
    //  3. a brief network settle, 4. a short paint delay. Bounded throughout so
    //  SPAs with persistent sockets (never network-idle) don't hang.
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    await page.locator(CONFIG.loaderSelector).first().waitFor({ state: 'hidden', timeout: CONFIG.screenshotSettleMs }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 1500 }).catch(() => {});
    await page.waitForTimeout(500);
    const f = path.join(shotsDir, tag + '.png');
    await page.screenshot({ path: f, fullPage: false }).catch(() => {});
    return path.relative(CONFIG.outDir, f);
  };

  try {
    await maybeLogin(page, result.login);
    result.login.screenshot = await shoot('00-after-login');
    perf.routes.push(await routeTiming(page, 'after-login'));

    for (let i = 0; i < CONFIG.steps.length; i++) {
      const step = CONFIG.steps[i];
      const label = step.action + (step.type ? ':' + step.type : '') + (step.url ? ' ' + step.url : step.selector ? ' ' + step.selector : '');
      const t0 = Date.now();
      let ok = true, error = null;
      try { await runStep(page, step); }
      catch (e) { ok = false; error = String(e.message || e); }
      // Screenshot after EVERY step (pass or fail) for the Allure timeline.
      const shot = await shoot(String(i + 1).padStart(2, '0') + '-' + label.replace(/[^a-z0-9]+/gi, '-').slice(0, 40));
      result.steps.push({ index: i, label, ok, ms: Date.now() - t0, error, screenshot: shot });
      if (step.action === 'navigate') perf.routes.push(await routeTiming(page, step.url));
      console.log('  ' + (ok ? '\\u2713' : '\\u2717') + ' step ' + (i + 1) + ': ' + label + (error ? '  — ' + error.split('\\n')[0] : ''));
    }

    await page.waitForTimeout(500);
    const vitals = await page.evaluate(readVitals);
    result.vitals = { ...vitals, checks: checkVitals(vitals) };
    for (const c of result.vitals.checks) {
      console.log('  ' + (c.ok ? '\\u2713' : '\\u2717') + ' vitals ' + c.metric + '=' + c.value + c.unit + ' (\\u2264 ' + c.threshold + c.unit + ')');
    }

    // Object-level resource timing (final document).
    perf.resources = await page.evaluate(() =>
      (performance.getEntriesByType('resource') || []).map((r) => ({
        name: r.name, type: r.initiatorType, durationMs: Math.round(r.duration),
        transferSize: r.transferSize || 0, startMs: Math.round(r.startTime),
      }))
    ).catch(() => []);
  } finally {
    await browser.close();
  }

  fs.writeFileSync(path.join(CONFIG.outDir, 'run-result.json'), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(CONFIG.outDir, 'web-vitals.json'), JSON.stringify(result.vitals, null, 2));
  fs.writeFileSync(path.join(CONFIG.outDir, 'perf-timing.json'), JSON.stringify(perf, null, 2));
  const apis = perf.network.filter((n) => n.kind === 'api').length;
  console.log('  perf: ' + perf.routes.length + ' route(s), ' + apis + ' api call(s), ' + (perf.network.length - apis) + ' object(s) timed');
}

main().catch((e) => {
  console.error('FATAL: ' + (e.stack || e.message || e));
  process.exit(1);
});
`;
}

// ── report (house shape: results.json + report.md) ───────────────────────────

function writeReports(dir, rr) {
  const passed = rr.steps.filter((s) => s.ok).length;
  const total = rr.steps.length;
  const vitalsChecks = rr.vitals?.checks || [];

  const summary = {
    generatedAt: new Date().toISOString(),
    kind: 'ui-tests',
    scenario: rr.name,
    baseUrl: rr.baseUrl,
    login: rr.login,
    stats: {
      total,
      passed,
      failed: total - passed,
      passed_pct: total ? Math.round((1000 * passed) / total) / 10 : 0,
      vitals_total: vitalsChecks.length,
      vitals_within_threshold: vitalsChecks.filter((c) => c.ok).length,
    },
    webVitals: rr.vitals,
    steps: rr.steps,
  };
  fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify(summary, null, 2));

  const L = [];
  L.push('# UI Test Run Report');
  L.push('');
  L.push(`_generated ${summary.generatedAt}_`);
  L.push('');
  L.push(`- scenario: **${rr.name}**`);
  L.push(`- target:   \`${rr.baseUrl}\``);
  L.push('');
  L.push('## Login');
  if (rr.login.skipped) L.push(`- skipped: ${rr.login.skipped}`);
  else {
    L.push(`- ok: **${rr.login.ok}**`);
    if (rr.login.finalUrl) L.push(`- landed: \`${rr.login.finalUrl}\``);
    if (rr.login.error) L.push(`- error: \`${rr.login.error}\``);
  }
  L.push('');
  L.push('## Steps');
  L.push(`- passed: **${passed}/${total}**`);
  L.push('');
  for (const s of rr.steps) {
    const mark = s.ok ? '✓' : '✗';
    L.push(`- ${mark} \`${s.label}\`  ${s.ms}ms${s.error ? '  — ' + s.error.split('\n')[0] : ''}`);
  }
  L.push('');
  L.push('## Web Vitals');
  if (!vitalsChecks.length) {
    L.push('- (no thresholds configured)');
  } else {
    L.push('| metric | value | threshold | result |');
    L.push('|---|---|---|---|');
    for (const c of vitalsChecks) {
      L.push(`| ${c.metric} | ${c.value}${c.unit} | ≤ ${c.threshold}${c.unit} | ${c.ok ? '✓' : '✗ over'} |`);
    }
  }
  if (rr.vitals) {
    L.push('');
    L.push(`_raw: LCP ${rr.vitals.lcpMs}ms · FCP ${rr.vitals.fcpMs}ms · TTFB ${rr.vitals.ttfbMs}ms · load ${rr.vitals.loadMs}ms · CLS ${rr.vitals.clsScore}_`);
  }
  L.push('');
  fs.writeFileSync(path.join(dir, 'report.md'), L.join('\n') + '\n');
}

// ── helpers ──────────────────────────────────────────────────────────────────

function subst(v) {
  if (typeof v !== 'string') return v;
  return v.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (_, k) => process.env[k] ?? '');
}

function readStateCookies(p) {
  try {
    const s = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(s.cookies) ? s.cookies.length : 0;
  } catch { return 0; }
}

function authBanner(type, email, cookies) {
  if (type === 'storageState') return `storageState (${cookies} cookies from saved session)`;
  if (type === 'login-form') return email ? '✓ form creds set' : 'form (NO creds — will skip)';
  return 'none';
}

function safeName(s) {
  return String(s || 'scenario').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'scenario';
}

function validateScenario(s) {
  const out = [];
  if (!s || typeof s !== 'object') return ['scenario is not an object'];
  if (!s.name) out.push('missing "name"');
  if (!s.baseUrl && !process.env.BASE_URL) out.push('missing "baseUrl" (and no BASE_URL env)');
  if (!Array.isArray(s.steps) || !s.steps.length) out.push('"steps" must be a non-empty array');
  const ACTIONS = new Set(['navigate', 'click', 'fill', 'assert', 'waitFor']);
  const ASSERTS = new Set(['urlContains', 'titleContains', 'visible', 'textContains']);
  (s.steps || []).forEach((st, i) => {
    if (!ACTIONS.has(st.action)) out.push(`step[${i}]: unknown action "${st.action}"`);
    if (st.action === 'assert' && !ASSERTS.has(st.type)) out.push(`step[${i}]: unknown assert type "${st.type}"`);
    if ((st.action === 'click' || st.action === 'fill') && !st.selector) out.push(`step[${i}]: ${st.action} needs "selector"`);
    if (st.action === 'navigate' && !st.url) out.push(`step[${i}]: navigate needs "url"`);
  });
  return out;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '-h':
      case '--help': out.help = true; break;
      case '--no-run': out.noRun = true; break;
      case '--storage-state': out.storageState = true; break;
      case '--url': out.url = next(); break;
      case '--output-dir':
      case '--output': out.outputDir = next(); break;
      default:
        if (a.startsWith('-')) { console.error(`ui-test-generator: unknown option "${a}"`); process.exit(2); }
        else if (!out.scenario) out.scenario = a;
        else { console.error(`ui-test-generator: unexpected arg "${a}"`); process.exit(2); }
    }
  }
  return out;
}

function printHelp() {
  console.log(`ui-test-generator — scenario.json → Playwright UI test + Web Vitals

Usage:
  node generation-layer/ui-test-generator/gen.mjs <scenario.json> [options]

Options:
  --no-run            generate + validate (node --check) only; don't launch the browser
  --url <URL>         override scenario.baseUrl
  --output-dir <DIR>  default: output/generation/ui-tests
  -h, --help          this help

Credentials come from the environment (repo .env auto-loaded): the scenario's
$LOGIN_EMAIL / $LOGIN_PASSWORD are resolved at run time and never written to disk.
`);
}
