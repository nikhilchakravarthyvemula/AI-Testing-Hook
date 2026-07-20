// Deterministic, fail-safe mutation flagging (p0-05 §2).
//
// `mutation: true` decides whether a scenario is allowed to write to the target
// app — the executor enforces safe mode from it (p0-00 §6, §9). Because it is
// load-bearing for safety, it is computed HERE, in code, from the scenario's
// resolved targets and text. The LLM's own opinion is recorded on the scenario
// (`mutationOpinion`) but NEVER consulted for the flag. Unknown ⇒ true.
//
// The rule (any one is sufficient):
//   1. a target endpoint's HTTP method is not a read method (GET/HEAD/OPTIONS);
//   2. the title or intent matches the mutation lexicon;
//   3. target resolution is uncertain — an endpoint target whose method we
//      cannot parse. A scenario we can't reason about defaults to unsafe.

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Verbs that describe changing server state. Deliberately broad: the cost of a
// false positive is a scenario the operator must opt into, which is cheap; the
// cost of a false negative is an unintended write to a live app, which is not.
const MUTATION_LEXICON =
  /\b(create|creates|submit|submits|update|updates|delete|deletes|write|writes|upload|uploads|register|registers|post|posts|put|puts|patch|patches|remove|removes|save|saves|add|adds|edit|edits|insert|inserts|modif(?:y|ies)|send|sends|purchase|checkout|pay|pays|payment|sign[ -]?up|sign[ -]?in|log[ -]?in|log[ -]?out|sign[ -]?out|deactivate|disable|enable|revoke|cancel|reset)\b/i;

/**
 * Parse the leading HTTP method from an endpoint target string, e.g.
 * "POST /api/v2/orders" → "POST". Returns null when there is no parseable
 * method — which the caller treats as "uncertain".
 */
export function endpointMethod(target) {
  const m = String(target).trim().match(/^([A-Za-z]+)\s+\S/);
  return m ? m[1].toUpperCase() : null;
}

/**
 * @param {object} sc  a scenario with { title, intent, targets:{endpoints?,pages?} }
 * @returns {boolean}   true iff the scenario may write to the target (fail-safe)
 */
export function isMutation(sc) {
  const { title = '', intent = '', targets = {} } = sc ?? {};
  const endpoints = Array.isArray(targets.endpoints) ? targets.endpoints : [];

  for (const ep of endpoints) {
    const method = endpointMethod(ep);
    if (method === null) return true;          // (3) unresolvable target → unsafe
    if (!READ_METHODS.has(method)) return true; // (1) writing method
  }

  if (MUTATION_LEXICON.test(`${title}\n${intent}`)) return true; // (2) intent

  return false;
}
