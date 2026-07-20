// The S1 touchpoint: the schema the engine must return, and the prompt it sees.
//
// S1 is scenario IDEATION — one call per feature. The model proposes WHAT to
// test (title, intent, kind, targets, which gaps it addresses). It does NOT
// decide priority, mutation-ness, or scenarioId — those are deterministic and
// happen in assemble.mjs. The schema keeps the model on the two things it is
// good at: naming a test and pointing it at real surface area.
//
// `mutationOpinion` is captured so the report can show where the model and the
// deterministic flag disagreed — it is never used to set the flag (mutation.mjs).

export const SCENARIOS = {
  type: 'object',
  properties: {
    scenarios: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          intent: { type: 'string' },
          kind: { type: 'string', enum: ['api', 'ui', 'perf'] },
          targets: {
            type: 'object',
            properties: {
              endpoints: { type: 'array', items: { type: 'string' } },
              pages: { type: 'array', items: { type: 'string' } },
            },
            additionalProperties: false,
          },
          gapRefs: { type: 'array', items: { type: 'string' } },
          mutationOpinion: { type: 'boolean' },
        },
        required: ['title', 'intent', 'kind', 'targets'],
        additionalProperties: false,
      },
    },
  },
  required: ['scenarios'],
  additionalProperties: false,
};

export const SYSTEM_PROMPT =
  'You are a senior QA engineer proposing test scenarios for one feature of a ' +
  'web application. You are given ONLY the endpoints, pages, and known coverage ' +
  'gaps that were actually observed for this feature. Propose focused, ' +
  'high-value scenarios that exercise this real surface area. Never invent an ' +
  'endpoint or page that is not in the lists given — every target you name must ' +
  'be copied verbatim from those lists.';

/**
 * Build the S1 user prompt from a feature's context (store.featureContext()).
 *
 * Endpoints are presented as the exact "METHOD path" strings the scenario must
 * echo back in `targets.endpoints`, so the deterministic hallucination guard can
 * match them; pages likewise. Gaps are named by id so the model can attach a
 * scenario to the gap it closes.
 */
export function buildPrompt(featureCtx) {
  const { feature, endpoints, pages, gaps } = featureCtx;
  const lines = [];

  lines.push(`Feature: ${feature.name}`);
  if (feature.summary) lines.push(`Summary: ${feature.summary}`);
  lines.push('');

  lines.push('Endpoints (use these exact strings in targets.endpoints):');
  if (endpoints.length) {
    for (const e of endpoints) {
      const fams = e.provenance?.families?.length ? ` [seen via: ${e.provenance.families.join(', ')}]` : '';
      lines.push(`  - ${e.method} ${e.path}${fams}`);
    }
  } else {
    lines.push('  (none)');
  }
  lines.push('');

  lines.push('Pages (use these exact strings in targets.pages):');
  if (pages.length) {
    for (const p of pages) lines.push(`  - ${p}`);
  } else {
    lines.push('  (none)');
  }
  lines.push('');

  lines.push('Known coverage gaps (reference by id in gapRefs where a scenario closes one):');
  if (gaps.length) {
    for (const g of gaps) {
      lines.push(`  - ${g.gapId} (${g.severity ?? 'unknown'}): ${g.title ?? g.type}`);
    }
  } else {
    lines.push('  (none)');
  }
  lines.push('');

  lines.push(
    'Propose 1-6 scenarios. Prefer scenarios that close a listed gap. Each ' +
    'scenario needs at least one target endpoint or page, chosen from the lists ' +
    'above. Set kind to "api" for endpoint-only tests, "ui" for page flows, ' +
    '"perf" for load/latency tests. Set mutationOpinion to true if you believe ' +
    'the scenario writes to the app.',
  );

  return lines.join('\n');
}
