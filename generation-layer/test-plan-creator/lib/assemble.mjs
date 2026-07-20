// Deterministic assembly — the part of C5 the LLM does not touch.
//
// Raw scenarios come from either path (S1 or the template fallback) in the SAME
// loose shape: { title, intent, kind, targets, gapRefs?, mutationOpinion? }.
// This module turns them into the strict plan-schema scenarios the checkpoint
// validates (p0-00 §6), applying, in order:
//
//   1. hallucination guard — drop any scenario naming a target not in the store
//      (p0-05 §1, acceptance 3); clean unknown gapRefs off the survivors;
//   2. de-duplication against sibling scenarios in the same feature;
//   3. mutation flagging (deterministic, fail-safe — mutation.mjs);
//   4. priority from the severity of the gaps a scenario addresses;
//   5. a stable, plan-unique scenarioId.
//
// Counts of everything dropped are threaded back through `stats` so the plan can
// tell the operator what was filtered and why (acceptance 3).

import { isMutation } from './mutation.mjs';

/**
 * Build the lookup sets a run's hallucination guard checks against, from the
 * store's own accessors — so "a real endpoint" means exactly what the rest of
 * the system means by it.
 *
 * @param {object} opened  the result of openStore(workspace)
 * @returns {{ endpoints:Set<string>, pages:Set<string>, gaps:Set<string> }}
 */
export function buildTargetIndex(opened) {
  const endpoints = new Set(opened.queryEndpoints({}).map((e) => `${e.method} ${e.path}`));
  const pages = new Set(Object.values(opened.store.indexes.pagesByFeature ?? {}).flat());
  const gaps = new Set(opened.store.gaps.map((g) => g.gapId));
  return { endpoints, pages, gaps };
}

/**
 * Assemble one feature's scenarios into plan shape.
 *
 * @param {object} args
 * @param {object} args.feature      { featureId, name }
 * @param {Array}  args.raw          loose scenarios from S1 or the template path
 * @param {object} args.targetIndex  from buildTargetIndex
 * @param {Map}    args.gapById      gapId → gap (for priority)
 * @param {object} args.counter      { n } mutated in place for plan-unique ids
 * @param {object} args.stats        { dropped:{hallucinated,noTarget,duplicate} } mutated in place
 * @returns {Array} strict scenario objects (p0-00 §6)
 */
export function assembleFeature({ feature, raw, targetIndex, gapById, counter, stats }) {
  const out = [];
  const seen = new Set();

  for (const sc of raw ?? []) {
    const endpoints = asStrings(sc?.targets?.endpoints);
    const pages = asStrings(sc?.targets?.pages);

    // 1. hallucination guard — any invented target voids the whole scenario.
    const inventedEndpoint = endpoints.some((e) => !targetIndex.endpoints.has(e));
    const inventedPage = pages.some((p) => !targetIndex.pages.has(p));
    if (inventedEndpoint || inventedPage) {
      stats.dropped.hallucinated += 1;
      continue;
    }
    if (endpoints.length === 0 && pages.length === 0) {
      // No target ⇒ nothing to generate or run against.
      stats.dropped.noTarget += 1;
      continue;
    }

    // 2. de-dup against siblings, by normalized title + the target set.
    const key = dedupKey(sc.title, endpoints, pages);
    if (seen.has(key)) {
      stats.dropped.duplicate += 1;
      continue;
    }
    seen.add(key);

    // clean gapRefs down to gaps that exist in this store.
    const gapRefs = asStrings(sc?.gapRefs).filter((g) => targetIndex.gaps.has(g));

    const targets = {};
    if (endpoints.length) targets.endpoints = endpoints;
    if (pages.length) targets.pages = pages;

    const scenario = {
      scenarioId: nextId(counter),
      title: String(sc.title),
      kind: KINDS.has(sc.kind) ? sc.kind : inferKind(endpoints, pages),
      intent: String(sc.intent),
      // 3. mutation — deterministic; the model's own guess is recorded, not used.
      mutation: isMutation({ title: sc.title, intent: sc.intent, targets }),
      targets,
      // 4. priority from gap severity.
      priority: priorityFrom(gapRefs, gapById),
      gapRefs,
    };
    if (typeof sc.mutationOpinion === 'boolean') scenario.mutationOpinion = sc.mutationOpinion;

    out.push(scenario);
  }

  // Highest-priority scenarios first — the order the operator reads them in.
  out.sort((a, b) => b.priority - a.priority);
  return out;
}

// ── helpers ──────────────────────────────────────────────────────────────────

const KINDS = new Set(['api', 'ui', 'perf']);

function inferKind(endpoints, pages) {
  if (pages.length && !endpoints.length) return 'ui';
  return 'api';
}

/** Priority = the max priority of the gaps this scenario addresses; 0 if none. */
function priorityFrom(gapRefs, gapById) {
  let max = 0;
  for (const id of gapRefs) {
    const p = gapById.get(id)?.priority;
    if (Number.isFinite(p) && p > max) max = p;
  }
  return max;
}

function dedupKey(title, endpoints, pages) {
  const t = String(title ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  const targets = [...endpoints, ...pages.map((p) => `page:${p}`)].sort().join('|');
  return `${t}##${targets}`;
}

function nextId(counter) {
  counter.n += 1;
  return `sc-${String(counter.n).padStart(4, '0')}`;
}

function asStrings(v) {
  if (!Array.isArray(v)) return [];
  return v.filter((x) => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim());
}
