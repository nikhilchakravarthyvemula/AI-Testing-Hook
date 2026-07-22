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
  'gaps that were actually observed for this feature. Never invent an endpoint or ' +
  'page that is not in the lists given — every target you name must be copied ' +
  'verbatim from those lists.\n\n' +
  'Optimise for DEPTH, not breadth. A scenario that pins one endpoint against many ' +
  'concrete edge cases is worth more than one that skims a whole lifecycle. Keep ' +
  'each scenario TIGHT — one endpoint, or a small group that genuinely must be ' +
  'exercised together (e.g. create-then-read a resource). Do NOT bundle an entire ' +
  'CRUD lifecycle into a single scenario.\n\n' +
  'Isolate destructive operations. Put each DELETE / cancel / revoke / deactivate ' +
  'in its OWN scenario, never mixed with reads or creates — a safety gate may ' +
  'withhold a destructive test, and it must not take safe reads down with it.';

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

  const endpointCount = endpoints.length;
  const pageCount = pages.length;
  // Scale the ask to the surface area rather than a flat cap: a feature with 30
  // endpoints deserves far more than one with 3. The human checkpoint (which sees
  // the cost estimate) is what bounds this, not an arbitrary ceiling here.
  const target = Math.max(3, endpointCount + pageCount);

  lines.push(
    `This feature exposes ${endpointCount} endpoint(s) and ${pageCount} page(s). ` +
    `Propose roughly ${target}-${target * 2} scenarios — cover EVERY endpoint and ` +
    'page at least once, then add depth where risk warrants it. Guidance:\n' +
    '  - One endpoint (or a tight must-test-together group) per scenario. Split a ' +
    'CRUD lifecycle into separate create / read / update / delete scenarios.\n' +
    '  - For each endpoint prefer DEPTH: enumerate concrete edge cases across ' +
    'scenarios — happy path, missing/empty/oversized/malformed inputs, injection ' +
    '(SQL/NoSQL/path-traversal), authorization (unauthenticated, cross-tenant), ' +
    'not-found, and idempotency / repeated calls.\n' +
    '  - Put each destructive operation (DELETE / cancel / revoke) in its OWN ' +
    'scenario, isolated from reads and creates.\n' +
    '  - Prefer scenarios that close a listed gap. Every scenario needs at least ' +
    'one target endpoint or page, copied verbatim from the lists above.\n' +
    '  - Set kind to "api" for endpoint-only tests, "ui" for page flows, "perf" ' +
    'for load/latency tests. Set mutationOpinion to true if the scenario writes ' +
    'to the app.',
  );

  return lines.join('\n');
}
