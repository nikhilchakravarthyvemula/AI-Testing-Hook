// walker/scanner.mjs
//
// Framework-agnostic detection of every interactable element on a page.
//
// Why this exists: the previous interact pass scanned only `button,
// [role=button]`. That dropped:
//   - `<a href>` anchors (Crawlee BFS handled those, but only in a
//     separate pass — never seen alongside buttons)
//   - `<div onclick>` / `<div role="link">` / framework-router buttons
//     that have no `onclick=` attribute (React/Vue/Svelte synthetic
//     events)
//   - Editable inputs / selects / textareas (needed for form-test gen)
//   - Toggles (switches, checkboxes, tabs) and details/summary expanders
//
// Three detection layers run in one `page.evaluate`:
//   1. Semantic selectors (a[href], button, input, select, ...)
//   2. ARIA interactive roles ([role=button], [role=link], ...)
//   3. Cursor-pointer heuristic over body (capped at 5000 nodes) — picks
//      up SPA-router buttons that look like a clickable div but have no
//      `onclick=` attribute.
//
// Each match is classified into exactly one `kind`:
//   nav    → recurses (changes URL)
//   click  → recurses (button-like; may produce nav or state)
//   edit   → metadata only (input/select/textarea/contenteditable)
//   toggle → metadata only (switch/checkbox/tab/radio/option)
//   expand → metadata only (summary/details)
//
// Returned shape:
//   {
//     totalElements: N,
//     items: [{
//       domIndex,        // scan-order index, stable within this scan
//       kind,            // 'nav'|'click'|'edit'|'toggle'|'expand'
//       tag,             // lowercase tagName
//       role,            // explicit aria role or null
//       text, label, signal,
//       testid, idAttr,
//       href,            // for kind:'nav' anchors
//       inputType,       // for kind:'edit'/'toggle'
//       cursorPointer,   // true if cursor heuristic added it
//       selector,        // CSS-path fallback for nth-of-type locator
//       rejected,        // null | 'destructive'|'invisible'|'disabled'|'inForm'
//     }],
//     rejected: { destructive, notSafe, inForm, disabled, invisible },
//   }
//
// Filtering rules (apply only to `nav` + `click`):
//   - destructive regex matched against the combined signal string
//   - disabled / invisible / inside <form>
// `edit`/`toggle`/`expand` are returned unfiltered (callers don't click
// them; they record them for downstream test/mock generation).

// ───────── stable-key + locator helpers ─────────────────────────────────

// Generated IDs from React component libraries (Radix UI, HeadlessUI,
// Reach UI, MUI, …) change on every re-render. Using them as keys means
// the locator goes stale the moment any state change re-renders the
// tree. cssPath survives re-renders as long as DOM structure stays the
// same. So we deliberately PREFER cssPath when the only ID we have is
// one of these generated patterns.
const GENERATED_ID_RE = /^(?:radix-|headlessui-|aria-|chakra-|reach-|tw-|css-|mui-|emotion-)/;

function isStableId(id) {
  return id && !GENERATED_ID_RE.test(id);
}

// Replace generated-ID fragments ANYWHERE in a selector/key string with the
// placeholder `{gen}`. Component libraries (Radix, HeadlessUI, MUI, …) mint a
// fresh ID on every render, so two renders of the SAME control carry different
// ids — any consumer that compares keys across page instances (the novelty
// sampler's template-level dedup) must normalize first, or one volatile id per
// page resets its dry streak forever (observed live 2026-08-17: /policies
// instances never saturated because of `sel:#radix-_r_*_` keys). Same prefix
// list as GENERATED_ID_RE — extend BOTH by editing that one regex.
const GEN_ID_ANYWHERE_RE = new RegExp(
  '#' + GENERATED_ID_RE.source.replace(/^\^/, '') + '[^\\s>.:#\\[]*',
  'g',
);
export function normalizeGeneratedIds(str) {
  return String(str).replace(GEN_ID_ANYWHERE_RE, '#{gen}');
}

