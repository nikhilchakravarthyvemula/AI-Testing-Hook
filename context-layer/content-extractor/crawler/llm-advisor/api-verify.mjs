// api-verify handler — verify the AUTHENTICITY of discovered API endpoints and
// repair/fill their request bodies, before the OpenAPI/test contract is finalized.
//
// The deterministic verifier (context-layer/indexer/verify/api-spec-verify.mjs)
// removes obvious phantom duplicates (stripped-prefix twins) and tiers evidence;
// it hands the LLM only the AMBIGUOUS endpoints plus body-verification work.
//
// For each endpoint the LLM is given framework-agnostic evidence:
//   - observed:  was it seen in live traffic (crawler / mock-data)?
//   - published: is it in the app's own published OpenAPI spec (ground truth)?
//   - codeOnly:  does it come only from static code analysis (AST)?
//   - siblings:  other endpoints sharing a path-suffix (helps spot duplicates)
//   - models:    candidate request-body field schemas (from code models)
//   - observedBody: a real captured request body, if any
// and returns, per endpoint: keep/drop + authenticity + a schema-valid request
// body example (synthesized from models when one is missing — fills the gaps).

export const temperature = 0;
export const maxTokens   = 4096;
// Reasoning model + strict JSON over a ~10-endpoint batch — 60s with headroom;
// the caller runs batches concurrently so a slow batch never blocks the rest.
export const timeoutMs   = 60_000;


const SYSTEM_PROMPT = (
  'You are an API spec auditor. You receive a batch of candidate HTTP ' +
  'endpoints discovered by mixing live crawling, a published OpenAPI spec, ' +
  'and static code analysis. Some are real; some are ARTIFACTS of code ' +
  'analysis — e.g. a framework router/blueprint route recorded WITHOUT its ' +
  'mount prefix (so `/users` instead of `/api/v1/users`), or a duplicate.\n\n' +
  'For each endpoint decide:\n' +
  '  1. keep — is this a REAL, callable endpoint? Trust this evidence order: ' +
  'published spec > observed live > code-only. A code-only endpoint whose ' +
  'path is just the tail of a real (observed/published) sibling is almost ' +
  'always a stripped-prefix artifact → keep=false.\n' +
  '  2. requestBody — for write methods (POST/PUT/PATCH), give a schema-valid ' +
  'example built from the candidate model fields + any observed body. If a ' +
  'real body was observed, prefer it. For GET/DELETE/HEAD use null.\n\n' +
  'Be conservative about dropping: only drop when the artifact signal is ' +
  'strong. Reply with valid JSON only — no prose, no <think>, no fences.'
);

const SCHEMA_HINT = `{
  "verdicts": [
    {
      "i": 1,                          // 1-based index matching input
      "keep": true | false,
      "authenticity": 0.0..1.0,        // confidence the endpoint is real + callable
      "reason": "<short why>",
      "requestBody": {                 // null for GET/DELETE/HEAD or when unknown
        "example": { ... } | null,     // a concrete, schema-valid body
        "contentType": "application/json"
      } | null
    }
    // one entry per input endpoint, in order
  ]
}`;


export function buildMessages(input) {
  const { endpoints, hasPublishedSpec } = input;
  const numbered = (endpoints ?? []).map((e, idx) => ({
    i: idx + 1,
    method: e.method,
    path: e.path,
    evidence: e.evidence,                 // { observed, published, codeOnly, sources }
    pathSuffixSiblings: e.siblings ?? [],  // longer real paths ending with this path
    authRequired: e.authRequired ?? null,
    existingBodyExample: e.existingBody ?? null,
    candidateModelFields: e.models ?? null,
    observedBody: e.observedBody ?? null,
  }));

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content:
        `Published OpenAPI spec available as ground truth: ${hasPublishedSpec ? 'YES' : 'no'}.\n` +
        `Candidate endpoints (${numbered.length}):\n` +
        `\`\`\`json\n${JSON.stringify(numbered, null, 2).slice(0, 12_000)}\n\`\`\`\n\n` +
        `Return one verdict per endpoint, in order:\n` +
        `\`\`\`\n${SCHEMA_HINT}\n\`\`\``,
    },
  ];
}


export function validate(raw) {
  if (typeof raw !== 'object' || !raw)     return { ok: false, reason: 'not-an-object' };
  if (!Array.isArray(raw.verdicts))        return { ok: false, reason: 'verdicts not array' };

  const validated = [];
  for (const v of raw.verdicts) {
    if (!v || typeof v !== 'object') continue;
    const i = Number(v.i);
    if (!Number.isInteger(i) || i < 1) continue;
    let body = null;
    if (v.requestBody && typeof v.requestBody === 'object' && v.requestBody.example != null) {
      body = {
        example: v.requestBody.example,
        contentType: typeof v.requestBody.contentType === 'string' ? v.requestBody.contentType : 'application/json',
      };
    }
    validated.push({
      i,
      keep:         v.keep !== false,                 // default keep unless explicit false
      authenticity: typeof v.authenticity === 'number' ? clamp01(v.authenticity) : 0.5,
      reason:       typeof v.reason === 'string' ? v.reason.slice(0, 200) : '',
      requestBody:  body,
    });
  }
  if (validated.length === 0) return { ok: false, reason: 'no valid verdict entries' };
  return { ok: true, value: { verdicts: validated } };
}


function clamp01(n) { return Math.max(0, Math.min(1, n)); }
