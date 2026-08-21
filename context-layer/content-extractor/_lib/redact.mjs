// Redaction registry — the one place secrets are scrubbed from anything
// human-readable (run logs, envelopes, error messages).
//
// Every component that comes into possession of a secret registers it here
// FIRST, before making any request with it. Anything that writes text a
// human might see pipes it through redact(). The registry holds the values
// only in process memory; it is never serialized.
//
// See docs/spec-17-knowledge-sources-and-context-layer.md §3.

const SECRETS = new Set();

/** Register a secret value so redact() can scrub it. No-op for short/empty
 *  strings — redacting 3-char fragments would shred normal text. */
export function registerSecret(value) {
  if (typeof value === 'string' && value.length >= 8) SECRETS.add(value);
}

/** Replace every registered secret (and its base64 form, which is what a
 *  Basic Authorization header actually contains) with a marker. */
export function redact(text) {
  if (typeof text !== 'string' || SECRETS.size === 0) return text;
  let out = text;
  for (const s of SECRETS) {
    out = out.split(s).join('•••redacted•••');
    const b64 = Buffer.from(s).toString('base64');
    if (b64.length >= 8) out = out.split(b64).join('•••redacted•••');
  }
  return out;
}

/** Deep-redact a JSON-serializable value (for envelopes). */
export function redactJSON(obj) {
  return JSON.parse(redact(JSON.stringify(obj)));
}
