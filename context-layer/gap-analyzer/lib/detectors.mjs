// The four gap detectors (spec §5.1–5.4). Each is a pure, order-independent
// function `facts → Gap[]`. Detectors emit gaps WITHOUT priority/severity —
// those are assigned centrally in prioritize.mjs, which needs the whole gap set
// to apply cross-signal bumps (e.g. untested-and-also-shadow).

/** Distinct, sorted family classes backing a fact. */
function familyClasses(fact) {
  const classes = new Set((fact.provenance?.families ?? []).map(f => f.class));
  return [...classes].sort();
}

/** Human label for a fact: "GET /path" for endpoints, else its identity. */
function label(fact) {
  if (fact.kind === 'endpoint' && fact.key) return `${fact.key.method} ${fact.key.pathTemplate}`;
  return fact.key?.pathTemplate ?? fact.key?.id ?? fact.factId;
}

/** Assemble a gap sans priority/severity (filled by prioritize()). */
function makeGap({ gapId, type, fact, title, detail, recommendation, conflict = null }) {
  return {
    gapId,
    type,
    kind: fact.kind,
    severity: null,     // ← prioritize()
    priority: null,     // ← prioritize()
    subject: { factId: fact.factId, kind: fact.kind, key: fact.key },
    title,
    detail,
    evidence: {
      confidence: fact.confidence ?? 0,
      corroborationCount: fact.provenance?.corroborationCount ?? 0,
      familyClasses: familyClasses(fact),
      conflict,
    },
    recommendation,
  };
}

/**
 * §5.1 — endpoints seen at runtime with no spec AND no code family backing them.
 * Undocumented surface area: every one is a contract-test candidate.
 * @param {Object[]} facts
 * @returns {Object[]}
 */
export function detectShadowEndpoints(facts) {
  const gaps = [];
  for (const fact of facts) {
    if (fact.kind !== 'endpoint') continue;
    const classes = new Set(familyClasses(fact));
    if (classes.has('runtime') && !classes.has('spec') && !classes.has('code')) {
      gaps.push(makeGap({
        gapId: `shadow-endpoint::${fact.factId}`,
        type: 'shadow-endpoint',
        fact,
        title: `Undocumented endpoint: ${label(fact)}`,
        detail: 'Observed live (runtime) but absent from every spec and code source. No contract declares it.',
        recommendation: 'Add an OpenAPI/contract entry and a contract test; confirm intended auth.',
      }));
    }
  }
  return gaps;
}

/**
 * §5.2 — endpoints whose "<METHOD> <pathTemplate>" key is not in the coverage
 * set. Empty coverage ⇒ every endpoint fires (truthful pre-generation state).
 * @param {Object[]} facts
 * @param {Set<string>} coverage
 * @returns {Object[]}
 */
export function detectUntestedEndpoints(facts, coverage) {
  const gaps = [];
  for (const fact of facts) {
    if (fact.kind !== 'endpoint' || !fact.key) continue;
    const coverageKey = `${fact.key.method} ${fact.key.pathTemplate}`;
    if (coverage.has(coverageKey)) continue;
    gaps.push(makeGap({
      gapId: `untested-endpoint::${fact.factId}`,
      type: 'untested-endpoint',
      fact,
      title: `Untested endpoint: ${label(fact)}`,
      detail: 'No linked test exercises this endpoint.',
      recommendation: 'Generate an API test covering this endpoint.',
    }));
  }
  return gaps;
}

/**
 * §5.3 — one gap per surfaced conflict entry, across ALL kinds. The conflicting
 * attribute name is part of the gapId so multiple conflicts on one fact yield
 * distinct gaps.
 * @param {Object[]} facts
 * @returns {Object[]}
 */
export function detectConflicts(facts) {
  const gaps = [];
  for (const fact of facts) {
    for (const c of fact.conflicts ?? []) {
      const resolution = c.resolution ?? 'unresolved';
      gaps.push(makeGap({
        gapId: `conflict::${fact.factId}::${c.attribute}`,
        type: 'conflict',
        fact,
        title: `Conflicting ${c.attribute} on ${label(fact)}`,
        detail: `Sources disagree on "${c.attribute}" (${resolution}). A test must settle the correct value.`,
        recommendation: `Add a test that pins the correct "${c.attribute}".`,
        conflict: { attribute: c.attribute, values: c.values ?? [], resolution },
      }));
    }
  }
  return gaps;
}

/**
 * §5.4 — critical-kind facts resting on too few families or below the
 * confidence floor: unverified by independent evidence.
 * @param {Object[]} facts
 * @param {{lowTrustKinds: string[], minCorroboration: number, lowTrustConfidence: number}} cfg
 * @returns {Object[]}
 */
export function detectLowTrust(facts, cfg) {
  const kinds = new Set(cfg.lowTrustKinds);
  const gaps = [];
  for (const fact of facts) {
    if (!kinds.has(fact.kind)) continue;
    const corroboration = fact.provenance?.corroborationCount ?? 0;
    const confidence = fact.confidence ?? 0;
    if (corroboration < cfg.minCorroboration || confidence < cfg.lowTrustConfidence) {
      gaps.push(makeGap({
        gapId: `low-trust::${fact.factId}`,
        type: 'low-trust',
        fact,
        title: `Low-trust ${fact.kind}: ${label(fact)}`,
        detail: `Rests on ${corroboration} independent source famil${corroboration === 1 ? 'y' : 'ies'} ` +
          `(confidence ${confidence}); no independent corroboration.`,
        recommendation: 'Verify with an independent source or a test before relying on it.',
      }));
    }
  }
  return gaps;
}
