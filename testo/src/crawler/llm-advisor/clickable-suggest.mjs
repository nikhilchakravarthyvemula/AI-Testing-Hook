// clickable-suggest handler — the LLM IS the primary scanner.
//
// Given a compressed snapshot of a page (URL, title, visible text grouped
// by region, plus a list of selectors the heuristic already found), the
// LLM returns a list of {selector, label, intent, kind} for elements
// worth clicking — explicitly including row-like elements in tables /
// virtual lists / card grids that pure-CSS heuristics miss on apps with
// custom markup.
//
// The walker takes these suggestions, verifies each selector exists in
// DOM (drops hallucinations), applies the destructive regex + per-list
// cap as guardrails, then clicks them.
//
// Used by `context-layer/content-extractor/crawler-llm/` as its primary scanner.

export const temperature = 0;
export const maxTokens   = 4096;
// Modest timeout — page snapshots are small and we want the walker to
// keep moving if the LLM is sluggish. The heuristic guardrail still
// provides obvious clickables if this times out.
export const timeoutMs   = 60_000;


// ── prompt ────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = (
  'You are a UI exploration planner for a web crawler. Given a snapshot ' +
  'of a single page, return the elements the crawler should click to ' +
  'fully explore the app from this page.\n\n' +
  'Rules:\n' +
  '1. Prioritise data-bearing rows (table rows, list items, asset cards) ' +
     'over chrome (sidebar nav, header buttons, toggle switches). The ' +
     'crawler already handles the chrome via deterministic heuristics — ' +
     'YOUR job is to find the rows / drill-down links that heuristics ' +
     'miss because of custom markup.\n' +
  '2. For repeated patterns (e.g. 100 inventory rows), return AT MOST 3 ' +
     'samples — the crawler caps groups anyway. Pick diverse samples ' +
     '(first, middle, last) so the resulting graph covers the variety.\n' +
  '3. Skip destructive actions (Delete, Sign Out, Cancel, Revoke, …). ' +
     'The crawler will reject them anyway but listing them wastes tokens.\n' +
  '4. Skip elements the heuristic-already-found list contains. Look for ' +
     'what is NEW that the heuristics missed.\n' +
  '5. Skip pure decoration (icons, badges, hover effects) — only suggest ' +
     'elements whose click would change the URL or meaningfully mutate ' +
     'the DOM (open a modal, load drill-down content, switch a tab).\n' +
  '6. For each suggestion provide an EXACT CSS selector the crawler can ' +
     'feed straight to Playwright. Prefer `[data-testid="..."]`, ' +
     '`#stable-id`, or a tight :nth-of-type chain. Avoid generated React ' +
     'ids (`#radix-_r_e_`, `#headlessui-…`) — they change every render.\n\n' +
  'Reply with valid JSON only — no prose, no <think>, no Markdown fences.'
);

const SCHEMA_HINT = `{
  "suggestions": [
    {
      "selector": "string",          // exact CSS selector
      "label":    "string",          // short human label, e.g. "Inventory row: Build-mcp-app"
      "kind":     "nav" | "click",   // nav = expected URL change; click = expected DOM change
      "intent":   "kebab-case-id",   // e.g. "view-asset-detail"
      "groupId":  "string|null"      // shared id for items that are siblings in a list
                                     // (so the crawler keeps groups together for capping)
    }
    // up to ~15 entries total — quality over quantity
  ]
}`;


export function buildMessages(input) {
  const {
    url,
    title,
    viewport,
    heuristicAlreadyFound = [],   // [{label, kind, selector}]  — what the deterministic scanner picked up
    visibleStructures   = [],     // [{kind:'table'|'list'|'grid', sample: {selectors:[...], texts:[...]}, totalCount}]
    bodyTextSample      = '',     // first 800 chars of body.innerText
  } = input;

  const heuristicSummary = heuristicAlreadyFound.length === 0
    ? '(none)'
    : heuristicAlreadyFound.slice(0, 30).map((c, i) =>
        `  ${i + 1}. [${c.kind || '?'}] "${(c.label || '').slice(0, 60)}"`
      ).join('\n')
        + (heuristicAlreadyFound.length > 30 ? `\n  … and ${heuristicAlreadyFound.length - 30} more` : '');

  const structureSummary = visibleStructures.length === 0
    ? '(none — no tables/lists/grids detected)'
    : visibleStructures.map((s, i) => {
        const rows = (s.sample?.texts || []).slice(0, 5).map((t, j) =>
          `      ${j + 1}. text: "${(t || '').slice(0, 80)}"  selector: ${s.sample.selectors[j] || '?'}`
        ).join('\n');
        return `  Structure ${i + 1}: ${s.kind} with ${s.totalCount} items\n${rows}`;
      }).join('\n');

  const USER_PROMPT = (
    `URL: ${url}\n` +
    `Title: ${title || '(none)'}\n` +
    `Viewport: ${viewport?.width || '?'}x${viewport?.height || '?'}\n\n` +
    `--- Elements the heuristic scanner already found (do NOT duplicate these) ---\n` +
    `${heuristicSummary}\n\n` +
    `--- Detected list / table / grid structures (these are what you should sample) ---\n` +
    `${structureSummary}\n\n` +
    `--- First 800 chars of body.innerText (for context) ---\n` +
    `${(bodyTextSample || '').slice(0, 800)}\n\n` +
    `--- Output schema ---\n` +
    `${SCHEMA_HINT}\n\n` +
    `Return JSON now.`
  );

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user',   content: USER_PROMPT  },
  ];
}


// ── output validator ──────────────────────────────────────────────────────

export function validate(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, reason: 'response is not an object' };
  }
  const sugg = parsed.suggestions;
  if (!Array.isArray(sugg)) {
    return { ok: false, reason: 'missing or non-array .suggestions' };
  }
  const cleaned = [];
  for (const s of sugg) {
    if (!s || typeof s !== 'object') continue;
    const selector = String(s.selector || '').trim();
    const label    = String(s.label    || '').trim().slice(0, 120);
    const kind     = (s.kind === 'nav' || s.kind === 'click') ? s.kind : 'click';
    const intent   = String(s.intent   || '').trim().slice(0, 80);
    const groupId  = s.groupId == null ? null : String(s.groupId).slice(0, 80);
    if (!selector) continue;
    // Reject obviously-bad selectors:
    if (selector.length > 400) continue;                       // far too long
    if (/^radix-|^headlessui-|^css-|#radix-|#headlessui-/.test(selector)) continue;  // generated ids
    cleaned.push({ selector, label, kind, intent, groupId });
  }
  if (cleaned.length === 0) {
    return { ok: false, reason: 'no usable suggestions after sanitisation' };
  }
  return { ok: true, value: { suggestions: cleaned } };
}
