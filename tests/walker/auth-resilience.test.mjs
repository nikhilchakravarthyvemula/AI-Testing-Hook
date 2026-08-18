// auth-resilience.test.mjs — session keeper + outage machinery (optimize-crawler).
//
// Covers the new SharedState/runWorker auth-resilience behavior without a
// browser (same stub-Page pattern as crash-recovery.test.mjs):
//   1. network outage: connection-level errors don't burn attempt budgets,
//      the frontier pauses, one prober resumes it, nothing is abandoned
//   2. auth-aware backoff: workers hold while a recovery is in flight
//   3. recovery storm: a second login bounce inside the window triggers ONE
//      shared session refresh instead of another per-context recovery
//   4. 'recreate-context' verdict: interactive-login adoption swaps the page
//   5. pure helpers: SSO never-click regex, session-material guard,
//      hash-SPA effectiveParts
//
// Run: npm run test:walker   (plain node, no Playwright)

import assert from 'node:assert/strict';
import { runWorker } from '../../testo/src/crawler/walker/worker.mjs';
import { SharedState } from '../../testo/src/crawler/walker/state.mjs';
import { ssoNeverClickSource, DEFAULT_SSO_PROVIDERS } from '../../testo/src/crawler/auth/sso.mjs';
import { sessionMaterial, totalMaterial, shouldPersist } from '../../testo/src/crawler/lib/session-material.mjs';
import { effectiveParts, routeKey } from '../../testo/src/crawler/lib/route-key.mjs';

const quiet = () => {};
const emptyScan = async () => ({ items: [], totalElements: 0, rejected: [] });
const issueCount = (state, type) => state.issues.filter(i => i.type === type).length;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const B = 'https://app.test';

// Minimal stub Page: `behavior(url)` decides what goto does.
function stubPage(name, behavior, events = []) {
  let currentUrl = 'about:blank';
  const resolved = () => Promise.resolve();
  return {
    name, events,
    isClosed: () => false,
    url: () => currentUrl,
    async goto(url) {
      events.push(`${name}:goto:${url}`);
      const b = behavior(url);
      if (b instanceof Error) throw b;
      currentUrl = b || url;
    },
    _setUrl(u) { currentUrl = u; },
    waitForLoadState: resolved,
    waitForFunction: resolved,
    waitForTimeout: resolved,
    keyboard: { press: resolved },
    screenshot: resolved,
  };
}

// ── 1. network outage: pause, no attempt burn, prober resumes ────────────
{
  const state = new SharedState({ seeds: ['/a', '/b', '/c'].map(p => ({ url: `${B}${p}`, depth: 0 })) });
  let failuresLeft = 3;   // exactly the outage threshold; the prober's goto succeeds
  const page = stubPage('p1', () => {
    if (failuresLeft > 0) { failuresLeft--; return new Error('page.goto: net::ERR_CONNECTION_REFUSED at https://app.test'); }
    return null;
  });

  await runWorker({ workerId: 1, state, page, sameOrigin: B, scannerFn: emptyScan, log: quiet });

  for (const p of ['/a', '/b', '/c']) assert.ok(state.interactedUrls.has(`${B}${p}`), `${p} visited after the outage`);
  assert.equal(issueCount(state, 'network-error'), 3, 'each connection failure recorded');
  assert.equal(issueCount(state, 'network-outage'), 1, 'outage flipped once');
  assert.equal(issueCount(state, 'network-restored'), 1, 'prober restored the frontier');
  assert.equal(issueCount(state, 'task-failed'), 0, 'network errors are not task failures');
  assert.equal(issueCount(state, 'task-abandoned'), 0, 'no attempt budget burned on a dead link');
  assert.equal(state.outageCount, 1);
  assert.equal(state.outageActive, false);
  console.log('PASS  auth 1 — network outage: frontier paused, no attempts burned, all routes visited');
}

// ── 2. auth-aware backoff: no dequeue while a recovery is in flight ──────
{
  const state = new SharedState({ seeds: [{ url: `${B}/a`, depth: 0 }] });
  const events = [];
  const page = stubPage('p1', () => null, events);

  state.beginAuthRecovery();
  const release = (async () => { await sleep(450); events.push('auth:released'); state.endAuthRecovery(); })();
  await runWorker({ workerId: 1, state, page, scannerFn: emptyScan, log: quiet });
  await release;

  assert.equal(events[0], 'auth:released', 'no goto happened before the recovery ended');
  assert.ok(state.interactedUrls.has(`${B}/a`), 'task processed after the hold');
  console.log('PASS  auth 2 — auth-aware backoff: worker held until recovery ended, then drained');
}

// ── 3. recovery storm → ONE shared refresh, not N serialized recoveries ──
{
  const state = new SharedState({ seeds: ['/p1', '/p2', '/p3'].map(p => ({ url: `${B}${p}`, depth: 0 })) });
  let authBroken = true;
  const page = stubPage('p1', (url) =>
    (authBroken && !url.includes('/login')) ? `${B}/login?next=${encodeURIComponent(url)}` : null);

  let refreshCalls = 0;
  state.requestSessionRefresh = async () => { refreshCalls++; authBroken = false; return true; };

  let perContextRecoveries = 0;
  const reAuth = async (pg, intendedUrl) => {
    perContextRecoveries++;
    pg._setUrl(intendedUrl);   // this context recovered, but the SHARED state is still broken
    return true;
  };

  await runWorker({ workerId: 1, state, page, scannerFn: emptyScan, log: quiet, reAuth });

  assert.equal(perContextRecoveries, 1, 'only the FIRST bounce used per-context recovery');
  assert.equal(refreshCalls, 1, 'second bounce inside the window escalated to one shared refresh');
  for (const p of ['/p1', '/p2', '/p3']) assert.ok(state.interactedUrls.has(`${B}${p}`), `${p} visited`);
  const authCounts = {};
  for (const e of state.authEvents) authCounts[e.type] = (authCounts[e.type] || 0) + 1;
  assert.equal(authCounts['re-auth'], 1, 're-auth event recorded with duration');
  assert.ok(state.authEvents.every(e => e.type !== 're-auth' || typeof e.durationMs === 'number'));
  console.log('PASS  auth 3 — recovery storm: one shared refresh+broadcast, per-context recovery not repeated');
}

