// Prioritization (spec §5.5). Central scoring so cross-signal bumps see the
// whole gap set: an untested endpoint that is ALSO a shadow endpoint ranks
// above an untested-but-documented one; an unresolved conflict outranks a
// resolved one.

/** Fixed base weights per gap type (initial, tunable — spec §5.5). */
export const TYPE_WEIGHT = Object.freeze({
  'shadow-endpoint': 0.80,
  'conflict': 0.70,
  'untested-endpoint': 0.60,
  'low-trust': 0.45,
});

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const round4 = (x) => Math.round(x * 1e4) / 1e4;

/** Severity bucket from priority (spec §5.5). */
export function severityFor(priority) {
  if (priority >= 0.7) return 'high';
  if (priority >= 0.4) return 'medium';
  return 'low';
}

/**
 * Score every gap, then sort by priority desc, gapId asc (a total order, since
 * gapIds are unique) so identical input yields byte-identical output.
 *
 * @param {Object[]} gaps  proto-gaps from the detectors (priority/severity null)
 * @returns {Object[]} the same gaps, priority + severity filled, sorted
 */
export function prioritize(gaps) {
  const shadowFactIds = new Set(
    gaps.filter(g => g.type === 'shadow-endpoint').map(g => g.subject.factId),
  );

  for (const gap of gaps) {
    const base = (TYPE_WEIGHT[gap.type] ?? 0.5) * (0.5 + 0.5 * (gap.evidence.confidence ?? 0));
    let bump = 0;
    if (gap.type === 'untested-endpoint' && shadowFactIds.has(gap.subject.factId)) bump += 0.15;
    if (gap.type === 'conflict' && gap.evidence.conflict?.resolution === 'unresolved') bump += 0.10;
    gap.priority = round4(clamp01(base + bump));
    gap.severity = severityFor(gap.priority);
  }

  return gaps.sort((a, b) =>
    b.priority - a.priority || (a.gapId < b.gapId ? -1 : a.gapId > b.gapId ? 1 : 0));
}
