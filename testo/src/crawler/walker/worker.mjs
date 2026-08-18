// walker/worker.mjs
//
// One async worker = one Playwright BrowserContext (independent cookies,
// localStorage, JS heap) running a DFS loop against the SharedState.
//
// Race-safety: every (read, mutate) pair on SharedState happens in one
// synchronous block — never across an `await` — so two workers can't
// both win the same dequeue or the same transition claim. This relies
// on Node's single-threaded JS scheduling; do not introduce a real
// thread here.

import fs from 'node:fs';
import path from 'node:path';
import {
  scanInteractables,
  keyFor,
  clickableLocator,
  domSignature,
  stateChanged,
  selectClickable,
  selectInteractables,
} from './scanner.mjs';
import { routeKey } from '../lib/route-key.mjs';

// Default per-page scanner. Callers may inject a different function via
// opts.scannerFn — it just has to return the same
// { items, totalElements, rejected } shape.
const DEFAULT_SCANNER = scanInteractables;

const wait = (ms) => new Promise(r => setTimeout(r, ms));

// Browser-context predicate passed to page.waitForFunction — "is the data
// table done loading?". Returns true when EITHER there's no table at all,
// OR a table has at least one row with REAL text and no skeleton markers.
//
// Why this matters: shadcn / Tailwind / MUI render placeholder rows with
// `.animate-pulse` (or aria-busy) and EMPTY text content while the data
// XHR is in flight. A naive "tbody tr > 0" wait settles on those skeleton
// rows ~1s before the real data arrives, so the walker scans empty
// placeholders, never sees the real (navigable) rows, and silently fails
// to discover every detail page in the app. Requiring a row with
// non-whitespace text — and the absence of pulse/busy markers inside any
// table — waits past the skeleton to the populated table.
function tableReady() {
  const tables = [...document.querySelectorAll('table, [role="grid"], [role="table"]')];
  if (tables.length === 0) return true;                       // no table → nothing to wait for
  if (tables.some(t => t.querySelector('.animate-pulse, [aria-busy="true"]'))) return false;
  const rows = document.querySelectorAll('tbody tr, [role="row"], [aria-rowindex]');
  for (const r of rows) if ((r.textContent || '').trim().length > 0) return true;
  return false;
}

// Worker idle grace period — how long the queue must stay empty AND no
// other worker active before this worker exits. Prevents one worker
// exiting prematurely while a sibling is about to enqueue children.
const IDLE_GRACE_MS = 750;

// A dead page (renderer OOM on a heavy route, killed tab, closed context)
// poisons every subsequent goto with an instant failure. Detect it so the
// worker recreates its page instead of consuming the whole queue with a
// corpse. Matches Playwright's crash/closure message family.
const DEAD_PAGE_RE = /page crashed|target crashed|target closed|has been closed|browser has been disconnected|session closed/i;

// Connection-level (not HTTP-level) Chromium network errors — the signature
// of a dead link/VPN, not a broken page. Playwright goto timeouts are NOT
// included: a slow page is still an answering page.
const NETWORK_ERR_RE = /net::ERR_(?:INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED|CONNECTION_REFUSED|CONNECTION_RESET|CONNECTION_CLOSED|CONNECTION_TIMED_OUT|CONNECTION_ABORTED|ADDRESS_UNREACHABLE|NETWORK_CHANGED|NETWORK_ACCESS_DENIED|PROXY_CONNECTION_FAILED|TUNNEL_CONNECTION_FAILED|EMPTY_RESPONSE)\b/i;
export function isDeadPage(page, err) {
  try { if (page.isClosed()) return true; } catch { return true; }
  return DEAD_PAGE_RE.test(err?.message || '');
}