// Pick the most stable selector available for a clickable. Order:
//   testid → stable-id → href → cssPath → label → DOM-index.
//
// IMPORTANT: cssPath (selector) is preferred OVER label. The selector is
// what makes per-row buttons distinguishable. If we used label first, a
// page with 16 user rows — each rendered as `<button>Admin</button>` —
// would collapse all 16 to a single key `label:admin` and only one row
// would ever get clicked. Using the structural cssPath means each row's
// button has its own key, and the downstream per-list-group cap (3
// samples per structural group) does the right kind of compression.
//
// Generated React IDs (radix-_r_X_, headlessui-*) are skipped because
// they're regenerated each render.
export function keyFor(item) {
  if (item.testid)             return `testid:${item.testid}`;
  if (isStableId(item.idAttr)) return `id:${item.idAttr}`;
  if (item.href)               return `href:${item.href}`;
  if (item.selector)           return `sel:${item.selector}`;
  if (item.label)              return `label:${item.label.toLowerCase()}`;
  return `idx:${item.domIndex}`;
}

function cssEsc(s) {
  return String(s).replace(/(["\\\]])/g, '\\$1');
}

// Resolve a Playwright Locator for a scanned item. Tries the strongest
// selector first, then falls back. The `selector` (CSS path) is the
// portable fallback that works for cursor-pointer divs and any tag.
//
// Generated component-library IDs (radix-_r_X_, headlessui-*) are
// SKIPPED here — they change on every re-render, so a Locator built
// from a cached one resolves to nothing right after the first state
// change on the page.
export function clickableLocator(page, item) {
  if (item.testid)             return page.locator(`[data-testid="${cssEsc(item.testid)}"]`).first();
  if (isStableId(item.idAttr)) return page.locator(`#${cssEsc(item.idAttr)}`).first();
  if (item.href)               return page.locator(`a[href="${cssEsc(item.href)}"]`).first();
  if (item.selector)           return page.locator(item.selector).first();
  if (item.label)              return page.locator(item.tag || 'button, [role="button"]', { hasText: item.label }).first();
  return page.locator(item.tag || 'button, [role="button"]').nth(item.domIndex);
}

// ───────── DOM signature (state-change detection) ───────────────────────
//
// Same cheap signature the previous interact pass used. Detects modal
// open/close, tab switch, panel expand — anything that mutates the DOM
// without a URL change.

export async function domSignature(page) {
  return page.evaluate(() => {
    const dialogs = document.querySelectorAll(
      '[role="dialog"], [aria-modal="true"], dialog[open], .modal.show, .modal.in'
    ).length;
    const nodes = document.querySelectorAll('*').length;
    const text  = (document.body && document.body.innerText || '').length;
    const url   = location.href;
    return { url, dialogs, nodes, textLen: text };
  }).catch(() => null);
}

export function stateChanged(a, b) {
  if (!a || !b) return false;
  if (a.dialogs !== b.dialogs) return true;
  if (a.nodes !== b.nodes) return true;
  if (Math.abs((a.textLen || 0) - (b.textLen || 0)) > 20) return true;
  return false;
}

// ───────── main scanner ────────────────────────────────────────────────

/**
 * Scan every interactable on the page.
 *
 * @param {import('playwright').Page} page
 * @param {Object} opts
 * @param {string} opts.safeRe          source of SAFE_CLICK_REGEX
 * @param {string} opts.destrRe         source of DESTRUCTIVE_CLICK_REGEX
 * @param {string} [opts.sameOrigin]    origin (https://host) — anchors with
 *                                      cross-origin hrefs are flagged so
 *                                      callers can choose not to recurse
 * @param {number} [opts.cursorWalkMax] cap for the cursor-pointer body walk
 *                                      (default 5000)
 * @returns {Promise<Object>}           {totalElements, items[], rejected}
 */
export async function scanInteractables(page, opts) {
  const { safeRe, destrRe, neverRe, sameOrigin = null, cursorWalkMax = 5000 } = opts || {};

  return page.evaluate(({ safeRe, destrRe, neverRe, sameOrigin, cursorWalkMax }) => {

    // ───── helpers (browser-side) ───────────────────────────────────────

    const safe  = safeRe  ? new RegExp(safeRe,  'i') : null;
    const destr = destrRe ? new RegExp(destrRe, 'i') : null;
    const never = neverRe ? new RegExp(neverRe, 'i') : null;

    // CSS path that uniquely locates an element by tag + nth-of-type chain.
    // Stops at the closest ancestor with an id (which Playwright resolves
    // directly). Cheap and stable as long as the DOM doesn't reflow.
    function cssPath(el) {
      const parts = [];
      let cur = el;
      while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
        if (cur.id) { parts.unshift(`#${CSS.escape(cur.id)}`); break; }
        const parent = cur.parentElement;
        if (!parent) { parts.unshift(cur.tagName.toLowerCase()); break; }
        const sibs = Array.from(parent.children).filter(s => s.tagName === cur.tagName);
        const idx = sibs.indexOf(cur) + 1;
        parts.unshift(`${cur.tagName.toLowerCase()}:nth-of-type(${idx})`);
        cur = parent;
      }
      return parts.join(' > ');
    }

    function readLabel(el) {
      const text    = (el.textContent || '').trim();
      const aria    = el.getAttribute('aria-label') || '';
      const title   = el.getAttribute('title') || '';
      const tip     = el.getAttribute('data-tooltip') || el.getAttribute('data-tip') || '';
      const tid     = el.getAttribute('data-testid') || el.getAttribute('data-test') || '';
      const idAttr  = el.getAttribute('id') || '';
      const cls     = el.getAttribute('class') || '';
      const svgTitle = el.querySelector?.('title')?.textContent?.trim() || '';
      const ph      = el.getAttribute('placeholder') || '';
      const name    = el.getAttribute('name') || '';
      // Full signal — kept around for logs / future heuristics.
      const signal = [text, aria, title, tip, svgTitle, tid, idAttr, cls, ph, name]
        .filter(Boolean).join(' ').trim();
      // USER-FACING signal — used by the destructive/safe regex tests.
      // Deliberately excludes `cls`, `idAttr`, `ph`, `name` because CSS
      // classes (`drop-shadow-sm`, `dropdown-trigger`, `disabled:opacity-50`)
      // and developer IDs trigger false positives on the destructive regex
      // for ordinary navigation anchors. We keep `tid` because data-testid
      // is commonly used to declare intent (`data-testid=delete-user-btn`).
      const userSignal = [text, aria, title, tip, svgTitle, tid]
        .filter(Boolean).join(' ').trim();
      const label = (text || aria || title || svgTitle || ph || name || tid || '').trim();
      return { text, aria, title, tid, idAttr, cls, svgTitle, ph, name, signal, userSignal, label };
    }

    function isVisible(el) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      return true;
    }

    // Same-origin check for anchors. Returns true if href resolves to the
    // same origin as the page (so worth recursing into).
    function isSameOrigin(href) {
      if (!href || !sameOrigin) return true;   // default: include all
      try {
        const u = new URL(href, location.href);
        return u.origin === sameOrigin;
      } catch { return false; }
    }

    // ───── layer 1 + 2: semantic + ARIA selectors ───────────────────────

    const SEMANTIC = [
      'a[href]', 'button',
      'input:not([type="hidden"])', 'select', 'textarea',
      'summary', 'details',
      '[contenteditable=""]', '[contenteditable="true"]',
      '[tabindex]:not([tabindex="-1"])',
      '[role="button"]', '[role="link"]', '[role="menuitem"]',
      '[role="tab"]', '[role="switch"]', '[role="checkbox"]',
      '[role="option"]', '[role="radio"]', '[role="combobox"]',
    ].join(', ');

    const semanticSet = new Set(document.querySelectorAll(SEMANTIC));

    // ───── layer 3: cursor:pointer heuristic ────────────────────────────
    //
    // Walk the body (capped) and add any element with cursor:pointer that
    // (a) has no interactive ancestor already in semanticSet AND
    // (b) satisfies at least one of:
    //     - explicit onclick (`el.onclick` / `onclick=`)
    //     - data-* hint (`data-click|action|nav|row|id|index|key`,
    //       `aria-rowindex`, …) — TanStack-Table / Radix DataTable /
    //       AG-Grid / TanStack-Virtual set these on every row
    //     - class-name hint (`btn|button|link|clickable|row|card|menu|
    //       tab|nav|item|cell|td|tr`)
    //     - has non-empty visible text >= 2 chars (catches plain
    //       `<div cursor=pointer>Build-mcp-app</div>` table rows that
    //       have no class hint at all — console-preview / shadcn /
    //       Mantine style)
    //
    // The "non-empty text" criterion is the killer for catching virtual
    // table rows. Cost: more decorative cursor:pointer elements get
    // captured, but those are then bounded by the per-list-group cap
    // (3 per same-structure group) in the worker.

    const cursorHints = /btn|button|link|clickable|row|card|menu|tab|nav|item|cell|\btd\b|\btr\b/i;
    const rowHints    = /\brow\b|\btr\b|\btablerow\b|datarow|listitem|grid-row|tanstack-row/i;
    const dataKeyHints = /click|action|nav|row|id|index|key|item|rowindex/i;
    const dataRowAttrRe = /^data-(row|rowid|row-id|row-index|rowindex|row-key|rowkey|item-id|itemid)$/i;
    const all = document.querySelectorAll('*');
    const cap = Math.min(all.length, cursorWalkMax);
    let cursorTruncated = false;
    if (all.length > cap) cursorTruncated = true;
    for (let i = 0; i < cap; i++) {
      const el = all[i];
      if (semanticSet.has(el)) continue;
      // Skip if any ancestor is already semantic (parent click handles it).
      let p = el.parentElement, hasInteractiveAncestor = false;
      while (p) {
        if (semanticSet.has(p)) { hasInteractiveAncestor = true; break; }
        p = p.parentElement;
      }
      if (hasInteractiveAncestor) continue;
      let cs;
      try { cs = getComputedStyle(el); } catch { continue; }
      const tag = (el.tagName || '').toLowerCase();
      const role = el.getAttribute('role');
      const cls = el.getAttribute('class') || '';
      const visibleText = (el.innerText || '').trim();
      // Row-like detection — independent of CSS cursor. shadcn / Mantine
      // default <tr> rows have onClick wired up via React but NO cursor:pointer
      // styling, so a strict cursor check would miss every inventory /
      // user / endpoint table row. We accept any of:
      //   - tag == tr  (HTML table row)
      //   - role == row  (ARIA grid row)
      //   - class contains row|tablerow|datarow|listitem|grid-row|tanstack-row
      //   - any data-row* attribute (TanStack / AG-Grid / Radix DataTable)
      //   - aria-rowindex / aria-colindex
      const isRowLike =
        tag === 'tr'
        || role === 'row' || role === 'gridcell' || role === 'listitem'
        || rowHints.test(cls)
        || el.hasAttribute('aria-rowindex') || el.hasAttribute('aria-colindex')
        || (el.getAttributeNames && el.getAttributeNames().some(a => dataRowAttrRe.test(a)));
      // Cursor:pointer required UNLESS the element is row-like (above) —
      // row-likeness substitutes for the visual cue.
      if (cs.cursor !== 'pointer' && !isRowLike) continue;
      const hasTextHint = visibleText.length >= 2 && visibleText.length <= 200;
      const hasAriaRowIndex = el.hasAttribute('aria-rowindex') || el.hasAttribute('aria-colindex');
      const hint = el.onclick !== null
        || el.hasAttribute('onclick')
        || hasAriaRowIndex
        || (el.dataset && Object.keys(el.dataset).some(k => dataKeyHints.test(k)))
        || cursorHints.test(cls)
        || isRowLike
        || hasTextHint;
      if (!hint) continue;
      // Row-likeness also requires non-empty text to weed out empty
      // structural rows (header/footer spacers, virtual placeholders).
      if (isRowLike && !hasTextHint) continue;
      semanticSet.add(el);
    }

    // ───── classify + filter ────────────────────────────────────────────

    const items = [];
    const rejected = { never: 0, notSafe: 0, inForm: 0, disabled: 0, invisible: 0 };
    let destructiveFlagged = 0;   // destructive controls we WILL click (wire-guard protects)
    let domIndex = 0;

    for (const el of semanticSet) {
      const tag  = (el.tagName || '').toLowerCase();
      const role = el.getAttribute('role') || null;
      const lab  = readLabel(el);
      const href = el.getAttribute && el.getAttribute('href') || '';
      const itype = (tag === 'input' && el.getAttribute('type')) || '';
      const cursorPointer = (() => {
        try { return getComputedStyle(el).cursor === 'pointer'; } catch { return false; }
      })();

      // Classify into kind. Order matters — first match wins.
      let kind;
      if (tag === 'a' && href)                               kind = 'nav';
      else if (role === 'link')                              kind = 'nav';
      else if (tag === 'button' || role === 'button')        kind = 'click';
      else if (tag === 'summary' || tag === 'details')       kind = 'expand';
      else if (tag === 'input') {
        if (['checkbox', 'radio'].includes(itype))           kind = 'toggle';
        else if (['submit', 'button', 'reset', 'image'].includes(itype)) kind = 'click';
        else                                                 kind = 'edit';
      }
      else if (tag === 'select' || tag === 'textarea')       kind = 'edit';
      else if (el.getAttribute('contenteditable') === '' || el.getAttribute('contenteditable') === 'true')
                                                             kind = 'edit';
      else if (['tab','switch','checkbox','radio','option','menuitem','combobox'].includes(role))
                                                             kind = 'toggle';
      else                                                   kind = 'click';   // cursor-pointer fallback

      const selector = cssPath(el);
      // Structural list-group key — selector with all `:nth-of-type(N)`
      // indices stripped. Two items with the same listGroupKey are
      // sibling repeats in a list/table/grid structure. Used by the
      // worker's per-list cap to keep at most N clicks per group, so
      // a 100-row inventory table only fires 3 sample clicks instead
      // of 100 (and the cap doesn't accidentally collapse the sidebar
      // because sidebar nav targets each have unique URLs, so they
      // get the URL-pathname cap, not this structural one).
      const listGroupKey = selector.replace(/:nth-of-type\(\d+\)/g, '');

      // Build the base item that we always emit (so edit/toggle/expand are
      // recorded as metadata even if they'd fail the click filters).
      const base = {
        domIndex: domIndex++,
        kind, tag, role,
        text:   lab.text.slice(0, 60),
        label:  lab.label.slice(0, 80),
        signal: lab.signal.slice(0, 120),
        testid: lab.tid || '',
        idAttr: lab.idAttr || '',
        href:   kind === 'nav' ? (href || '') : '',
        inputType: itype || '',
        placeholder: lab.ph || '',
        name: lab.name || '',
        cursorPointer,
        selector,
        listGroupKey,
        destructive: false,   // spec-15: flagged by the destructive-hint regex; still clicked
        rejected: null,
      };

      // Filtering applies only to nav + click (things we'd actually click).
      // Filters run against the USER-FACING signal (text + aria + title +
      // tooltip + svg-title + testid) — NOT the full signal that also
      // includes CSS class / id / placeholder. CSS class names like
      // `drop-shadow-sm`, `dropdown-trigger`, `disabled:opacity-50` would
      // otherwise trip the destructive regex on ordinary navigation links.
      if (kind === 'nav' || kind === 'click') {
        // spec-15 D2. NEVER set — skip regardless of the destructive hint. These
        // break the client session or redirect away (logout, account/org deletes),
        // so the wire-guard can't neutralize them. Checked FIRST + independently,
        // since a session-breaker ("Close organization") needn't match the
        // destructive-hint regex.
        if (never && lab.userSignal && never.test(lab.userSignal)) {
          rejected.never++; base.rejected = 'never-click';
          if (destr && destr.test(lab.userSignal)) base.destructive = true;
          items.push(base); continue;
        }
        // Destructive HINT — flag but still CLICK. The wire-level mutation guard
        // aborts any resulting PUT/PATCH/DELETE before it leaves the browser, and
        // we capture the blocked request as a test candidate.
        if (destr && lab.userSignal && destr.test(lab.userSignal)) {
          base.destructive = true;
          destructiveFlagged++;
        }
        // SAFE regex applied only when we have a label to test; pure icon
        // buttons with no signal fall through (we click them by index).
        if (safe && lab.label && !safe.test(lab.label) && !safe.test(lab.userSignal)) {
          rejected.notSafe++; base.rejected = 'notSafe'; items.push(base); continue;
        }
        if (el.closest && el.closest('form')) { rejected.inForm++; base.rejected = 'inForm'; items.push(base); continue; }
        if (el.disabled) { rejected.disabled++; base.rejected = 'disabled'; items.push(base); continue; }
        if (!isVisible(el)) { rejected.invisible++; base.rejected = 'invisible'; items.push(base); continue; }
        // Cross-origin anchors recorded but not selected as candidates.
        if (kind === 'nav' && href && !isSameOrigin(href)) { base.rejected = 'cross-origin'; items.push(base); continue; }
      }

      items.push(base);
    }

    return {
      totalElements: items.length,
      items,
      rejected,
      destructiveFlagged,
      cursorTruncated,
    };
  }, { safeRe, destrRe, neverRe, sameOrigin, cursorWalkMax }).catch(() => ({
    totalElements: 0, items: [], rejected: {}, destructiveFlagged: 0, cursorTruncated: false,
  }));
}

// Filter helper: return only items eligible for DFS recursion
// (nav + click, not rejected). Edit/toggle/expand are deliberately
// excluded — they're metadata, not branches.
export function selectClickable(items) {
  return items.filter(it => (it.kind === 'nav' || it.kind === 'click') && !it.rejected);
}

// Filter helper: the page-level interactables inventory for downstream
// form / mock-data generators. Drops `nav`/`click` (those live in the
// click-graph as edges).
export function selectInteractables(items) {
  return items.filter(it => ['edit', 'toggle', 'expand'].includes(it.kind));
}
