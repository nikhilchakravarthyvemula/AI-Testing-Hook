// Strip <think>...</think> reasoning blocks from MiniMax-M2.7 responses.
//
// MiniMax-M2.7 is a reasoning model — its `content` field begins with
// `<think>…internal monologue…</think>` before the actual answer. We
// JSON-parse the answer, so anything before the first `{` must go.
//
// Mirrors the Python shim at scripts/graphify/with_minimax.py so both
// callers (crawler advisor here, graphify subprocess there) get clean
// JSON from the same model.

const THINK_BLOCK_RE = /<think>.*?<\/think>\s*/gs;
const OPEN_THINK_RE  = /<think>.*$/gs;   // unclosed (model hit max_tokens mid-think)

/** @param {string|null|undefined} content */
export function stripThink(content) {
  if (!content) return content;
  let out = content.replace(THINK_BLOCK_RE, '');
  out = out.replace(OPEN_THINK_RE, '');
  return out.trim();
}

/**
 * Try hard to extract the first JSON object from an LLM response.
 * Strips <think>, strips Markdown code fences, then locates the first
 * balanced `{…}` if there's chatter before/after.
 *
 * @param {string} content
 * @returns {object|null}  parsed JSON or null on any failure
 */
export function parseLooseJson(content) {
  if (!content) return null;
  let s = stripThink(content);

  // Strip ```json … ``` fences if the LLM wrapped the answer
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');

  // Fast path
  try { return JSON.parse(s); } catch { /* fall through */ }

  // Locate the first balanced top-level object — handles leading prose
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const candidate = s.slice(start, i + 1);
        try { return JSON.parse(candidate); } catch { return null; }
      }
    }
  }
  return null;
}