// ── 4. 'recreate-context' verdict: interactive-login session adoption ────
{
  const state = new SharedState({ seeds: [{ url: `${B}/deep`, depth: 0 }] });
  let adopted = false;
  const mkPage = (name) => stubPage(name, (url) =>
    (!adopted && !url.includes('/login')) ? `${B}/login` : null);

  let recreations = 0;
  const recreatePage = async () => { recreations++; adopted = true; return mkPage('p2'); };
  const reAuth = async () => 'recreate-context';   // headless recovery failed → interactive login minted a new session

  await runWorker({ workerId: 1, state, page: mkPage('p1'), scannerFn: emptyScan, log: quiet, reAuth, recreatePage });

  assert.equal(recreations, 1, 'worker swapped onto a fresh context');
  assert.ok(state.interactedUrls.has(`${B}/deep`), 'intended route crawled on the new context');
  assert.ok(state.authEvents.some(e => e.type === 'context-recreated'), 'adoption recorded in auth events');
  console.log('PASS  auth 4 — recreate-context: interactive session adopted via context recreation');
}

// ── 5a. SSO never-click regex ────────────────────────────────────────────
{
  const re = new RegExp(ssoNeverClickSource(DEFAULT_SSO_PROVIDERS), 'i');
  for (const label of [
    'Sign in with Google', 'Sign-in with Microsoft', 'Continue with GitHub',
    'Log in with Okta', 'Authenticate with SSO', 'SSO', ' Single Sign-On ',
    'Sign in with Office 365',
  ]) assert.ok(re.test(label), `should block: "${label}"`);
  for (const label of [
    'Sign in', 'Login', 'Google Maps', 'Continue', 'Sign in to your account',
    'Search with filters', 'Microsoft Office documents',
  ]) assert.ok(!re.test(label), `should NOT block: "${label}"`);
  const custom = new RegExp(ssoNeverClickSource(['ping identity']), 'i');
  assert.ok(custom.test('Sign in with Ping Identity'));
  assert.ok(!custom.test('Sign in with Google'), 'custom list replaces the default set');
  assert.equal(ssoNeverClickSource([]), null, 'empty list disables the merge');
  console.log('PASS  auth 5a — SSO never-click regex: provider buttons blocked, plain sign-in untouched');
}

// ── 5b. session-material save guard ──────────────────────────────────────
{
  const hollow = { cookies: [{ name: 'idp-iframe' }], origins: [{ origin: B, localStorage: [], indexedDB: [{ name: 'db', stores: [{ name: 's', records: [] }] }] }] };
  const firebase = { cookies: [], origins: [{ origin: B, localStorage: [], indexedDB: [{ name: 'firebaseLocalStorageDb', stores: [{ name: 'firebaseLocalStorage', records: [{ key: 'u', value: {} }] }] }] }] };
  const cookieSession = { cookies: [{ name: 'session' }], origins: [] };
  const empty = { cookies: [], origins: [] };

  assert.equal(sessionMaterial(firebase), 1, 'IndexedDB records count as session material');
  assert.equal(sessionMaterial(hollow), 0, 'empty stores carry no material');
  assert.equal(totalMaterial(cookieSession), 1);

  assert.equal(shouldPersist(empty, firebase).ok, false, 'empty capture never clobbers');
  assert.equal(shouldPersist(hollow, firebase).ok, false, 'hollow shell never clobbers a real session');
  assert.equal(shouldPersist(firebase, hollow).ok, true, 'real session replaces a hollow one');
  assert.equal(shouldPersist(firebase, null).ok, true, 'first save goes through');
  assert.equal(shouldPersist(cookieSession, null).ok, true, 'cookie-only sessions are persistable (the old inline check refused these)');
  console.log('PASS  auth 5b — session-material guard: hollow captures rejected, cookie/IndexedDB sessions kept');
}

// ── 5c. hash-SPA effectiveParts ──────────────────────────────────────────
{
  const hash = effectiveParts(`${B}/app#/case/123?view=full`);
  assert.deepEqual(
    { origin: hash.origin, path: hash.path, search: hash.search, hashRouted: hash.hashRouted },
    { origin: B, path: '/app#/case/123', search: '?view=full', hashRouted: true });
  const plain = effectiveParts(`${B}/inventory/42?tab=2`);
  assert.deepEqual(
    { path: plain.path, search: plain.search, hashRouted: plain.hashRouted },
    { path: '/inventory/42', search: '?tab=2', hashRouted: false });
  // OAuth callback hashes are state, not routes.
  const oauth = effectiveParts(`${B}/cb#state=xyz&session_state=abc&code=1`);
  assert.equal(oauth.hashRouted, false);
  // Distinct hash routes must not collapse (the pulseviews fan-out killer).
  assert.notEqual(routeKey(`${B}/#/cases`), routeKey(`${B}/#/endpoints`));
  console.log('PASS  auth 5c — effectiveParts: hash routes keep identity, OAuth hashes stripped');
}

console.log('\nAll auth-resilience scenarios passed.');
