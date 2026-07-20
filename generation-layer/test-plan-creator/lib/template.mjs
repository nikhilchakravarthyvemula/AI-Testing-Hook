// The S1 fallback — deterministic template scenarios (p0-05 §3).
//
// When the engine can't answer for a feature (down, or budget spent), we still
// owe the operator a plan for it. These templates are the honest floor: one
// smoke scenario per page, and one scenario per untested/shadow gap — the same
// shapes the crawler generator already produces, so they are real, runnable
// tests, just not LLM-tailored. They flow through the identical assembly
// (mutation flag, hallucination guard, priority) as S1 output, so the plan file
// is byte-shape-identical whichever path produced a feature (§3).

/**
 * @param {object} featureCtx  store.featureContext(featureId): { feature, endpoints, pages, gaps }
 * @returns {Array} loose scenarios in the shape assembleFeature expects
 */
export function templateScenarios(featureCtx) {
  const scenarios = [];

  // One smoke test per page: it loads, no console errors, expected APIs fire.
  for (const page of featureCtx.pages ?? []) {
    scenarios.push({
      title: `Smoke: ${page} loads`,
      intent: `Load ${page} and assert it renders without console errors and that its expected API calls fire.`,
      kind: 'ui',
      targets: { pages: [page] },
      gapRefs: [],
    });
  }

  // One scenario per untested/shadow endpoint gap — the gaps a test most
  // directly closes. Other gap kinds (conflict, low-trust) need judgement a
  // template can't supply, so the fallback leaves them for the report.
  for (const gap of featureCtx.gaps ?? []) {
    if (gap.type !== 'untested-endpoint' && gap.type !== 'shadow-endpoint') continue;
    const ep = endpointForGap(gap);
    if (!ep) continue;
    scenarios.push({
      title: gap.title ?? `Cover ${ep}`,
      intent: gap.recommendation ?? gap.detail ?? `Exercise ${ep} and assert a well-formed response.`,
      kind: 'api',
      targets: { endpoints: [ep] },
      gapRefs: [gap.gapId],
    });
  }

  return scenarios;
}

/** "METHOD path" for a gap whose subject is an endpoint fact, else null. */
function endpointForGap(gap) {
  const key = gap.subject?.key;
  if (!key?.method || !key?.pathTemplate) return null;
  return `${key.method} ${key.pathTemplate}`;
}
