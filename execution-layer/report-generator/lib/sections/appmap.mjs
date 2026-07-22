// §C App understanding map — "here is what the harness understood" (p0-08 §2 §C).
//
// The trust surface: per feature, the endpoints (confidence-shaded) and pages
// the store believes belong to it, plus its gap count. Rendered from the store
// accessors as confidence-shaded inventory tables rather than embedding the
// interactive graph-viewer — because the report is ONE self-contained file
// (p0-08 §3), and the accessors already give the same feature→endpoints/pages
// join the graph shapers do. When a §A result looks wrong, this is the first
// stop: did the harness even understand that surface?

import { esc, join, section, empty, table } from '../html.mjs';

export function renderAppMap(model) {
  const { store } = model;
  if (!store) {
    return section('appmap', 'C · App understanding map',
      empty('No knowledge store — the harness produced no understanding to map. See §D.'));
  }

  const features = store.listFeatures();
  if (!features.length) {
    return section('appmap', 'C · App understanding map',
      empty('The store has no features — a very thin observation set. See §C data in §D transparency.'));
  }

  const overview = `<p class="sec__note">${features.length} feature(s), ` +
    `${features.reduce((n, f) => n + f.endpointCount, 0)} endpoint(s), ` +
    `${features.reduce((n, f) => n + f.pageCount, 0)} page(s) understood.</p>`;

  const blocks = features.map((f) => {
    const ctx = store.featureContext(f.featureId);
    const endpoints = ctx?.endpoints ?? [];
    const pages = ctx?.pages ?? [];

    const epRows = endpoints.map((e) => [
      `<span class="mono">${esc(e.method)} ${esc(e.path)}</span>`,
      confidenceBar(e.confidence),
      esc((e.provenance?.families ?? []).join(', ') || '—'),
      String(e.provenance?.corroborationCount ?? 1),
    ]);

    const epTable = epRows.length
      ? table(['Endpoint', 'Confidence', 'Seen via', 'Sources'], epRows)
      : empty('No endpoints attributed to this feature.');
    const pagesLine = pages.length
      ? `<p class="sec__note">Pages: ${pages.map((p) => `<span class="mono">${esc(p)}</span>`).join(', ')}</p>`
      : '';

    return `<div class="sub">${esc(f.name)} <span class="mono">(${esc(f.featureId)})</span> — ${f.gapCount} gap(s)</div>${epTable}${pagesLine}`;
  });

  return section('appmap', 'C · App understanding map', join([overview, ...blocks]));
}

function confidenceBar(c) {
  const pct = Math.round(Math.max(0, Math.min(1, c ?? 0)) * 100);
  return `<div style="display:flex;align-items:center;gap:8px"><div class="bar"><i style="width:${pct}%"></i></div><span class="mono">${pct}%</span></div>`;
}
