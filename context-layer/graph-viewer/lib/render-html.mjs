// render-html.mjs — emit a self-contained interactive graph viewer.
//
// One HTML file, no build step, uses vis-network from CDN. Loads the
// nodes/edges/meta payload inline as JSON so the file is portable
// (works opened directly with file:// — no need to serve it).
//
// Features baked in:
//   * search bar (filter by node label / text)
//   * legend
//   * stats panel
//   * physics-toggle (freeze layout once it stabilises)
//   * dark-mode-friendly default palette
//   * click a node → side panel with full details

import fs from 'node:fs';

/**
 * @param {Object} opts
 * @param {Array}  opts.nodes
 * @param {Array}  opts.edges
 * @param {Object} opts.meta
 * @param {string} opts.outputPath  absolute path to write the HTML to
 */
export function renderToFile({ nodes, edges, meta, outputPath }) {
  const html = renderHtml({ nodes, edges, meta });
  fs.mkdirSync(dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, html);
  return { bytes: Buffer.byteLength(html, 'utf8'), outputPath };
}


function renderHtml({ nodes, edges, meta }) {
  const payload = JSON.stringify({ nodes, edges, meta });
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(meta.title || 'Graph')}</title>
  <!--
    Pin vis-network to 9.1.9. Don't bump above 9.x without verifying — version
    10.x dropped the UMD bundle that exposes vis.DataSet / vis.Network used
    below. Symptom of regression: empty dark canvas, no errors visible unless
    you open DevTools.
  -->
  <script src="https://cdn.jsdelivr.net/npm/vis-network@9.1.9/standalone/umd/vis-network.min.js"
          onerror="window.__visLoadError = true"></script>
  <style>
    :root { color-scheme: light dark; }
    html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
    body { display: grid; grid-template-rows: auto 1fr; grid-template-columns: 1fr 320px; grid-template-areas: "header header" "graph sidebar"; background: #1c1f23; color: #eaeaea; }
    header { grid-area: header; padding: 10px 16px; background: #14171a; border-bottom: 1px solid #2a2e34; display: flex; gap: 16px; align-items: center; }
    header h1 { margin: 0; font-size: 18px; font-weight: 600; }
    header .sub { color: #9aa1a8; font-size: 13px; }
    header input { background: #2a2e34; color: #eaeaea; border: 1px solid #3a3e45; border-radius: 4px; padding: 4px 8px; width: 240px; font-size: 13px; }
    header button { background: #2a2e34; color: #eaeaea; border: 1px solid #3a3e45; border-radius: 4px; padding: 4px 10px; font-size: 13px; cursor: pointer; }
    header button:hover { background: #353a41; }
    /* min-height: 0 / min-width: 0 are required on grid children so they
       don't expand beyond their fr-track when child content (the canvas)
       has intrinsic size. Without these, vis-network's canvas grows the
       cell to ~6000px tall and the graph renders far off-screen. */
    #graph { grid-area: graph; background: #1c1f23; min-height: 0; min-width: 0; overflow: hidden; position: relative; }
    #graph canvas { display: block; }
    aside { grid-area: sidebar; background: #14171a; border-left: 1px solid #2a2e34; padding: 12px; overflow-y: auto; font-size: 13px; }
    aside h2 { font-size: 14px; margin: 16px 0 6px 0; color: #9aa1a8; text-transform: uppercase; letter-spacing: 0.5px; }
    aside h2:first-child { margin-top: 0; }
    .legend-row { display: flex; align-items: center; gap: 8px; margin: 4px 0; }
    .legend-swatch { width: 12px; height: 12px; border-radius: 3px; flex: none; }
    .legend-sym { width: 14px; text-align: center; color: #cfd3d8; flex: none; }
    .filter-row { display: flex; align-items: center; gap: 6px; margin: 3px 0; cursor: pointer; user-select: none; }
    .filter-row input { cursor: pointer; }
    .filter-row .cnt { color: #6b7178; font-variant-numeric: tabular-nums; margin-left: auto; }
    .stats { display: grid; grid-template-columns: 1fr auto; gap: 4px 12px; }
    .stats .v { font-variant-numeric: tabular-nums; }
    #selection { background: #1c1f23; border-radius: 6px; padding: 10px; min-height: 60px; word-break: break-word; }
    #selection .key { color: #9aa1a8; }
    #selection code { background: #2a2e34; padding: 1px 4px; border-radius: 3px; font-size: 12px; }
    #selection .placeholder { color: #5a606a; font-style: italic; }
  </style>
</head>
<body>
  <header>
    <h1>${escapeHtml(meta.title || 'Graph')}</h1>
    <span class="sub">${escapeHtml(meta.subtitle || '')}</span>
    <span style="flex:1"></span>
    <input id="search" placeholder="Filter by label / text…" />
    <button id="togglePhysics" title="Pause/resume layout simulation">⏸ pause</button>
    <button id="fit">⊕ fit</button>
  </header>
  <div id="graph"></div>
  <aside>
    <h2>Filters</h2>
    <div id="typeFilters"></div>
    <h2>Legend</h2>
    <div id="legend"></div>
    <h2>Stats</h2>
    <div class="stats" id="stats"></div>
    <h2>Selection</h2>
    <div id="selection"><div class="placeholder">Click a node to inspect.</div></div>
  </aside>

  <script>
    const DATA = ${payload};
    const { nodes, edges, meta } = DATA;

    function escapeText(s) {
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }
    function fatal(msg, detail) {
      const g = document.getElementById('graph');
      g.style.cssText = 'display:flex; align-items:center; justify-content:center; color:#eaeaea; padding:20px;';
      g.innerHTML = '<div style="max-width:560px; background:#2a1f1f; border:1px solid #d9534f; border-radius:8px; padding:18px;">'
        + '<div style="font-size:16px; color:#ff8e8a; margin-bottom:8px;">⚠ ' + escapeText(msg) + '</div>'
        + '<div style="font-size:13px; color:#bbb; white-space:pre-wrap;">' + escapeText(detail) + '</div>'
        + '</div>';
    }

    // Legend
    const legendEl = document.getElementById('legend');
    for (const item of (meta.legend || [])) {
      const row = document.createElement('div');
      row.className = 'legend-row';
      row.innerHTML = '<span class="legend-swatch" style="background:' + item.color + '"></span>'
        + '<span class="legend-sym">' + escapeText(item.symbol || '') + '</span>'
        + escapeText(item.label);
      legendEl.appendChild(row);
    }

    // Stats
    const statsEl = document.getElementById('stats');
    for (const [k, v] of Object.entries(meta.counts || {})) {
      statsEl.insertAdjacentHTML('beforeend',
        '<span class="k">' + escapeText(k) + '</span><span class="v">' + escapeText(String(v)) + '</span>');
    }
    if (meta.generatedAt) {
      statsEl.insertAdjacentHTML('beforeend',
        '<span class="k">generated</span><span class="v">' + escapeText(meta.generatedAt.slice(0, 19).replace('T', ' ')) + '</span>');
    }

    // Library load check — gives a visible, actionable error instead of an empty canvas.
    if (window.__visLoadError || typeof vis === 'undefined' || !vis.Network || !vis.DataSet) {
      fatal('vis-network failed to load',
        'The CDN script did not load (offline?) or the version on the CDN is incompatible.\\n\\n' +
        'Script tag: <script src="…/vis-network@9.1.9/standalone/umd/vis-network.min.js">\\n\\n' +
        'Workarounds:\\n' +
        '  • Open this file while online.\\n' +
        '  • If the CDN is blocked, download vis-network.min.js and serve locally.\\n' +
        '  • Open DevTools Console for the exact load error.');
      throw new Error('vis-network not available');
    }

    // vis-network 9.x renders node/edge title as HTML only when it is a DOM
    // element; plain strings are shown as escaped text (so '<b>Intent</b>'
    // appears literally). Convert every title string into a styled div so
    // our tooltip markup actually renders.
    function htmlTitle(s) {
      if (s == null) return undefined;
      if (typeof s !== 'string') return s;   // already a node/element
      const el = document.createElement('div');
      el.style.cssText = 'background:#14171a; color:#eaeaea; border:1px solid #3a3e45; ' +
                         'border-radius:6px; padding:8px 10px; font-size:12px; ' +
                         'line-height:1.5; max-width:360px; box-shadow:0 4px 12px rgba(0,0,0,0.4);';
      el.innerHTML = s;   // trusted: built by our shaper, source values are escaped
      return el;
    }
    for (const n of nodes) if (n.title) n.title = htmlTitle(n.title);
    for (const e of edges) if (e.title) e.title = htmlTitle(e.title);

    let nodesDs, edgesDs, network;
    try {
      nodesDs = new vis.DataSet(nodes);
      edgesDs = new vis.DataSet(edges);
      network = new vis.Network(
        document.getElementById('graph'),
        { nodes: nodesDs, edges: edgesDs },
        {
          nodes: { font: { color: '#eaeaea', size: 13, face: '-apple-system, sans-serif' }, borderWidth: 1 },
          edges: { width: 1, font: { color: '#9aa1a8', size: 10, strokeWidth: 0, align: 'middle' } },
          // improvedLayout pre-positioner bails on graphs > ~150 nodes with the
          // hint "could not be positioned by this version" — leaving every node
          // stacked at (0,0). Disable it so physics alone arranges the layout.
          layout: { improvedLayout: false },
          physics: {
            stabilization: { iterations: 300, fit: true },
            barnesHut: { gravitationalConstant: -3500, springLength: 140, springConstant: 0.04, avoidOverlap: 0.2 },
          },
          interaction: { hover: true, tooltipDelay: 100, navigationButtons: true, keyboard: true },
        }
      );
    } catch (err) {
      fatal('Failed to initialise the graph', String(err && err.stack || err) +
        '\\n\\nnodes=' + (nodes || []).length + '  edges=' + (edges || []).length);
      throw err;
    }
    console.log('[click-graph] rendered', nodes.length, 'nodes /', edges.length, 'edges');

    // ── Per-type filter toggles + search (combined) ───────────────────────
    // A node is shown when its _kind is enabled AND it matches the search.
    // Build one checkbox per distinct entity kind present in the graph.
    const KIND_META = {
      page:    { label: 'Pages',    color: '#4682b4' },
      route:   { label: 'Routes',   color: '#7b68ee' },
      intent:  { label: 'Intents',  color: '#3cb371' },
      form:    { label: 'Forms',    color: '#ffd964' },
      api:     { label: 'APIs',     color: '#f0ad4e' },
      state:   { label: 'States',   color: '#20b2aa' },
      control: { label: 'Controls', color: '#e26fce' },
    };
    const kindCounts = {};
    for (const n of nodes) kindCounts[n._kind] = (kindCounts[n._kind] || 0) + 1;
    const activeKinds = new Set(Object.keys(kindCounts));
    const filtersEl = document.getElementById('typeFilters');
    for (const kind of Object.keys(KIND_META)) {
      if (!kindCounts[kind]) continue;
      const meta2 = KIND_META[kind];
      const row = document.createElement('label');
      row.className = 'filter-row';
      row.innerHTML = '<input type="checkbox" checked data-kind="' + kind + '">'
        + '<span class="legend-swatch" style="background:' + meta2.color + '"></span>'
        + escapeText(meta2.label)
        + '<span class="cnt">' + kindCounts[kind] + '</span>';
      row.querySelector('input').addEventListener('change', (ev) => {
        if (ev.target.checked) activeKinds.add(kind); else activeKinds.delete(kind);
        applyFilters();
      });
      filtersEl.appendChild(row);
    }

    // Adjacency (vis numeric ids) for neighbour-isolation on node click.
    const adj = new Map();
    const edgeId = (e) => e.id ?? \`\${e.from}->\${e.to}-\${e.label || ''}\`;
    for (const e of edges) {
      if (!adj.has(e.from)) adj.set(e.from, new Set());
      if (!adj.has(e.to))   adj.set(e.to, new Set());
      adj.get(e.from).add(e.to);
      adj.get(e.to).add(e.from);
    }
    // When a node is focused (clicked), the graph collapses to that node + its
    // direct neighbours and the edges between them. Click empty space to clear.
    let focusedId = null;

    function applyFilters() {
      const q = (document.getElementById('search').value || '').trim().toLowerCase();
      let keep, edgeVisible;
      if (focusedId != null) {
        // Focus view: show the clicked node + everything it connects to,
        // overriding type/search filters so no connection is hidden.
        keep = new Set([focusedId, ...(adj.get(focusedId) || [])]);
        edgeVisible = (e) => e.from === focusedId || e.to === focusedId;
      } else {
        keep = new Set();
        for (const n of nodes) {
          if (!activeKinds.has(n._kind)) continue;
          const hay = (n.label + ' ' + (n._raw ? JSON.stringify(n._raw) : '')).toLowerCase();
          if (!q || hay.includes(q)) keep.add(n.id);
        }
        edgeVisible = (e) => keep.has(e.from) && keep.has(e.to);
      }
      nodesDs.update(nodes.map(n => ({ id: n.id, hidden: !keep.has(n.id) })));
      edgesDs.update(edges.map(e => ({ id: edgeId(e), hidden: !edgeVisible(e) })));
    }
    document.getElementById('search').addEventListener('input', applyFilters);

    // Click a node → isolate it + its neighbours; click empty canvas → restore.
    network.on('click', (params) => {
      const next = (params.nodes && params.nodes.length) ? params.nodes[0] : null;
      if (next === focusedId) return;     // no change (re-click same node)
      focusedId = next;
      applyFilters();
    });

    // Pause/resume physics
    let physicsOn = true;
    document.getElementById('togglePhysics').addEventListener('click', (e) => {
      physicsOn = !physicsOn;
      network.setOptions({ physics: { enabled: physicsOn } });
      e.target.textContent = physicsOn ? '⏸ pause' : '▶ resume';
    });

    // Fit
    document.getElementById('fit').addEventListener('click', () => network.fit({ animation: { duration: 300 } }));
    network.once('stabilizationIterationsDone', () => {
      network.setOptions({ physics: { enabled: false } });
      physicsOn = false;
      document.getElementById('togglePhysics').textContent = '▶ resume';
      // Re-fit explicitly — stabilization.fit can miss on big graphs.
      network.fit({ animation: { duration: 400 } });
    });
    // Safety net: if the graph isn't visible 3s after page load (e.g.
    // physics still running with no stabilization event), force a fit.
    setTimeout(() => { try { network.fit(); } catch {} }, 3000);

    // Click → inspector
    const sel = document.getElementById('selection');
    network.on('selectNode', ({ nodes: ids }) => {
      const n = nodesDs.get(ids[0]);
      if (!n) return;
      sel.innerHTML = renderInspector(n);
    });
    network.on('deselectNode', () => { sel.innerHTML = '<div class="placeholder">Click a node to inspect.</div>'; });

    function renderInspector(n) {
      const raw = n._raw || {};
      const rows = Object.entries(raw)
        .filter(([k]) => !k.startsWith('_'))
        .map(([k, v]) => '<div><span class="key">' + escapeText(k) + ':</span> ' + renderValue(v) + '</div>')
        .join('');
      return '<h3 style="margin:0 0 6px 0">' + escapeText(n.label) + '</h3>' +
             '<div class="key" style="margin-bottom:8px">' + escapeText(n._kind) + '</div>' + rows;
    }

    function renderValue(v) {
      if (v == null) return '<i>null</i>';
      if (typeof v === 'object') return '<code>' + escapeText(JSON.stringify(v)) + '</code>';
      if (typeof v === 'boolean') return v ? '<b>true</b>' : 'false';
      return escapeText(String(v));
    }
  </script>
</body>
</html>`;
}


function dirname(p) {
  return p.slice(0, Math.max(0, p.lastIndexOf('/')));
}

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
