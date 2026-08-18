// config.mjs — .env loading + the crawler knob registry.
//
// Two problems this solves (both bit us on real scans):
//   1. ctx.mjs never loaded .env, so credentials and knobs sat unread on disk
//      unless the operator remembered `set -a; source .env`. Now ctx loads it
//      itself; anything already exported in the environment still wins.
//   2. The crawler has ~60 env knobs spread across pass 1 (crawl.mjs/walker),
//      pass 2 (deep-crawl.mjs) and the auth helpers, with near-miss names
//      (DEEP_BUDGET_MS vs CRAWL_BUDGET_MS). Setting a knob the running pass
//      doesn't read fails silently. The registry below is the single list of
//      what exists, where it applies, and its default — so a scan can print
//      the effective config and warn about set-but-ignored or unknown knobs.

import fs from 'node:fs';
import path from 'node:path';

// ── .env loader ──────────────────────────────────────────────────────────────
// Minimal on purpose (no dotenv dependency — the POC depends only on node).
// Supports comments, blank lines, an optional `export ` prefix and single/
// double-quoted values. Keys already present in process.env are NOT overridden.
export function loadDotEnv(repoRoot) {
  const file = path.join(repoRoot, '.env');
  if (!fs.existsSync(file)) return null;
  const applied = [];
  const overridden = [];
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, key, rawVal] = m;
    let val = rawVal.trim();
    const q = val[0];
    if ((q === '"' || q === "'") && val.endsWith(q) && val.length >= 2) val = val.slice(1, -1);
    if (key in process.env) { overridden.push(key); continue; }  // exported env wins
    process.env[key] = val;
    applied.push(key);
  }
  return { file, applied, overridden };
}

