// §B Coverage & gap audit — the signature section (p0-08 §2 §B).
//
// The store's gaps, joined to THIS run's results: for each gap, did a test
// actually exercise it? (plan scenario.gapRefs → scenarioId → result status.)
// Grouped by gap type, plus an explicit accounting of the mutation/safety skips
// (coverage statements, not failures) and honest placeholders for the audits a
// url-only run or a deferred source can't produce.

import { esc, join, section, empty, table, pill, toneFor } from '../html.mjs';

const TYPE_TITLES = {
  'shadow-endpoint': 'Shadow endpoints (observed live, undocumented)',
  'untested-endpoint': 'Untested endpoints',
  'conflict': 'Conflicting facts (sources disagree)',
  'low-trust': 'Low-trust facts (single-source / low confidence)',
};

export function renderCoverage(model) {
  const { store } = model;
  if (!store) {
    return section('coverage', 'B · Coverage & gap audit',
      empty('The knowledge store is unavailable, so no coverage audit could be built. See §D for why the understand/store stage did not complete.'));
  }

  const gaps = store.listGaps();
  const addressed = gapAddressedIndex(model);

  const overview = renderOverview(gaps, addressed);
  const byType = groupBy(gaps, (g) => g.type);
  const typeSections = Object.keys(TYPE_TITLES)
    .filter((t) => byType[t]?.length)
    .map((t) => renderGapType(TYPE_TITLES[t], byType[t], addressed));
  // any gap type we didn't name explicitly still gets rendered — never dropped.
  const otherTypes = Object.entries(byType)
    .filter(([t]) => !TYPE_TITLES[t])
    .map(([t, gs]) => renderGapType(`${t} gaps`, gs, addressed));

  const body = join([
    overview,
    ...typeSections,
    ...otherTypes,
    gaps.length ? '' : empty('No gaps were detected — either full coverage, or a thin observation set (see §C/§D).'),
    renderSafeSkips(model),
    renderUnavailable(model),
  ]);
  return section('coverage', 'B · Coverage & gap audit', body);
}

// ── which gaps a test actually exercised ─────────────────────────────────────

/** gapId → 'tested' | 'attempted' | 'untested' for this run. */
function gapAddressedIndex(model) {
  const idx = new Map();
  for (const [scenarioId, sc] of model.scenarioById) {
    const res = model.resultById.get(scenarioId);
    const ran = res && (res.status === 'passed' || res.status === 'failed');
    const attempted = res && !ran;   // skipped / error
    for (const gapId of sc.gapRefs ?? []) {
      const cur = idx.get(gapId);
      // 'tested' wins over 'attempted' wins over nothing.
      if (ran) idx.set(gapId, 'tested');
      else if (attempted && cur !== 'tested') idx.set(gapId, 'attempted');
      else if (!cur) idx.set(gapId, 'attempted');
    }
  }
  return idx;
}

function addressPill(state) {
  if (state === 'tested') return pill('tested this run', 'ok');
  if (state === 'attempted') return pill('attempted (skipped/error)', 'warn');
  return pill('not covered', 'muted');
}

// ── renderers ────────────────────────────────────────────────────────────────

function renderOverview(gaps, addressed) {
  const tested = gaps.filter((g) => addressed.get(g.gapId) === 'tested').length;
  return `<p class="sec__note">${gaps.length} gap(s) detected; <b>${tested}</b> exercised by a test this run, ` +
    `${gaps.length - tested} still open.</p>`;
}

function renderGapType(title, gaps, addressed) {
  const rows = gaps.map((g) => [
    esc(g.title ?? subjectLabel(g)),
    pill(g.severity ?? '—', toneFor(g.severity)),
    esc(g.detail ?? ''),
    esc(g.recommendation ?? ''),
    addressPill(addressed.get(g.gapId)),
  ]);
  return `<div class="sub">${esc(title)} (${gaps.length})</div>` +
    table(['Subject', 'Severity', 'Evidence', 'What would cover it', 'This run'], rows);
}

function renderSafeSkips(model) {
  const skips = (model.results?.entries ?? []).filter((e) => e.status === 'skipped-mutation');
  if (!skips.length) return '';
  const rows = skips.map((e) => {
    const sc = model.scenarioById.get(e.scenarioId) ?? {};
    return [esc(sc.title ?? e.scenarioId), esc(sc.featureName ?? e.featureId ?? '—'),
      esc(e.reason ?? ''), pill('not exercised', 'warn')];
  });
  return `<div class="sub">Mutation / destructive tests not run (${skips.length}) — coverage gaps by design</div>` +
    `<p class="sec__note">These were generated but withheld by safe mode or the safety floor. They are coverage statements: this run did not verify them.</p>` +
    table(['Scenario', 'Feature', 'Why withheld', 'Status'], rows);
}

function renderUnavailable(model) {
  const notes = [];
  if (!model.hasCodebase) {
    notes.push('Declared-vs-observed audit: unavailable — no codebase was provided (url-only profile).');
  }
  notes.push('Documented-but-absent (Jira/Confluence): source not available — S3 is deferred to P1.');
  return `<div class="sub">Audits not available this run</div><ul class="sec__note">` +
    notes.map((n) => `<li>${esc(n)}</li>`).join('') + '</ul>';
}

// ── helpers ──────────────────────────────────────────────────────────────────

function subjectLabel(g) {
  const k = g.subject?.key;
  if (k?.method && k?.pathTemplate) return `${k.method} ${k.pathTemplate}`;
  return g.subject?.factId ?? g.gapId ?? '—';
}

function groupBy(arr, keyFn) {
  const out = {};
  for (const x of arr) (out[keyFn(x)] ??= []).push(x);
  return out;
}