// Per-list drill-down depth. When a page exposes a table / list of N similar
// rows (each row navigates to /resource/detail?id=…), the walker clicks into
// each row to reach its detail page. Scanning IS deep scanning — the default
// is UNBOUNDED (every row → every detail page). Tables are detected by URL
// pathname: items sharing the same pathname (regardless of query) form a
// group. Set MAX_LIST_ITEMS_PER_NAV=N to cap sampling to N rows per list group
// (useful for very large tables where budget/maxPages would otherwise bound
// the crawl); the sidebar is unaffected (each nav link is its own group).
// Stable hash of a page's interactable STRUCTURE (kinds + labels + tags,
// order-independent). Two instances of a template with identical structure
// produce the same hash — the "did this sample look different?" novelty signal.
function shapeHashOf(items) {
  const sig = items
    .map(it => `${it.kind}|${it.tag || ''}|${it.label || it.text || it.name || it.placeholder || ''}`)
    .sort()
    .join('\n');
  let h = 5381;
  for (let i = 0; i < sig.length; i++) h = ((h << 5) + h + sig.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

const DEFAULT_MAX_LIST_ITEMS = (() => {
  const v = process.env.MAX_LIST_ITEMS_PER_NAV;
  if (v == null || v === '') return Infinity;           // deep by default
  if (v === 'infinity' || v === 'Infinity') return Infinity;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : Infinity;
})();

export async function runWorker(opts) {
  const {
    workerId,
    state,
    sameOrigin,
    safeRe,
    destrRe,
    neverRe,
    idpRe,        // optional: external-IdP host regex source — post-click SSO safety net
    maxClicksPerPage = Infinity,
    maxListItemsPerNav = DEFAULT_MAX_LIST_ITEMS,
    postNavWaitMs = 1500,
    log = (() => {}),
    recordPage,   // optional: (page, label, depth, phase, extras) => Promise
    reAuth,       // optional: (page) => Promise<void>  — called on /login redirect
    scannerFn = DEFAULT_SCANNER,   // (page, opts) => { items, totalElements, rejected }
    recreatePage, // optional: async (workerId) => Page — replace a crashed page
    apiNoveltyFor, // optional: (pageUrl) => count of first-seen API templates this page fired
  } = opts;
  // Reassignable: replaced with a fresh page when the renderer crashes.
  let { page } = opts;

  // Pre-click filtering rejects "Sign in with <provider>" buttons by label
  // (never-click merge in crawl.mjs); this regex is the POST-click safety net
  // for the ones the label heuristic can't see (icon-only buttons, unusual
  // wording): a click that lands on a known IdP is flagged as an issue so
  // auth-state poisoning has a paper trail, and the re-baseline goto below
  // already brings the worker straight back.
  const idpRegex = idpRe ? new RegExp(idpRe, 'i') : null;

  let myActive = false;
  let idleSince = null;

  while (!state.isBudgetExhausted()) {
    // ── outage hold ─────────────────────────────────────────────────────
    // The network is down (N goto failures across workers in a short
    // window). Dequeuing would just burn attempt budgets against a dead
    // link — hold the frontier. ONE worker probes the origin until it
    // answers; the rest wait. Outage time is excluded from the crawl
    // budget by reportNetworkOk().
    if (state.outageActive) {
      if (myActive) { state.endWork(); myActive = false; }
      idleSince = null;
      if (sameOrigin && state.tryBecomeOutageProber(workerId)) {
        try {
          await page.goto(sameOrigin, { waitUntil: 'domcontentloaded', timeout: 10_000 });
          state.reportNetworkOk();
          log(`[w${workerId}] network restored — resuming frontier`);
        } catch { await wait(3_000); }
      } else {
        await wait(1_000);
      }
      continue;
    }

    // ── auth-aware backoff ──────────────────────────────────────────────
    // A sibling (or the session keeper) is mid-recovery on the single-
    // flight token chain. Starting a task now means navigating with a
    // token that's about to rotate — the task would bounce to /login and
    // pile onto the same recovery chain. Hold until the recovery ends.
    if (state.authRecoveryActive) {
      if (myActive) { state.endWork(); myActive = false; }
      idleSince = null;
      await wait(300);
      continue;
    }

    const task = state.tryDequeue();

    // ── nothing to do ───────────────────────────────────────────────────
    if (!task) {
      if (myActive) { state.endWork(); myActive = false; }
      if (state.isQuiescent()) {
        if (!idleSince) idleSince = Date.now();
        if (Date.now() - idleSince > IDLE_GRACE_MS) break;   // exit
      } else {
        idleSince = null;   // someone's still working — keep polling
      }
      await wait(100);
      continue;
    }

    // ── claim & process ─────────────────────────────────────────────────
    idleSince = null;
    if (!myActive) { state.beginWork(); myActive = true; }

    const { url, depth, phase = 'interact' } = task;
    log(`[w${workerId}] page (d=${depth}, ${state.pagesVisited}/${state.maxPages}): ${url}`);

    try {
      // A goto failure must NOT fall through to the scan: the page is either
      // dead (crash — handled below) or still showing the PREVIOUS route, and
      // scanning it would record this task's interactables under the wrong
      // URL. Throw to the task-level handler, which requeues with a cap.
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      // `load` event fires on initial HTML+resources. For an SPA, that's
      // BEFORE React mounts anything visible — and for apps doing silent
      // token refresh via iframe (Keycloak, Auth0, …) the body is still
      // empty for 2-5 seconds while the refresh completes.
      //
      // Two-stage CONTENT-BASED settle:
      //  1. wait for body.innerText > 200 chars (React mounted SOMETHING)
      //  2. if the page contains a table / grid / list with no rows
      //     populated, wait up to 6s more for the async XHR-loaded rows
      //     to appear. Pages WITHOUT a table fall through instantly.
      //
      // Without #2, table-driven pages like /inventory / /endpoints /
      // /remediation are scanned during the window where the header has
      // rendered but the body is still empty → we miss every row → no
      // detail-page drill-down. This adds at most 6s per table-having
      // page, only when its rows haven't loaded yet.
      await page.waitForLoadState('load', { timeout: 4_000 }).catch(() => {});
      await page.waitForFunction(
        () => !!(document.body && document.body.innerText && document.body.innerText.length > 200),
        { timeout: 6_000 }
      ).catch(() => {});
      // Wait for table rows to render. Some apps (console-preview, large
      // dashboards) take 8-12s for the XHR to return. The wait returns
      // ASAP if either no table is present OR at least one row exists.
      // Timeout 15s — bounds the slowest pages.
      // Wait up to 30s for the first row to populate (override with
      // CRAWL_TABLE_WAIT_MS env var). Some apps' inventory/endpoints
      // tables take 8-25s to return their initial XHR; the previous
      // 15s default missed them on console-preview-class apps.
      const tableWaitMs = Number(process.env.CRAWL_TABLE_WAIT_MS || 30_000);
      await page.waitForFunction(tableReady, { timeout: tableWaitMs, polling: 250 }).catch(() => {});
      await page.waitForTimeout(postNavWaitMs);

      // ── Diagnostic screenshot (opt-in) ──────────────────────────────
      // CRAWL_DIAG_SCREENSHOTS=1 → save a screenshot of EACH page at
      // scan-time to output/<OUT_DIR>/diag/. Lets you confirm whether
      // rows are actually rendered in the walker's chromium for apps
      // where /inventory etc. comes back empty.
      if ((process.env.CRAWL_DIAG_SCREENSHOTS ?? '0') === '1') {
        try {
          // process.cwd() is context-layer/content-extractor/crawler/ when invoked via the
          // standard pipeline → go up two for repo root.
          const diagDir = path.join(
            process.cwd(), '..', '..', 'output',
            process.env.CRAWLER_OUT_DIR_NAME || 'crawler',
            'diag'
          );
          await fs.promises.mkdir(diagDir, { recursive: true });
          const slug = url.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 100);
          const file = path.join(diagDir, `${slug}.png`);
          await page.screenshot({ path: file, fullPage: true, timeout: 4_000 });
          log(`[w${workerId}] diag screenshot: ${file}`);
        } catch {}
      }

      // Per-context auth refresh — if we landed on a login page, the
      // saved session expired (or this context never had one). Run the
      // host's maybeLogin equivalent and continue.
      if (/\/(login|signin|sign-in|sso|auth)\b/i.test(page.url()) && reAuth) {
        log(`[w${workerId}] /login redirect — re-authenticating`);
        state.recordIssue({ type: 're-auth', workerId, url, message: `landed at ${page.url()}` });

        // Recovery storm (mid-crawl warm-up): a second bounce inside the
        // window means the SHARED session is stale for every context — N
        // per-context recoveries would serialize N slow SSO round-trips.
        // Ask the pool for ONE keeper refresh + broadcast instead, then
        // re-try the route before falling back to per-context recovery.
        if (state.requestSessionRefresh && state.noteRecoveryHit() >= 2) {
          log(`[w${workerId}] recovery storm — requesting shared session refresh + broadcast`);
          await state.requestSessionRefresh('recovery-storm').catch(() => {});
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
          await page.waitForLoadState('load', { timeout: 4_000 }).catch(() => {});
        }

        if (/\/(login|signin|sign-in|sso|auth)\b/i.test(page.url())) {
          // Pass the intended route so reAuth can re-navigate to IT (not the
          // login page) once the SSO refresh-cookie token settles. While this
          // runs, authRecoveryActive makes sibling workers hold (see loop top),
          // and the recovery time is excluded from the crawl budget.
          const t0 = Date.now();
          state.beginAuthRecovery();
          let verdict = null;
          try {
            verdict = await reAuth(page, url);
          } catch (e) {
            log(`[w${workerId}] re-auth failed: ${e.message}`);
            state.recordIssue({ type: 're-auth-failed', workerId, url, message: e.message });
          } finally {
            const dur = Date.now() - t0;
            state.endAuthRecovery();
            state.addBudgetPause(dur);
            state.recordAuthEvent({ type: 're-auth', workerId, durationMs: dur, message: url });
          }
          // 'recreate-context' → an interactive login minted a NEW session
          // whose material lives in IndexedDB, which can only be injected at
          // context creation. Swap this worker onto a fresh context seeded
          // from the new auth-state and re-land on the intended route.
          if (verdict === 'recreate-context' && recreatePage) {
            log(`[w${workerId}] adopting new session via context recreation`);
            page = await recreatePage(workerId);
            state.recordAuthEvent({ type: 'context-recreated', workerId, message: 'adopted interactive-login session' });
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
          }
        }
        await page.waitForLoadState('load', { timeout: 4_000 }).catch(() => {});
        // If recovery landed us back on the real route, let its content +
        // table rows settle before scanning (recovery did a fresh goto).
        if (!/\/(login|signin|sign-in|sso|auth)\b/i.test(page.url())) {
          await page.waitForFunction(
            () => !!(document.body && document.body.innerText && document.body.innerText.length > 200),
            { timeout: 6_000 },
          ).catch(() => {});
          await page.waitForFunction(tableReady, { timeout: tableWaitMs, polling: 250 }).catch(() => {});
          await page.waitForTimeout(postNavWaitMs);
        }
      }

      // Still on the login wall after re-auth → scanning would only click the
      // IdP sign-in buttons and the task URL would be permanently marked
      // visited without ever being seen. Requeue it ONCE (flagged) so a later
      // pass — after this or a sibling context recovers — actually crawls it.
      if (/\/(login|signin|sign-in|sso|auth)\b/i.test(page.url()) && !task.reauthRetried) {
        state.interactedUrls.delete(url);
        state.enqueue({ ...task, reauthRetried: true });
        state.recordIssue({ type: 'requeued-login-bounce', workerId, url, message: `bounced to ${page.url()}` });
        log(`[w${workerId}] still on login — requeued ${url} for one retry`);
        continue;
      }

      // ── scan ──────────────────────────────────────────────────────────
      // scannerFn defaults to the heuristic scanInteractables. The LLM-
      // primary walker overrides it with a scanner that asks an LLM what
      // to click and then verifies the suggestions against the DOM.
      const scan = await scannerFn(page, { safeRe, destrRe, neverRe, sameOrigin, log });
      // Novelty signals for this sample (fed to state.recordSample at task end).
      const edgeKeysAdded = [];
      const shapeHash = shapeHashOf(scan.items);

      const metaItems = selectInteractables(scan.items).map(it => ({
        kind: it.kind, tag: it.tag, role: it.role,
        label: it.label, name: it.name, placeholder: it.placeholder,
        inputType: it.inputType, testid: it.testid, idAttr: it.idAttr,
        selector: it.selector,
      }));
      state.setInteractables(url, metaItems);

      const accepted = selectClickable(scan.items);

      // Per-page label dedup + global transition claim. Claim happens
      // BEFORE the click (atomic on SharedState) so two workers visiting
      // the same URL via different paths can't double-click.
      const perPageSeen = new Set();
      const preCapped = [];
      let pageDedup = 0;
      for (const it of accepted) {
        const key = keyFor(it);
        if (perPageSeen.has(key)) { pageDedup++; continue; }
        perPageSeen.add(key);
        preCapped.push({ ...it, key });
      }

      // ── Per-list-group cap ──────────────────────────────────────────
      //
      // Two groupings, BOTH capped at maxListItemsPerNav (default 3):
      //
      //   nav items   → grouped by route TEMPLATE (routeKey: pathname
      //                 with {id}-segments collapsed + query param-name
      //                 signature, hash-SPA aware). Catches anchor-style
      //                 table rows whether they vary by query
      //                 (`/detail?id=X`), by path segment
      //                 (`/inventory/8f3ab129e4`), or by hash route
      //                 (`#/case/123`) — raw-pathname grouping missed
      //                 the last two.
      //
      //   click items → grouped by structural listGroupKey (the CSS
      //                 path with `:nth-of-type(N)` stripped). Catches
      //                 SPA-router rows that are `<div onClick=…>`
      //                 with no `<a href>`. Each sibling repeat in a
      //                 table / virtual list / card grid shares the
      //                 same listGroupKey and gets the cap.
      //
      // Sidebar items (each a unique pathname) and one-off buttons
      // (each a unique structural position) are unaffected — their
      // groups have size 1.
      const navByPath = new Map();
      const clickByStructure = new Map();
      const others = [];
      for (const it of preCapped) {
        if (it.kind === 'nav' && it.href) {
          const pathKey = routeKey(it.href, url);
          if (!navByPath.has(pathKey)) navByPath.set(pathKey, []);
          navByPath.get(pathKey).push(it);
        } else if (it.kind === 'click' && it.listGroupKey) {
          if (!clickByStructure.has(it.listGroupKey)) clickByStructure.set(it.listGroupKey, []);
          clickByStructure.get(it.listGroupKey).push(it);
        } else {
          others.push(it);
        }
      }
      let listCapDropped = 0;
      const capGroup = (group) => {
        if (group.length > maxListItemsPerNav) {
          listCapDropped += group.length - maxListItemsPerNav;
          return group.slice(0, maxListItemsPerNav);
        }
        return group;
      };
      const navKept   = [...navByPath.values()].flatMap(capGroup);
      const clickKept = [...clickByStructure.values()].flatMap(capGroup);
      const afterListCap = [...navKept, ...clickKept, ...others];

      // Claim each surviving candidate atomically against shared state.
      // OPTIMIZATION — known-target nav skip: if a `nav` candidate points
      // to a URL that's already been crawled (or is pending), DON'T click
      // it. Just record the edge and move on. This saves the ~5-7s round
      // trip of click + waitForURL + re-baseline page.goto for every
      // sidebar nav link — and sidebar items are ~80% of all candidates
      // on a typical admin app (the same 10 links appear on every page).
      const candidates = [];
      let pathSkipped = 0, navShortcircuited = 0;
      const knownUrls = state.interactedUrls;
      const pendingUrls = new Set(state.pending.map(t => t.url));
      for (const it of afterListCap) {
        const transition = `${url}::${it.key}`;
        if (!state.tryClaim(transition)) { pathSkipped++; continue; }
        // Cheap edge for known nav targets — no actual click.
        if (it.kind === 'nav' && it.href) {
          let abs;
          try { abs = new URL(it.href, url).href; } catch {}
          if (abs) {
            const cleanAbs = abs.replace(/#(?=.*(?:state|session_state|code|iss)=)[^#]*$/, '');
            if (knownUrls.has(cleanAbs) || pendingUrls.has(cleanAbs)) {
              state.addEdge({
                from: url, button: it.label || it.text || it.href, key: it.key,
                to: cleanAbs, hadNav: true, kind: 'nav', depth, originalKind: it.kind,
                shortcircuited: true,
              });
              edgeKeysAdded.push(it.key);
              navShortcircuited++;
              continue;
            }
          }
        }
        candidates.push({ ...it, transition });
      }
      const clicks = candidates.slice(0, maxClicksPerPage);

      if (scan.totalElements > 0) {
        const kinds = scan.items.reduce((a, it) => (a[it.kind] = (a[it.kind] || 0) + 1, a), {});
        const kindStr = Object.entries(kinds).map(([k,v]) => `${k}=${v}`).join('/');
        const r = scan.rejected || {};
        const rejStr = Object.entries(r).filter(([,v]) => v > 0).map(([k,v]) => `${k}=${v}`).join(', ');
        const capStr = listCapDropped > 0 ? `, list-cap-dropped=${listCapDropped}` : '';
        const scStr  = navShortcircuited > 0 ? `, nav-shortcircuit=${navShortcircuited}` : '';
        const destrStr = scan.destructiveFlagged > 0 ? `  destructive-clicking=${scan.destructiveFlagged} (wire-guarded)` : '';
        log(`[w${workerId}]   elements=${scan.totalElements} [${kindStr}]  candidates=${candidates.length} (page-dedup=${pageDedup}, path-skip=${pathSkipped}${capStr}${scStr}, rejected: ${rejStr || 'none'})  clicking=${clicks.length}${destrStr}${metaItems.length ? `  edit/toggle/expand=${metaItems.length}` : ''}`);
      }

      // ── click loop ────────────────────────────────────────────────────
      //
      // PERF — the click cycle USED to be ~12s/click because of two
      // wasteful waits:
      //
      //   1. `waitForLoadState('networkidle', 4000)` waits for 500ms of
      //      zero network. SPAs with WebSocket heartbeats / telemetry /
      //      polling NEVER reach that → ate the 4s timeout EVERY click.
      //      Replaced with a smart "wait for URL change OR 500ms" race.
      //   2. `waitForTimeout(600)` blind sleep post-click. Replaced with
      //      a state-aware check (URL change first, then bounded settle).
      //
      // The trap to avoid: a too-short post-click wait (e.g. 250ms) reads
      // page.url() BEFORE React has updated location.href, so every nav
      // click looks like a no-op and 99% of edges vanish. The race below
      // returns instantly on real navs (URL change is synchronous-ish in
      // Playwright) but still gives a 500ms settle for state-only clicks.
      //
      // POST_NAV_WAIT_MS (default 500 in crawl.mjs) is used for the FULL
      // page-visit settle at the top of this function.
      const POST_CLICK_NAV_TIMEOUT_MS = 2000;   // max wait for URL change
      const POST_CLICK_STATE_SETTLE_MS = 400;   // DOM-mutation settle when no nav happens
      const POST_REGOTO_SETTLE_MS = 400;

      let domDirty = false;
      for (const c of clicks) {
        if (state.isBudgetExhausted()) break;

        const display = c.label || c.testid || c.idAttr || c.href || `<idx:${c.domIndex}>`;
        try {
          if (domDirty) {
            await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
            await page.waitForLoadState('load', { timeout: 2_000 }).catch(() => {});
            await page.waitForTimeout(POST_REGOTO_SETTLE_MS);
            domDirty = false;
          }
          const before = page.url();
          const sigBefore = await domSignature(page);
          const loc = clickableLocator(page, c);
          // Pull the element into the viewport first. Apps using virtual
          // scrollers (Radix Virtual, React-Window, TanStack-Table, …)
          // only render rows that are visible — an off-screen row exists
          // in the DOM enough for our scanner to see it via querySelectorAll
          // but FAILS Playwright's strict isVisible check. scrollIntoView
          // mounts it before we look.
          await loc.scrollIntoViewIfNeeded({ timeout: 500 }).catch(() => {});
          if (!(await loc.isVisible({ timeout: 500 }).catch(() => false))) continue;

          // ── Row-click target fix ────────────────────────────────────────
          // shadcn / TanStack / Radix DataTable rows wire their "open
          // detail" navigation onto the title cell (or bubble it up from a
          // content cell) — NOT uniformly across the whole <tr>. Playwright's
          // default .click() hits the element's geometric CENTER, which on a
          // wide row lands on a numeric / badge / icon cell that has no click
          // handler. The click is silently swallowed, the URL never changes,
          // and the row→detail drill-down is recorded as a no-op (or a stray
          // state change) instead of a NEW page. That's why a whole app's
          // detail pages can go undiscovered.
          //
          // When the candidate is a table/grid row, click the FIRST cell that
          // actually has text (the title column) rather than the row center.
          // Proven to fire navigation on console-preview /endpoints; on
          // non-navigational tables (inline-edit rows) it's a harmless click
          // that behaves the same as before.
          let clickLoc = loc;
          const rowLike = c.tag === 'tr' || c.role === 'row'
            || /(?:>\s*tbody[^>]*>\s*tr\b|\[role=["']?row["']?\])/i.test(c.selector || '');
          if (rowLike) {
            const cell = loc
              .locator(':scope > td, :scope > th, :scope > [role="gridcell"], :scope > [role="cell"]')
              .filter({ hasText: /\S/ }).first();
            if (await cell.count().catch(() => 0)) clickLoc = cell;
          }
          log(`[w${workerId}]     click [${c.kind}]: "${display}"  (${c.key})${clickLoc !== loc ? ' [row→first-cell]' : ''}`);
          await clickLoc.click({ timeout: 3_000 });
          // Smart post-click waiter — corrected race semantics:
          //
          //   1. Try `waitForURL` with a generous 2s timeout. SPAs need
          //      time to call History.pushState; on console-preview it
          //      can take 800-1500ms after the click.
          //   2. If the URL DID change, navHappened=true, fast continue.
          //   3. If the URL didn't change (waitForURL timed out), it was
          //      a state/no-op click — give the DOM 400ms to mutate so
          //      domSignature catches it.
          //
          // Previous version used Promise.race against a 500ms timer
          // that ALWAYS won — so every nav click <500ms was correctly
          // classified, but every nav 500ms–1500ms was MIS-classified as
          // a state change (since page.url() at 500ms still read the old
          // URL on slow SPAs). This was wrecking the discovery edge.
          const navHappened = await page
            .waitForURL(u => u.toString() !== before, { timeout: POST_CLICK_NAV_TIMEOUT_MS })
            .then(() => true).catch(() => false);
          if (!navHappened) await page.waitForTimeout(POST_CLICK_STATE_SETTLE_MS);
          const after = page.url();
          const hadNav = after !== before;
          const sigAfter = hadNav ? null : await domSignature(page);
          const stateChange = !hadNav && stateChanged(sigBefore, sigAfter);

          if (hadNav) {
            const sameOriginNav = !sameOrigin || (() => {
              try { return new URL(after).origin === sameOrigin; } catch { return false; }
            })();
            // Strip OAuth callback fragments (#state=…&session_state=…&code=…)
            // so the same route isn't queued N times with varying hashes.
            const cleanedAfter = after.replace(/#(?=.*(?:state|session_state|code|iss)=)[^#]*$/, '');
            state.addEdge({ from: url, button: display, key: c.key, to: cleanedAfter, hadNav: true, kind: 'nav', depth, originalKind: c.kind });
            edgeKeysAdded.push(c.key);
            if (sameOriginNav && !state.interactedUrls.has(cleanedAfter)) {
              if (state.enqueue({ url: cleanedAfter, depth: depth + 1, phase: 'interact-discovery', parentUrl: url })) {
                state.markDiscovered(cleanedAfter);
                if (recordPage) {
                  try { await recordPage(page, display, 0, 'interact-discovery', { sourceUrl: url, viaButton: display, viaKey: c.key, workerId }); } catch {}
                }
                log(`[w${workerId}]       ↳ NEW page discovered: ${cleanedAfter}  (queued at depth ${depth + 1})`);
              }
            } else if (!sameOriginNav) {
              if (idpRegex && idpRegex.test(cleanedAfter)) {
                state.recordIssue({ type: 'sso-redirect', workerId, url, message: `"${display}" → ${cleanedAfter.slice(0, 120)} (IdP; not queued — add its label to EXCLUDE_SSO_PROVIDERS)` });
                log(`[w${workerId}]       ↳ ⚠ click landed on an external IdP (not queued): ${cleanedAfter}`);
              } else {
                log(`[w${workerId}]       ↳ cross-origin nav (not queued): ${cleanedAfter}`);
              }
            }
            // Re-baseline this worker on the original task URL so the
            // next click in the loop starts from the right page. Content-
            // based wait (same reasoning as the page-visit settle above):
            // give React time to remount the route AND its table data
            // before the next scan.
            await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
            await page.waitForLoadState('load', { timeout: 2_000 }).catch(() => {});
            await page.waitForFunction(
              () => !!(document.body && document.body.innerText && document.body.innerText.length > 200),
              { timeout: 4_000 }
            ).catch(() => {});
            await page.waitForFunction(tableReady, { timeout: 10_000, polling: 250 }).catch(() => {});
            await page.waitForTimeout(POST_REGOTO_SETTLE_MS);
            domDirty = false;
          } else if (stateChange) {
            const stateNode = `${url}#${c.key}`;
            state.addStateNode(stateNode);
            state.addEdge({ from: url, button: display, key: c.key, to: stateNode, hadNav: false, kind: 'state', depth, originalKind: c.kind });
            edgeKeysAdded.push(c.key);
            log(`[w${workerId}]       ↳ state change → ${stateNode}`);
            // Press Escape to close any modal/dropdown the click opened.
            // After Escape the page should be back at baseline, so we
            // DO NOT set domDirty — re-going-to would invalidate every
            // remaining candidate's cached locator (React component-lib
            // IDs regenerate on every render).
            await page.keyboard.press('Escape').catch(() => {});
          } else {
            // No-op click — DOM didn't change, page is still valid,
            // remaining candidates' locators still resolve. Don't dirty.
          }
        } catch (e) {
          // A crashed page fails every remaining click instantly — escalate to
          // the task-level handler (recreate + requeue) instead of burning
          // through the click list against a corpse.
          if (isDeadPage(page, e)) throw e;
          log(`[w${workerId}]     click failed: "${display}" — ${e.message.split('\n')[0].slice(0, 80)}`);
          state.recordIssue({ type: 'click-failed', workerId, url, message: `${display}: ${e.message}` });
          domDirty = true;
        }
      }

      // Snapshot the page (forms, buttons, links — for downstream
      // generators). Best-effort: errors don't break the walker.
      if (recordPage) {
        try { await recordPage(page, url, depth, phase, { workerId }); } catch {}
      }

      // Report this sample's novelty — feeds the per-template saturation
      // gate in tryDequeue. Late-landing async responses may credit an API
      // to the NEXT sample of the same template; acceptable — it only
      // delays saturation by one sample, never causes a false saturation.
      const novel = state.recordSample(url, {
        shapeHash,
        edgeKeys: edgeKeysAdded,
        newApis: apiNoveltyFor ? (apiNoveltyFor(url) || 0) : 0,
      });
      if (!novel) log(`[w${workerId}]   sample dry (no novelty for template)`);
    } catch (e) {
      const dead = isDeadPage(page, e);

      // Connection-level failure (VPN drop, target restart, DNS death) — the
      // page never answered, so this is not the task's fault. Requeue WITHOUT
      // charging an attempt and feed the outage detector; when enough of
      // these land in a short window the frontier pauses (see loop top)
      // instead of retry-burning every queued route against a dead link.
      if (!dead && NETWORK_ERR_RE.test(e.message || '')) {
        log(`[w${workerId}] network error on ${url} — ${e.message.split('\n')[0].slice(0, 100)}`);
        state.recordIssue({ type: 'network-error', workerId, url, message: e.message });
        state.requeueNoCharge(task);
        if (state.reportNetworkError()) {
          log(`[w${workerId}] network outage detected — frontier paused until the origin answers again`);
        }
        continue;
      }

      log(`[w${workerId}] task failed: ${url} — ${e.message.split('\n')[0].slice(0, 120)}`);
      state.recordIssue({ type: dead ? 'page-crashed' : 'task-failed', workerId, url, message: e.message });

      // Give the task another chance — it never actually got crawled.
      if (state.requeue(task)) {
        log(`[w${workerId}] requeued ${url} (attempt ${(task.attempts ?? 1) + 1}/${state.maxTaskAttempts})`);
      } else {
        state.recordIssue({ type: 'task-abandoned', workerId, url, message: `gave up after ${state.maxTaskAttempts} attempts` });
        log(`[w${workerId}] abandoned ${url} after ${state.maxTaskAttempts} attempts`);
      }

      // A dead page poisons every later goto — replace it before the next
      // task. If we can't get a fresh page, exit rather than consume the
      // remaining queue with instant failures (siblings keep draining it).
      if (dead) {
        if (!recreatePage) {
          log(`[w${workerId}] page dead and no recreatePage available — exiting`);
          state.recordIssue({ type: 'worker-dead', workerId, url, message: 'page crashed; recreation unavailable' });
          break;
        }
        try {
          page = await recreatePage(workerId);
          state.recordIssue({ type: 'page-recreated', workerId, url, message: 'fresh context after crash' });
          log(`[w${workerId}] recreated page after crash — resuming`);
        } catch (err) {
          log(`[w${workerId}] page recreation failed (${err.message.split('\n')[0].slice(0, 80)}) — exiting`);
          state.recordIssue({ type: 'worker-dead', workerId, url, message: `recreation failed: ${err.message}` });
          break;
        }
      }
    }
  }

  if (myActive) { state.endWork(); myActive = false; }
  log(`[w${workerId}] exit (budget=${state.isBudgetExhausted() || 'idle'})`);
}