// ── knob registry ────────────────────────────────────────────────────────────
// scope: where the knob is read.
//   pass1     crawl.mjs + walker (the main interactive crawl)
//   pass2     deep-crawl.mjs only (mapped onto pass-1 names for the child run)
//   auth      login/sso/harvest helpers
//   extractor content-extractor orchestration
//   gen       test generators (read crawl output, not the live app)
// secret: value is never printed — only set/unset.
export const KNOBS = {
  // targets & seeds
  BASE_URL:            { scope: 'pass1', def: 'http://localhost:3000', desc: 'target origin (ctx scan --url sets this)' },
  SEED_PATH:           { scope: 'pass1', def: '/', desc: 'entry route' },
  SEED_PATHS:          { scope: 'pass1', def: '(SEED_PATH)', desc: 'comma-separated entry routes; overrides SEED_PATH' },
  TARGET_CODEBASE:     { scope: 'extractor', def: '(unset)', desc: 'absolute path of the source repo for code extractors/graphify' },

  // pass-1 walker shape
  CRAWL_WORKERS:       { scope: 'pass1', def: '1', desc: 'parallel browser contexts; >1 is unsafe on rotating-token SSO apps until refresh-broadcast lands' },
  CRAWL_BUDGET_MS:     { scope: 'pass1', def: '1800000', desc: 'pass-1 wall-clock failsafe; 0 = unbounded (crawl until the frontier drains; bounded by MAX_INTERACT_PAGES + list caps)' },
  MAX_INTERACT_PAGES:  { scope: 'pass1', def: '200', desc: 'pass-1 page cap' },
  MAX_INTERACT_DEPTH:  { scope: 'pass1', def: '5', desc: 'pass-1 DFS depth cap' },
  CRAWL_PREDISCOVERY:  { scope: 'pass1', def: '1', desc: 'pre-populate the queue from the seeds before fan-out' },
  WORKER_STAGGER_MS:   { scope: 'pass1', def: '2500', desc: 'delay between worker context bring-ups (0 is honored)' },
  CRAWL_CHECKPOINT_MS: { scope: 'pass1', def: '30000', desc: 'click-graph checkpoint interval' },
  CRAWL_TABLE_WAIT_MS: { scope: 'pass1', def: '30000', desc: 'max wait for async table/grid rows to populate' },
  MAX_LIST_ITEMS_PER_NAV: { scope: 'pass1', def: '(unbounded)', desc: 'fixed per-page cap on same-template list links (novelty sampling usually makes this unnecessary)' },
  NOVELTY_DRY_LIMIT:   { scope: 'pass1', def: '2', desc: 'saturate a route template after N consecutive no-novelty samples; 0 = visit every instance' },
  MAX_SAMPLES_PER_TEMPLATE: { scope: 'pass1', def: '10', desc: 'hard per-template sample ceiling regardless of novelty (0 = unbounded) — bounds undetected-volatility blast radius' },
  CRAWL_DISABLED:      { scope: 'pass1', def: '0', desc: 'skip the live crawl entirely' },
  CRAWL_SKIP_ROUTES:   { scope: 'pass1', def: '(none)', desc: 'regex of routes to exclude (e.g. renderer-killing pages); recorded as route-skipped' },
  SKIP_CRAWL:          { scope: 'extractor', def: '0', desc: 'reuse prior crawler output instead of re-crawling' },
  POST_CRAWL_URLS:     { scope: 'pass1', def: '(none)', desc: 'extra URLs visited after the walk' },
  POST_NAV_WAIT_MS:    { scope: 'pass1', def: '500', desc: 'settle wait after navigation' },
  URL_STABLE_IDLE_MS:  { scope: 'pass1', def: '1500', desc: 'URL must be stable this long to count as settled' },
  URL_STABLE_MAX_MS:   { scope: 'pass1', def: '5000', desc: 'max wait for URL stability' },
  CAPTURE_SCREENSHOTS: { scope: 'pass1', def: '1', desc: 'save per-page screenshots' },
  CAPTURE_DOM:         { scope: 'pass1', def: '1', desc: 'save per-page DOM snapshots' },
  CRAWL_DIAG_SCREENSHOTS: { scope: 'pass1', def: '0', desc: 'extra diagnostic screenshots in the walker' },
  IGNORE_PAGEERROR_DOMAINS: { scope: 'gen', def: '(none)', desc: 'suppress pageerror noise from these domains' },
  CRAWLER_OUT_DIR_NAME:{ scope: 'pass1', def: 'crawler', desc: 'output subdir name' },
  SECTION_RULES:       { scope: 'pass1', def: '{}', desc: 'JSON url→section labeling rules for analyze' },
  MINDMAP_ROOT:        { scope: 'pass1', def: '(auto)', desc: 'root node label for the mindmap' },
  SYNTH_MAX_PER_TEMPLATE: { scope: 'pass1', def: '50', desc: 'cap synthesized URLs per route template' },

  // click safety
  SAFE_CLICK_REGEX:    { scope: 'pass1', def: '.+', desc: 'allow-list for clickable text' },
  SAFE_CLICK_MAX_PER_PAGE: { scope: 'pass1', def: '(unbounded)', desc: 'cap clicks per page' },
  NEVER_CLICK_REGEX:   { scope: 'pass1', def: '(built-in session-breaker set)', desc: 'never-click deny-list (logout, delete-account, …)' },
  DESTRUCTIVE_CLICK_REGEX: { scope: 'pass1', def: '(built-in)', desc: 'destructive-keyword pre-flag' },
  INTERCEPT_MODE:      { scope: 'pass1', def: 'abort', desc: 'how to handle intercepted write requests' },
  INTERCEPT_BLOCK_POST:{ scope: 'pass1', def: 'writes', desc: 'which POSTs the interceptor blocks' },

  // pass-2 (deep-crawl.mjs child run ONLY — the pass-1 walker never reads these)
  DEEP_BUDGET_MS:      { scope: 'pass2', def: '300000', desc: 'pass-2 wall-clock budget (maps to CRAWL_BUDGET_MS of the child)' },
  DEEP_MAX_PAGES:      { scope: 'pass2', def: '60', desc: 'pass-2 page cap (maps to MAX_INTERACT_PAGES)' },
  DEEP_WORKERS:        { scope: 'pass2', def: '1', desc: 'pass-2 workers (keep 1 — auth-state rotation)' },
  DEEP_MAX_CLICKS:     { scope: 'pass2', def: '5', desc: 'pass-2 per-page click cap' },
  DEEP_TABLE_WAIT_MS:  { scope: 'pass2', def: '10000', desc: 'pass-2 table settle wait' },
  DEEP_OUT_DIR_NAME:   { scope: 'pass2', def: 'crawler-deep', desc: 'pass-2 scratch dir' },
  SKIP_PASS1:          { scope: 'pass2', def: '0', desc: 'deep-crawl: reuse pass-1 output' },

  // auth
  AUTH_PROFILE:        { scope: 'auth', def: 'auth-profile.json', desc: 'path to the per-target auth profile (TTL, provider exclusions, cert handling)' },
  AUTH_TTL_SECONDS:    { scope: 'auth', def: '(from auth-profile)', desc: 'session TTL estimate; enables proactive keeper refresh at ~50% of it (0 disables)' },
  AUTH_REFRESH_AT_FRACTION: { scope: 'auth', def: '0.5', desc: 'where in the TTL window the keeper refreshes (0-1)' },
  AUTH_MAX_AGE_S:      { scope: 'auth', def: '1800', desc: 'ensure-fresh staleness threshold when no TTL is declared' },
  EXCLUDE_SSO_PROVIDERS: { scope: 'pass1', def: '(built-in provider list)', desc: 'comma-separated "Sign in with <provider>" buttons the walker never clicks; none disables' },
  CRAWL_IGNORE_HTTPS_ERRORS: { scope: 'auth', def: '0', desc: 'accept internally-signed certs in every browser context (crawler, harvest, login, playwright)' },
  LOGIN_PATH:          { scope: 'auth', def: '(SEED_PATH)', desc: 'route hosting the app\'s own login form (auth-profile loginPath override)' },
  LOGIN_EMAIL:         { scope: 'auth', def: '(unset)', desc: 'login identity', secret: true },
  LOGIN_PASSWORD:      { scope: 'auth', def: '(unset)', desc: 'login secret', secret: true },
  LOGIN_URL_REGEX:     { scope: 'auth', def: '/(login|sign-?in|signin|auth)', desc: 'what counts as a login URL' },
  LOGIN_EMAIL_SELECTOR:{ scope: 'auth', def: '(auto)', desc: 'email field selector' },
  LOGIN_PASSWORD_SELECTOR: { scope: 'auth', def: '(auto)', desc: 'password field selector' },
  LOGIN_SUBMIT_SELECTOR: { scope: 'auth', def: '(auto)', desc: 'submit button selector' },
  LOGIN_SUBMIT_TEXT:   { scope: 'auth', def: 'Sign in', desc: 'submit button text fallback' },
  LOGIN_MAX_WAIT_MS:   { scope: 'auth', def: '300000', desc: 'interactive login: max wait for the human' },
  LOGIN_URL_STABLE_MS: { scope: 'auth', def: '3000', desc: 'interactive login: landing stability window' },
  CRAWL_INTERACTIVE_LOGIN: { scope: 'auth', def: '1', desc: 'offer the real-browser manual login fallback' },
  HARVEST_TIMEOUT_MS:  { scope: 'auth', def: '45000', desc: 'bearer-token harvest page timeout' },
  TEST_BEARER:         { scope: 'gen', def: '(unset)', desc: 'explicit bearer for generated API tests', secret: true },

  // browser
  HEADLESS:            { scope: 'pass1', def: '1', desc: '0 opens a visible browser (needed for some SSO popups)' },

  // extractor orchestration
  SKIP:                { scope: 'extractor', def: '(none)', desc: 'comma-separated source ids to skip' },
  PARALLEL:            { scope: 'extractor', def: '1', desc: '0 forces serial source extraction' },
  MAX_PARALLEL:        { scope: 'extractor', def: '8', desc: 'cap concurrent extractor subprocesses' },

  // generators
  E2E_MAX_FLOWS:       { scope: 'gen', def: '12', desc: 'UI generator: max flow specs' },
  E2E_MAX_DEPTH:       { scope: 'gen', def: '5', desc: 'UI generator: max flow depth' },
  API_BASE:            { scope: 'gen', def: '(auto)', desc: 'API origin override for generated tests' },
  GRAPHIFY_GRAPH:      { scope: 'gen', def: '(auto)', desc: 'path to graphify graph.json' },
};

