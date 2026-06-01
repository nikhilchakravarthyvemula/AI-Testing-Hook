// auth-detect handler — "what kind of auth is this page, and what should we do?"
//
// Replaces the brittle "find a Sign in button" heuristic. Today's crawl
// failed on logtrim's /register page because the heuristic fired but
// the button doesn't exist there. The LLM sees the page semantically
// (registration form ≠ login form) and tells the crawler to skip the
// login attempt instead of timing out.

// ── enums (validated against LLM output) ──────────────────────────────────

export const AUTH_TYPES = Object.freeze([
  'normal_login',     // email/password form, just submit
  'sso_redirect',     // multi-step flow via an identity provider
  'registration',     // signup form — never auto-submit
  'mfa',              // one-time code — can't auto-solve
  'password_reset',   // reset flow — skip
  'not_auth',         // page isn't actually an auth page
]);

export const AUTH_ACTIONS = Object.freeze([
  'fill_creds',          // normal flow: fill the known email/password and submit
  'click_sso_button',    // multi-step SSO; follow `steps`
  'skip',                // don't try to authenticate here
  'log_and_continue',    // log the situation, navigate away
]);


// ── prompt ────────────────────────────────────────────────────────────────

export const temperature = 0;
export const maxTokens   = 1024;
export const timeoutMs   = 25_000;

const SYSTEM_PROMPT = (
  'You classify auth pages for a web crawler. The crawler has a known ' +
  'email/password credential. For each page you see, decide:\n' +
  '  1. What KIND of auth flow is this (or none)?\n' +
  '  2. What ACTION should the crawler take?\n' +
  '  3. (For SSO) what STEPS does the crawler execute?\n\n' +
  'Reply with valid JSON only — no prose, no <think>, no Markdown fences. ' +
  'Follow the schema exactly.'
);

const SCHEMA_HINT = `{
  "type": "normal_login" | "sso_redirect" | "registration" | "mfa" | "password_reset" | "not_auth",
  "action": "fill_creds" | "click_sso_button" | "skip" | "log_and_continue",
  "confidence": 0.0..1.0,
  "reasoning": "<one short sentence>",
  "steps": [
    // empty array for normal_login; for sso_redirect a sequence of:
    { "op": "click", "selector": "<CSS or text>"},
    { "op": "fill",  "selector": "<CSS>", "valueSource": "creds.email" | "creds.password" },
    { "op": "wait",  "for": "navigation" | "selector:<sel>" }
  ]
}`;


export function buildMessages(input) {
  const { url, title, dom } = input;
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content:
        `URL: ${url}\nTitle: ${title ?? '(none)'}\n\n` +
        `Page DOM excerpt (truncated, focused on forms/buttons/headings):\n` +
        `\`\`\`html\n${truncate(dom ?? '', 4_000)}\n\`\`\`\n\n` +
        `Respond with JSON exactly matching this schema:\n\`\`\`\n${SCHEMA_HINT}\n\`\`\``,
    },
  ];
}


// ── validation ────────────────────────────────────────────────────────────

// Per-type action policy — we enforce this regardless of what the LLM
// returns. The LLM tends to suggest fill_creds even for registration
// pages ("the crawler has credentials, so use them") which would happily
// submit the signup form. Treat type as authoritative; ignore the LLM's
// action when it conflicts.
const FORCED_ACTION_BY_TYPE = Object.freeze({
  normal_login:   'fill_creds',
  sso_redirect:   'click_sso_button',
  registration:   'skip',
  mfa:            'log_and_continue',
  password_reset: 'skip',
  not_auth:       'skip',
});

export function validate(raw) {
  if (typeof raw !== 'object' || !raw) return { ok: false, reason: 'not-an-object' };
  if (!AUTH_TYPES.includes(raw.type))   return { ok: false, reason: `type=${raw.type}` };

  // Steps optional except for sso_redirect.
  const steps = Array.isArray(raw.steps) ? raw.steps : [];
  if (raw.type === 'sso_redirect' && steps.length === 0) {
    return { ok: false, reason: 'sso_redirect must have steps' };
  }
  const validatedSteps = [];
  for (const s of steps) {
    if (!s || typeof s !== 'object') continue;
    const op = String(s.op || '').toLowerCase();
    if (!['click', 'fill', 'wait'].includes(op)) continue;
    validatedSteps.push({
      op,
      selector: typeof s.selector === 'string' ? s.selector : undefined,
      valueSource: typeof s.valueSource === 'string' ? s.valueSource : undefined,
      for: typeof s.for === 'string' ? s.for : undefined,
    });
  }

  const forcedAction = FORCED_ACTION_BY_TYPE[raw.type];
  const llmAction = AUTH_ACTIONS.includes(raw.action) ? raw.action : null;
  const action = forcedAction ?? llmAction ?? 'skip';
  const correctedFromLlm = llmAction && llmAction !== forcedAction
    ? ` (overrode LLM action=${llmAction} → ${forcedAction})`
    : '';

  return {
    ok: true,
    value: {
      type:       raw.type,
      action,
      confidence: typeof raw.confidence === 'number' ? clamp01(raw.confidence) : 0.5,
      reasoning:  (typeof raw.reasoning === 'string' ? raw.reasoning.slice(0, 240) : '') + correctedFromLlm,
      steps:      validatedSteps,
    },
  };
}


// ── tiny helpers ──────────────────────────────────────────────────────────

function truncate(s, n) {
  if (typeof s !== 'string') return '';
  return s.length > n ? s.slice(0, n - 20) + '…[truncated]' : s;
}

function clamp01(n) {
  return Math.max(0, Math.min(1, n));
}
