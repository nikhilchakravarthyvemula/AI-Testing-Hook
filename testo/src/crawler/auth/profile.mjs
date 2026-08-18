// auth-profile.json — per-target auth configuration for the crawler pipeline.
//
// The auth machinery grew a knob per incident (TTL guesses hard-coded in
// recovery timeouts, provider exclusions in regexes, cert handling nowhere).
// This file is the single declarative place to describe how a TARGET's auth
// behaves; every stage (scan, harvest, generate, execute) reads the same
// profile via loadAuthProfile().
//
// Location: $AUTH_PROFILE (absolute or repo-relative path), falling back to
// <repoRoot>/auth-profile.json. Missing file → all defaults (env overrides
// still apply), so the profile is strictly opt-in.
//
// Shape (all fields optional):
// {
//   "loginPath": "/login",         // where the app's own login form lives.
//                                  // Default: SEED_PATH — the seed route is
//                                  // expected to bounce to the form.
//   "formFirst": true,             // try the plain email/password form before
//                                  // any "Sign in with <provider>" button
//   "ttlSeconds": 900,             // session/access-token TTL estimate.
//                                  // Enables proactive refresh: the pool
//                                  // re-warms the session at
//                                  // ttlSeconds * refreshAtFraction.
//   "refreshAtFraction": 0.5,      // when in the TTL window to refresh
//   "excludeProviders": ["google"],// SSO provider buttons the walker must
//                                  // never click (merged into never-click).
//                                  // Default: the built-in provider list.
//   "ignoreHTTPSErrors": false     // accept internally-signed certs
// }
//
// Env overrides (win over the file): AUTH_TTL_SECONDS, EXCLUDE_SSO_PROVIDERS,
// CRAWL_IGNORE_HTTPS_ERRORS, AUTH_REFRESH_AT_FRACTION, LOGIN_PATH.
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_SSO_PROVIDERS } from './sso.mjs';

const DEFAULTS = {
  loginPath: null,          // null → caller falls back to SEED_PATH
  formFirst: true,
  ttlSeconds: null,         // null → no proactive refresh timer
  refreshAtFraction: 0.5,
  excludeProviders: DEFAULT_SSO_PROVIDERS,
  ignoreHTTPSErrors: false,
};

function readProfileFile(repoRoot, log) {
  const envPath = process.env.AUTH_PROFILE;
  const file = envPath
    ? (path.isAbsolute(envPath) ? envPath : path.join(repoRoot, envPath))
    : path.join(repoRoot, 'auth-profile.json');
  if (!fs.existsSync(file)) {
    if (envPath) log?.(`[auth-profile] AUTH_PROFILE=${envPath} not found — using defaults`);
    return { file: null, data: {} };
  }
  try {
    return { file, data: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (e) {
    log?.(`[auth-profile] ${file} is not valid JSON (${e.message}) — using defaults`);
    return { file: null, data: {} };
  }
}

const boolEnv = (name) => {
  const v = process.env[name];
  if (v === undefined || v === '') return undefined;
  return v !== '0' && v.toLowerCase() !== 'false';
};
const numEnv = (name) => {
  const v = process.env[name];
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};

// Parse EXCLUDE_SSO_PROVIDERS: comma list; '0'/'none' → [] (disable the merge).
function providersFromEnv() {
  const raw = process.env.EXCLUDE_SSO_PROVIDERS;
  if (raw === undefined || raw === '') return undefined;
  if (raw === '0' || raw.toLowerCase() === 'none') return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

export function loadAuthProfile(repoRoot, { log } = {}) {
  const { file, data } = readProfileFile(repoRoot, log);
  const profile = {
    ...DEFAULTS,
    ...Object.fromEntries(Object.entries(data).filter(([k]) => k in DEFAULTS)),
  };

  // '_'-prefixed keys are inline documentation (see auth-profile.example.json).
  const unknown = Object.keys(data).filter((k) => !(k in DEFAULTS) && !k.startsWith('_'));
  if (unknown.length) log?.(`[auth-profile] ignoring unknown field(s): ${unknown.join(', ')}`);

  const envTtl = numEnv('AUTH_TTL_SECONDS');
  if (envTtl !== undefined) profile.ttlSeconds = envTtl || null;   // 0 disables
  const envFraction = numEnv('AUTH_REFRESH_AT_FRACTION');
  if (envFraction !== undefined && envFraction > 0 && envFraction < 1) profile.refreshAtFraction = envFraction;
  const envProviders = providersFromEnv();
  if (envProviders !== undefined) profile.excludeProviders = envProviders;
  const envTls = boolEnv('CRAWL_IGNORE_HTTPS_ERRORS');
  if (envTls !== undefined) profile.ignoreHTTPSErrors = envTls;
  if (process.env.LOGIN_PATH) profile.loginPath = process.env.LOGIN_PATH;

  profile.source = file;
  if (file) {
    log?.(`[auth-profile] loaded ${path.relative(repoRoot, file)}` +
      ` (ttl=${profile.ttlSeconds ?? 'unknown'}s, refreshAt=${profile.refreshAtFraction}, ` +
      `formFirst=${profile.formFirst}, excludeProviders=${profile.excludeProviders.length}, ` +
      `ignoreHTTPSErrors=${profile.ignoreHTTPSErrors})`);
  }
  return profile;
}

// Proactive-refresh cadence in ms, or null when the TTL is unknown.
export function refreshIntervalMs(profile) {
  if (!profile?.ttlSeconds) return null;
  // Floor at 15s so a mis-typed tiny TTL can't turn the keeper into a
  // busy-loop that starves the actual crawl.
  return Math.max(15_000, Math.round(profile.ttlSeconds * 1000 * profile.refreshAtFraction));
}
