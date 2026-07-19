// S2 — entity-resolution of the fuzzy residue (the one LLM touchpoint in C3).
//
// Deterministic canonicalization already merged the exact-key duplicates;
// residue.mjs found the structurally-plausible leftovers (concrete-vs-template).
// Here we ask the engine, once per pair, "are these actually the same endpoint?"
// and merge the confirmed ones — corroborating a fact that was previously seen
// only one way, which is the whole point (a single-source fact becomes a
// two-source fact, and its confidence rises accordingly).
//
// Failure is not fatal: if the engine is down or the budget is spent, the pairs
// simply stay unmerged, the affected facts are tagged s2:'skipped', and one
// degradation is recorded. The store still builds; the report discloses it.

import { complete } from '../../../infrastructure/model-api-connector/index.mjs';
import { combineConfidence } from '../../../knowledge-base/schema.mjs';

const S2_MAX_PAIRS = Number(process.env.S2_MAX_PAIRS || 50);
const S2_MERGE_MIN_CONFIDENCE = Number(process.env.S2_MERGE_MIN_CONFIDENCE || 0.7);

const S2_SCHEMA = {
  type: 'object',
  properties: {
    same: { type: 'boolean' },
    confidence: { type: 'number' },
  },
  required: ['same', 'confidence'],
  additionalProperties: false,
};

/**
 * Resolve the residue.
 *
 * @param {object} args
 * @param {Array}  args.facts       all facts (endpoints + others)
 * @param {Array}  args.pairs       candidate pairs from residue.candidatePairs
 * @param {object} args.engine      { workspace, provider, model, maxRequests }
 * @param {Function} [args.completeFn]  injected for tests; defaults to the real connector
 * @returns {{ facts, remap, merges, skipped, note, degraded }}
 *   facts    — post-merge fact list (merged-away concretes removed)
 *   remap    — { concreteFactId: templateFactId } for index rewriting
 *   merges   — number merged
 *   skipped  — number of pairs left unresolved (engine down / below threshold)
 *   degraded — [] or one { useCase, stage, reason, fallback }
 */
export async function resolveResidue({ facts, pairs, engine, completeFn = complete }) {
  const byId = new Map(facts.map((f) => [f.factId, f]));
  const remap = {};
  let merges = 0;
  let skipped = 0;
  const degraded = [];

  // Volume guard: a residue larger than the cap means blocking is too loose —
  // buy no more calls than the cap, and say so rather than silently truncating.
  const ranked = rankByImpact(pairs);
  const dropped = Math.max(0, ranked.length - S2_MAX_PAIRS);
  const work = ranked.slice(0, S2_MAX_PAIRS);

  for (const pair of work) {
    // A merged-away fact can't be a partner again.
    if (remap[pair.concrete.factId] || remap[pair.template.factId]) continue;

    const r = await completeFn({
      useCase: 'S2',
      workspace: engine.workspace,
      provider: engine.provider,
      model: engine.model,
      maxRequests: engine.maxRequests,
      schema: S2_SCHEMA,
      system: 'You resolve whether two observed REST endpoints are the same endpoint, ' +
              'where one path may be a concrete instance of the other\'s template.',
      prompt: buildPrompt(pair),
    });

    if (!r.ok) {
      // Engine down or budget spent — the rest will fail the same way. Stop,
      // tag everyone still in play as skipped, record one degradation.
      skipped = work.length - merges;
      for (const p of work) {
        if (!remap[p.concrete.factId]) tagSkipped(byId.get(p.concrete.factId));
        if (!remap[p.template.factId]) tagSkipped(byId.get(p.template.factId));
      }
      degraded.push({
        useCase: 'S2', stage: 'store',
        reason: `entity-resolution unavailable (${r.error}) — ${skipped} pair(s) left unmerged`,
        fallback: 'near-duplicate facts kept separate, confidence not corroborated',
      });
      break;
    }

    if (r.json.same && r.json.confidence >= S2_MERGE_MIN_CONFIDENCE) {
      mergeInto(byId.get(pair.template.factId), byId.get(pair.concrete.factId), r.json.confidence);
      remap[pair.concrete.factId] = pair.template.factId;
      merges += 1;
    }
    // same:false or low confidence → correctly kept separate; not a skip.
  }

  const note = dropped > 0
    ? `S2 residue ${ranked.length} pairs exceeded cap ${S2_MAX_PAIRS}; ${dropped} not evaluated`
    : null;

  const survivingFacts = facts.filter((f) => !remap[f.factId]);
  return { facts: survivingFacts, remap, merges, skipped, note, degraded };
}

// ── merge ────────────────────────────────────────────────────────────────────

/** Fold the concrete fact's evidence into the templated (canonical) fact. */
function mergeInto(template, concrete, matchConfidence) {
  if (!template || !concrete) return;
  template.observations = [...(template.observations ?? []), ...(concrete.observations ?? [])];
  template.confidence = combineConfidence(template.confidence ?? 0, concrete.confidence ?? 0);

  const prov = template.provenance ?? (template.provenance = {});
  prov.corroborationCount = (prov.corroborationCount ?? 1) + (concrete.provenance?.corroborationCount ?? 1);
  prov.s2 = {
    merged: [concrete.factId],
    method: 'llm-match',
    confidence: matchConfidence,
  };
}

function tagSkipped(fact) {
  if (fact && !fact.provenance?.s2) {
    (fact.provenance ?? (fact.provenance = {})).s2 = 'skipped';
  }
}

// ── ranking / prompt ─────────────────────────────────────────────────────────

/**
 * Prioritise by corroboration impact: a pair whose concrete side rests on a
 * single source has the most to gain from being merged (it becomes corroborated).
 */
function rankByImpact(pairs) {
  return [...pairs].sort((a, b) =>
    (a.concrete.provenance?.corroborationCount ?? 1) - (b.concrete.provenance?.corroborationCount ?? 1));
}

function buildPrompt({ concrete, template }) {
  const fams = (f) => (f.provenance?.families ?? []).map((x) => x.class).join(', ') || 'unknown';
  return [
    'Two REST endpoints were observed. Decide whether they are the SAME endpoint,',
    'where one path is likely a concrete instance of the other\'s templated path',
    '(e.g. "/users/Alice" is an instance of "/users/{id}").',
    '',
    `A: ${concrete.key.method} ${concrete.key.pathTemplate}   (seen via: ${fams(concrete)})`,
    `B: ${template.key.method} ${template.key.pathTemplate}   (seen via: ${fams(template)})`,
    '',
    'Answer with your confidence in [0,1]. Only say same:true if you are confident',
    'they are one endpoint, not merely similar.',
  ].join('\n');
}