// Env keys that look like crawler knobs. Anything matching this that is set
// but NOT in the registry is a typo or a knob nothing reads anymore.
const KNOB_SHAPED = /^(CRAWL|CRAWLER|DEEP|LOGIN|SEED|WORKER|INTERCEPT|CAPTURE|URL_STABLE|MAX_INTERACT|MAX_LIST|SAFE_CLICK|NEVER_CLICK|DESTRUCTIVE_CLICK|POST_CRAWL|POST_NAV|HARVEST|HEADLESS|PLAYWRIGHT|SYNTH_MAX|E2E_MAX|SKIP_|AUTH_|EXCLUDE_SSO)/;

const HEADLINE = [
  'CRAWL_WORKERS', 'CRAWL_BUDGET_MS', 'MAX_INTERACT_PAGES', 'MAX_INTERACT_DEPTH',
  'SEED_PATHS', 'HEADLESS', 'WORKER_STAGGER_MS', 'CRAWL_TABLE_WAIT_MS',
];

function shown(name) {
  const k = KNOBS[name];
  const set = process.env[name] !== undefined && process.env[name] !== '';
  if (k?.secret) return set ? '(set)' : '(unset)';
  return set ? process.env[name] : `${k?.def ?? '(unset)'} (default)`;
}

// Print the effective crawler config + warnings. `log` is ctx's stderr logger.
// Returns the warnings so the caller can surface them in the JSON envelope.
export function logCrawlerConfig(log, { dotenv } = {}) {
  const warnings = [];

  if (dotenv) {
    log(`[config] loaded ${dotenv.applied.length} var(s) from .env` +
        (dotenv.overridden.length ? ` (${dotenv.overridden.length} already exported — env wins: ${dotenv.overridden.join(', ')})` : ''));
  } else if (dotenv === null) {
    log('[config] no .env file found — using exported environment only');
  }

  log('[config] effective crawler config (pass 1):');
  for (const name of HEADLINE) log(`[config]   ${name}=${shown(name)}`);
  log(`[config]   LOGIN_EMAIL=${shown('LOGIN_EMAIL')} LOGIN_PASSWORD=${shown('LOGIN_PASSWORD')}`);

  // every non-headline registry knob the operator explicitly set
  const explicit = Object.keys(KNOBS)
    .filter((n) => !HEADLINE.includes(n) && n !== 'LOGIN_EMAIL' && n !== 'LOGIN_PASSWORD')
    .filter((n) => process.env[n] !== undefined && process.env[n] !== '');
  if (explicit.length) {
    log('[config] explicitly set:');
    for (const n of explicit) log(`[config]   ${n}=${KNOBS[n].secret ? '(set)' : process.env[n]}  [${KNOBS[n].scope}]`);
  }

  // warn: pass-2 knobs set (they do nothing unless deep-crawl runs)
  const deepSet = explicit.filter((n) => KNOBS[n].scope === 'pass2');
  for (const n of deepSet) {
    const w = `${n} applies to deep-crawl pass 2 only — the pass-1 walker ignores it (pass-1 equivalents: CRAWL_BUDGET_MS / MAX_INTERACT_PAGES / CRAWL_WORKERS)`;
    warnings.push(w); log(`[config] ⚠ ${w}`);
  }

  // warn: knob-shaped env vars nothing reads
  for (const name of Object.keys(process.env)) {
    if (KNOB_SHAPED.test(name) && !(name in KNOBS) && process.env[name] !== '') {
      const w = `${name} is set but no crawler code reads it (legacy knob or typo)`;
      warnings.push(w); log(`[config] ⚠ ${w}`);
    }
  }

  // notice: unbounded crawl is a deliberate mode, not an accident — say what
  // still bounds it so a runaway is impossible to misread.
  if (process.env.CRAWL_BUDGET_MS === '0') {
    log(`[config] ℹ CRAWL_BUDGET_MS=0 — unbounded crawl: runs until the frontier drains, bounded by MAX_INTERACT_PAGES=${process.env.MAX_INTERACT_PAGES || '200'} and list-sampling caps`);
  }

  // notice: parallel crawl on rotating-token SSO apps. The session keeper
  // (warm-up + single-flight recovery + broadcast refresh) makes >1 workable,
  // but it needs a TTL to refresh proactively — without one the keeper is
  // reactive-only and recovery storms still cost wall-clock.
  const workers = Number(process.env.CRAWL_WORKERS || 1);
  if (workers > 1) {
    const hasTtl = !!process.env.AUTH_TTL_SECONDS;
    const w = `CRAWL_WORKERS=${workers}: parallel contexts share one rotating session — the keeper broadcasts refreshes, but declare the session TTL (auth-profile.json ttlSeconds or AUTH_TTL_SECONDS) so it refreshes proactively${hasTtl ? '' : ' (no TTL declared → reactive-only)'}`;
    warnings.push(w); log(`[config] ${hasTtl ? 'ℹ' : '⚠'} ${w}`);
  }

  return warnings;
}
