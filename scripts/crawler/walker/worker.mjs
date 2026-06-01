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

// Default per-list cap. When a page exposes a table / list of N similar
// rows (each row navigates to /resource/detail?id=…), clicking every row
// is wasteful — 5 samples are enough to characterize the route shape.
// Tables are detected by URL pathname: items sharing the same pathname
// (regardless of query) form a group. Set MAX_LIST_ITEMS_PER_NAV=Infinity
// to opt out.
// Default: pick at most 3 sibling clickables per "list group". Applies to
// both `nav` candidates (grouped by URL pathname) and `click` candidates
// (grouped by structural CSS-path signature). So a 100-row inventory
// table fires 3 sample clicks, not 100 — and the sidebar (each link a
// different pathname) is unaffected because the pathname-based group is
// 1 item each.
const DEFAULT_MAX_LIST_ITEMS = (() => {
  const v = process.env.MAX_LIST_ITEMS_PER_NAV;
  if (v == null || v === '' || v === 'infinity' || v === 'Infinity') return 3;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 3;
})();

export async function runWorker(opts) {
  const {
    workerId,
    state,
    page,
    sameOrigin,
    safeRe,
    destrRe,
    maxClicksPerPage = Infinity,
    maxListItemsPerNav = DEFAULT_MAX_LIST_ITEMS,
    postNavWaitMs = 1500,
    log = (() => {}),
    recordPage,   // optional: (page, label, depth, phase, extras) => Promise
    reAuth,       // optional: (page) => Promise<void>  — called on /login redirect
    scannerFn = DEFAULT_SCANNER,   // (page, opts) => { items, totalElements, rejected }
  } = opts;

  let myActive = false;
  let idleSince = null;

  while (!state.isBudgetExhausted()) {
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
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
        .catch(e => { log(`[w${workerId}] nav failed: ${e.message}`); state.recordIssue({ type: 'nav-failed', workerId, url, message: e.message }); });
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
          // process.cwd() is scripts/crawler/ when invoked via the
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
        await reAuth(page).catch(e => { log(`[w${workerId}] re-auth failed: ${e.message}`); state.recordIssue({ type: 're-auth-failed', workerId, url, message: e.message }); });
        await page.waitForLoadState('load', { timeout: 4_000 }).catch(() => {});
      }

      // ── scan ──────────────────────────────────────────────────────────
      // scannerFn defaults to the heuristic scanInteractables. The LLM-
      // primary walker overrides it with a scanner that asks an LLM what
      // to click and then verifies the suggestions against the DOM.
      const scan = await scannerFn(page, { safeRe, destrRe, sameOrigin, log });

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
      //   nav items   → grouped by URL pathname (no query). Catches
      //                 anchor-style table rows that all go to
      //                 `/inventory/detail?id=X` etc.
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
          let pathKey;
          try { pathKey = new URL(it.href, url).pathname; } catch { pathKey = it.href; }
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
        log(`[w${workerId}]   elements=${scan.totalElements} [${kindStr}]  candidates=${candidates.length} (page-dedup=${pageDedup}, path-skip=${pathSkipped}${capStr}${scStr}, rejected: ${rejStr || 'none'})  clicking=${clicks.length}${metaItems.length ? `  edit/toggle/expand=${metaItems.length}` : ''}`);
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
            if (sameOriginNav && !state.interactedUrls.has(cleanedAfter)) {
              if (state.enqueue({ url: cleanedAfter, depth: depth + 1, phase: 'interact-discovery', parentUrl: url })) {
                state.markDiscovered(cleanedAfter);
                if (recordPage) {
                  try { await recordPage(page, display, 0, 'interact-discovery', { sourceUrl: url, viaButton: display, viaKey: c.key, workerId }); } catch {}
                }
                log(`[w${workerId}]       ↳ NEW page discovered: ${cleanedAfter}  (queued at depth ${depth + 1})`);
              }
            } else if (!sameOriginNav) {
              log(`[w${workerId}]       ↳ cross-origin nav (not queued): ${cleanedAfter}`);
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
    } catch (e) {
      log(`[w${workerId}] task failed: ${url} — ${e.message.split('\n')[0].slice(0, 120)}`);
      state.recordIssue({ type: 'task-failed', workerId, url, message: e.message });
    }
  }

  if (myActive) { state.endWork(); myActive = false; }
  log(`[w${workerId}] exit (budget=${state.isBudgetExhausted() || 'idle'})`);
}
