// §A Test results — what ran, what happened (p0-08 §2 §A).
//
// Summary tiles + a per-test table joining results (status/duration/reason/
// screenshots) with the manifest (agent vs template provenance) and the plan
// (human-readable title). Mutation/safety skips are rendered as their own tone,
// not as failures — they are coverage statements, not noise.

import path from 'node:path';
import { esc, join, tile, section, empty, table, pill, toneFor } from '../html.mjs';
import { dataUri } from '../assets.mjs';

export function renderResults(model) {
  const { results, resultById, scenarioById, manifestById, workspace } = model;

  if (!results || !(results.entries ?? []).length) {
    return section('results', 'A · Test results',
      empty('No results were produced — the execute stage did not run or ran nothing. See §D for why.'));
  }

  const entries = results.entries;
  const failedGen = entries.filter((e) => e.reason === 'failed-generation').length;
  const s = results.summary ?? {};
  const tiles = join([
    tile('Passed', s.passed ?? 0, 'ok'),
    tile('Failed', s.failed ?? 0, (s.failed ?? 0) > 0 ? 'bad' : 'neutral'),
    tile('Skipped (mutation/safety)', s.skippedMutation ?? 0, (s.skippedMutation ?? 0) > 0 ? 'warn' : 'neutral'),
    tile('Error', Math.max(0, (s.error ?? 0) - failedGen), 'neutral'),
    failedGen ? tile('Failed generation', failedGen, 'warn') : '',
  ]);

  const rows = entries.map((e) => {
    const sc = scenarioById.get(e.scenarioId) ?? {};
    const gen = manifestById.get(e.scenarioId)?.generator;
    return [
      `<span class="mono">${esc(e.scenarioId)}</span>`,
      esc(sc.featureName ?? e.featureId ?? '—'),
      esc(sc.title ?? '—'),
      pill(e.status, toneFor(e.status)),
      gen ? pill(gen, gen === 'agent' ? 'muted' : 'warn') : '—',
      e.durationMs ? `${e.durationMs} ms` : '—',
      e.reason ? esc(e.reason) : '',
      shots(workspace, e.artifacts?.screenshots ?? []),
    ];
  });

  const body = join([
    `<div class="tiles">${tiles}</div>`,
    table(['Scenario', 'Feature', 'Title', 'Status', 'By', 'Duration', 'Reason', 'Shots'], rows),
  ]);
  return section('results', 'A · Test results', body);
}

function shots(workspace, rels) {
  return (rels ?? []).map((rel) => {
    const uri = dataUri(path.join(workspace, rel));
    return uri ? `<img class="shot" src="${uri}" alt="screenshot">` : '';
  }).join(' ') || '—';
}
