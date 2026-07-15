// Naming, summary, and clustering confidence (spec §5.3). Deterministic by
// default (FEAT_LLM=0); an LLM pass may later refine name/summary only, never
// identity or membership.

import { DISPLAY_LABELS } from './feature-key.mjs';
import { UNASSIGNED } from './cluster.mjs';

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const round4 = (x) => Math.round(x * 1e4) / 1e4;

/** Title-Case a slug: `authorization-keys` → "Authorization Keys". */
function titleCase(slug) {
  return String(slug).split('-').filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Deterministic "3 endpoints, 2 interactions" from member kinds. */
function kindBreakdown(members) {
  const counts = new Map();
  for (const m of members) counts.set(m.fact.kind, (counts.get(m.fact.kind) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([kind, n]) => `${n} ${kind}${n === 1 ? '' : 's'}`)
    .join(', ');
}

/**
 * Name + summary + clustering confidence for one cluster.
 *
 * Confidence is the share of members placed by a strong (structural) signal:
 * an all-structural feature approaches 1.0; a mostly co-occurrence/size-merge
 * cluster sits near 0.5. `_unassigned` is the reject bucket, not a coherent
 * feature, so its confidence is 0.
 *
 * @param {{featureId: string, members: {fact: Object, signal: string, strong: boolean}[]}} cluster
 * @param {{synonyms: Object}} cfg
 * @returns {{name: string, summary: string, confidence: number}}
 */
export function nameFeature(cluster, cfg) {
  const { featureId, members } = cluster;

  if (featureId === UNASSIGNED) {
    return {
      name: 'Unassigned',
      summary: `${members.length} fact${members.length === 1 ? '' : 's'} no structural signal could place.`,
      confidence: 0,
    };
  }

  const name = DISPLAY_LABELS[featureId] ?? titleCase(featureId);
  const strong = members.filter(m => m.strong).length;
  const confidence = members.length ? round4(clamp01(0.5 + 0.5 * (strong / members.length))) : 0;
  const summary = `${name} — ${kindBreakdown(members)}.`;
  return { name, summary, confidence };
}
