// The S2 residue — candidate near-duplicate endpoint pairs.
//
// The synthesizer merges facts by EXACT canonical key, which is why
// /users/{id} ≡ /users/:id already collapse into one fact. What it CANNOT
// collapse is a concrete observation against a templated one — e.g. the live
// crawl hit /agent/get-agent-by-name/Resume%20Analysis while the spec declares
// /agent/get-agent-by-name/{id}. Those are almost certainly one endpoint, but
// "Resume%20Analysis" isn't recognised as a path parameter, so they survive as
// two facts. That surviving set is the residue S2 resolves.
//
// The spec assumed the synthesizer emits this residue; it does not (facts.json
// has no candidate list, llmMatchCalls:0). So C3 computes it here, with a
// HIGH-PRECISION structural rule: a pair is a candidate only when one endpoint
// is a strict "instance of" the other — same shape, differing only where the
// template has a parameter and the other has a concrete value. This never pairs
// two genuinely different endpoints; it only surfaces concrete-vs-template (and
// param-rename) duplicates for the LLM to confirm.

const PARAM = /^\{.*\}$|^:.+/;

function isParam(seg) {
  return PARAM.test(seg);
}

function segments(pathTemplate) {
  return String(pathTemplate).split('/').filter(Boolean);
}

/**
 * Is `concrete` a strict concretization of `template`?
 *
 * True iff they have the same segment count, every LITERAL template segment
 * matches exactly, and at least one template PARAMETER segment lines up with a
 * concrete (non-parameter) value. Directional on purpose: /a/{id} is not an
 * instance of /{x}/b and vice-versa, so unrelated paths never pair.
 */
export function isInstanceOf(concrete, template) {
  const c = segments(concrete);
  const t = segments(template);
  if (c.length !== t.length) return false;

  let differ = false;
  for (let i = 0; i < t.length; i++) {
    if (isParam(t[i])) {
      // Template says "parameter here". If the other side has a concrete value,
      // that's the concretization we're looking for; if it's also a param, the
      // position is equivalent (param rename) — neither disqualifies.
      if (!isParam(c[i])) differ = true;
    } else {
      // Literal template segment must match exactly. (A param on the concrete
      // side where the template is literal fails this — good: the "concrete"
      // would be LESS specific, so it isn't an instance.)
      if (c[i] !== t[i]) return false;
    }
  }
  return differ;
}

/**
 * Find candidate near-duplicate pairs among endpoint facts.
 *
 * Bucketed by method + origin + segment count so it never compares paths that
 * can't possibly align; O(n²) only within a bucket. Returns
 * `[{ concrete, template }]` where each is the fact whose key is the concrete /
 * templated side — S2 then asks the engine to confirm they're the same endpoint.
 *
 * @param {Array} endpointFacts  facts with kind === 'endpoint' and a structured key
 */
export function candidatePairs(endpointFacts) {
  const buckets = new Map();
  for (const fact of endpointFacts) {
    const { method, originKey, pathTemplate } = fact.key ?? {};
    if (!method || !pathTemplate) continue;
    const bucketKey = `${method}::${originKey ?? ''}::${segments(pathTemplate).length}`;
    if (!buckets.has(bucketKey)) buckets.set(bucketKey, []);
    buckets.get(bucketKey).push(fact);
  }

  const pairs = [];
  for (const group of buckets.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i], b = group[j];
        const pa = a.key.pathTemplate, pb = b.key.pathTemplate;
        if (pa === pb) continue;                    // identical → already one fact
        if (isInstanceOf(pa, pb)) pairs.push({ concrete: a, template: b });
        else if (isInstanceOf(pb, pa)) pairs.push({ concrete: b, template: a });
      }
    }
  }
  return pairs;
}
