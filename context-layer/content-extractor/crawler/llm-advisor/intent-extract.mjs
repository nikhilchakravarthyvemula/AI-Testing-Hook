// intent-extract handler — annotate every clickable on a page with semantic intent.
//
// One LLM call per page (batches all clickables together). The output
// is merged back into the crawler bundle so the indexer can build the
// click-graph (page -> clickable -> intent -> destination).

export const temperature = 0;
export const maxTokens   = 4096;
// MiniMax-M2.7 with strict-JSON output takes ~25-45s per ~15-clickable batch.
// 60s covers that with headroom; the old 120s mostly just made stuck calls
// waste 2 min each (the caller now runs batches concurrently, so a slow batch
// no longer blocks the rest).
export const timeoutMs   = 60_000;

export const CATEGORIES = Object.freeze([
  'navigation',
  'mutation',
  'form_submit',
  'external',
  'noop',
  'unknown',
]);


// ── prompt ────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = (
  'You annotate clickable elements with semantic intent. The crawler ' +
  'gives you a numbered list of buttons and links from one page; you ' +
  'return, for each `i`, what that element does.\n\n' +
  'Inferring intent: combine the visible text, the URL the element ' +
  'points to (for links), the surrounding context, and common-sense ' +
  'web conventions. When ambiguous, return category="unknown" and ' +
  'a low confidence — do NOT invent specific intents you can\'t justify.\n\n' +
  'Reply with valid JSON only — no prose, no <think>, no Markdown fences.'
);

const SCHEMA_HINT = `{
  "intents": [
    {
      "i": 1,                                // 1-based index matching input
      "intent": "kebab-case-short-id",       // e.g. "delete-user", "view-orders"
      "category": "navigation" | "mutation" | "form_submit" | "external" | "noop" | "unknown",
      "destructive": true | false,            // mutation that loses data → true
      "expectedApiCall": "METHOD /path" | null, // best guess of the API hit, else null
      "expectedDestination": "/url-pattern" | "external" | null,
      "humanLabel": "<short imperative phrase>",
      "safeToClick": true | false,            // false if it would damage data, log user out, etc.
      "confidence": 0.0..1.0
    },
    …  // one entry per input element, in order
  ]
}`;


export function buildMessages(input) {
  const { url, title, clickables, contextSnippet } = input;
  // Number each clickable. Buttons and links share a single sequence so the
  // LLM's response array maps 1-to-1 onto the inputs.
  const numbered = (clickables ?? []).map((c, idx) => ({
    i: idx + 1,
    kind: c.kind,
    text: truncate(c.text ?? '', 80),
    href: c.href ?? null,
    selector: c.selector ?? null,
  }));

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content:
        `Page URL:   ${url}\nPage title: ${title ?? '(none)'}\n` +
        `Page kind:  ${input.section ?? '(unknown section)'}\n\n` +
        (contextSnippet
          // Tight context — every extra K of prompt slows MiniMax-M2.7
          // by ~5s, and the clickables JSON below carries the real signal.
          ? `Context excerpt:\n${truncate(contextSnippet, 400)}\n\n`
          : '') +
        `Clickables (${numbered.length}):\n` +
        `\`\`\`json\n${JSON.stringify(numbered, null, 2)}\n\`\`\`\n\n` +
        `Return intents (one entry per input, in order):\n` +
        `\`\`\`\n${SCHEMA_HINT}\n\`\`\``,
    },
  ];
}


// ── validation ────────────────────────────────────────────────────────────

export function validate(raw) {
  if (typeof raw !== 'object' || !raw)        return { ok: false, reason: 'not-an-object' };
  if (!Array.isArray(raw.intents))            return { ok: false, reason: 'intents not array' };

  const validated = [];
  for (const item of raw.intents) {
    if (!item || typeof item !== 'object') continue;
    const i = Number(item.i);
    if (!Number.isInteger(i) || i < 1) continue;
    const cat = String(item.category ?? 'unknown').toLowerCase();
    validated.push({
      i,
      intent:              typeof item.intent === 'string' ? item.intent.slice(0, 80) : 'unknown',
      category:            CATEGORIES.includes(cat) ? cat : 'unknown',
      destructive:         Boolean(item.destructive),
      expectedApiCall:     typeof item.expectedApiCall === 'string' ? item.expectedApiCall.slice(0, 200) : null,
      expectedDestination: typeof item.expectedDestination === 'string' ? item.expectedDestination.slice(0, 200) : null,
      humanLabel:          typeof item.humanLabel === 'string' ? item.humanLabel.slice(0, 160) : '',
      safeToClick:         item.safeToClick !== false,   // default to safe unless explicit false
      confidence:          typeof item.confidence === 'number' ? clamp01(item.confidence) : 0.5,
    });
  }
  if (validated.length === 0) return { ok: false, reason: 'no valid intent entries' };
  return { ok: true, value: { intents: validated } };
}


// ── helpers ────────────────────────────────────────────────────────────────

function truncate(s, n) {
  if (typeof s !== 'string') return '';
  return s.length > n ? s.slice(0, n - 5) + '…' : s;
}

function clamp01(n) { return Math.max(0, Math.min(1, n)); }
