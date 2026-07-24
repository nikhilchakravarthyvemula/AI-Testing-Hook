// Render an interactive HTML graph viewer for the crawl.
//
// Reads:  output/crawler/click-graph.json (from INTERACT_MODE)
//         output/crawler/routes.json      (for page sections + redirects)
//         output/crawler/pages.json       (for titles)
// Writes: output/crawler/graph.html       (self-contained, opens in any browser)
//
// Uses vis-network from a CDN. Open the file in a browser, drag nodes around,
// zoom, click to highlight. No build step.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const OUT_DIR = path.join(REPO_ROOT, 'output', process.env.CRAWLER_OUT_DIR_NAME || 'crawler');
const DATA_DIR = path.join(OUT_DIR, 'data');
const REPORTS_DIR = path.join(OUT_DIR, 'reports');
const CLICK_GRAPH = path.join(DATA_DIR, 'click-graph.json');
const ROUTES_JSON = path.join(DATA_DIR, 'routes.json');
const PAGES_JSON  = path.join(DATA_DIR, 'pages.json');
const OUT_HTML    = path.join(REPORTS_DIR, 'graph.html');
fs.mkdirSync(REPORTS_DIR, { recursive: true });

const cg     = fs.existsSync(CLICK_GRAPH) ? JSON.parse(fs.readFileSync(CLICK_GRAPH, 'utf8')) : null;
const routes = fs.existsSync(ROUTES_JSON) ? JSON.parse(fs.readFileSync(ROUTES_JSON, 'utf8')) : null;
const pages  = fs.existsSync(PAGES_JSON)  ? JSON.parse(fs.readFileSync(PAGES_JSON, 'utf8'))  : null;
if (!routes) { console.error('[graph-html] routes.json missing — run analyze.mjs first'); process.exit(1); }

// Pull titles + sections from the analyzed data.
const titleByUrl = new Map();
const sectionByUrl = new Map();
for (const p of (pages?.pages || [])) {
  if (p.finalUrl) titleByUrl.set(p.finalUrl, p.title || '');
}
for (const p of (routes.pages || [])) {
  if (p.url) sectionByUrl.set(p.url, p.section || 'Other');
}

// Section → color mapping. Stable palette.
const SECTION_COLORS = {
  Auth:      '#ef4444',
  Dashboard: '#3b82f6',
  Admin:     '#a855f7',
  Profile:   '#14b8a6',
  Other:     '#9ca3af',
};
function colorFor(section) {
  if (SECTION_COLORS[section]) return SECTION_COLORS[section];
  // Hash arbitrary section names to a stable color.
  let h = 0; for (const c of section || '') h = (h * 31 + c.charCodeAt(0)) | 0;
  const palette = ['#0ea5e9', '#f59e0b', '#10b981', '#ec4899', '#8b5cf6', '#84cc16', '#06b6d4', '#f97316'];
  return palette[Math.abs(h) % palette.length];
}

// Build node + edge sets.
const nodes = new Map();
const edges = [];

function shortPath(url) {
  try { const u = new URL(url); return u.pathname + (u.search || ''); } catch { return url; }
}

function addNode(url, extra = {}) {
  if (!url) return;
  if (!nodes.has(url)) {
    const section = sectionByUrl.get(url) || 'Other';
    const title = titleByUrl.get(url) || '';
    const label = shortPath(url);
    nodes.set(url, {
      id: url,
      label,
      title: `${title ? title + '\n' : ''}${url}\nsection: ${section}`,
      color: colorFor(section),
      group: section,
      ...extra,
    });
  } else {
    Object.assign(nodes.get(url), extra);
  }
}

// Add every analyzed page as a node.
for (const p of (routes.pages || [])) addNode(p.url);

// Click-graph edges (URL-changing) → solid arrows.
let navCount = 0, xhrCount = 0;
if (cg?.edges) {
  for (const e of cg.edges) {
    addNode(e.from); addNode(e.to);
    if (e.hadNav) {
      edges.push({
        from: e.from, to: e.to,
        label: e.button.slice(0, 30),
        arrows: 'to',
        color: { color: '#2563eb', opacity: 0.6 },
        font: { size: 10, color: '#2563eb' },
      });
      navCount++;
    } else {
      // In-page click (no nav). Show as a self-loop so you can see what
      // buttons each page exposes without cluttering the layout.
      edges.push({
        from: e.from, to: e.from,
        label: e.button.slice(0, 20),
        arrows: 'to',
        dashes: true,
        color: { color: '#9ca3af', opacity: 0.5 },
        font: { size: 9, color: '#6b7280' },
      });
      xhrCount++;
    }
  }
}

// Redirects (server + client nav).
const origin = (routes.summary.origins || [])[0] || '';
function abs(maybePath) {
  if (!maybePath) return null;
  if (/^https?:/.test(maybePath)) return maybePath;
  if (!origin) return null;
  return origin + (maybePath.startsWith('/') ? maybePath : '/' + maybePath);
}
let redirCount = 0;
for (const r of (routes.clientNavRedirects || [])) {
  const a = abs(r.from), b = abs(r.to);
  if (!a || !b) continue;
  addNode(a); addNode(b);
  edges.push({
    from: a, to: b, label: 'client', arrows: 'to', dashes: true,
    color: { color: '#f59e0b', opacity: 0.6 }, font: { size: 9, color: '#92400e' },
  });
  redirCount++;
}
for (const r of (routes.serverRedirects || [])) {
  const a = abs(r.from), b = abs(r.to);
  if (!a || !b) continue;
  addNode(a); addNode(b);
  edges.push({
    from: a, to: b, label: `${r.status || 'redir'}`, arrows: 'to',
    color: { color: '#f59e0b' }, font: { size: 9, color: '#92400e' },
  });
  redirCount++;
}

const nodeArr = [...nodes.values()];
const sections = [...new Set(nodeArr.map(n => n.group))].sort();

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Crawler graph</title>
<script src="https://unpkg.com/vis-network/standalone/umd/vis-network.min.js"></script>
<style>
  html, body { margin: 0; padding: 0; height: 100%; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #fafafa; }
  #header { padding: 10px 16px; background: white; border-bottom: 1px solid #e5e7eb; display: flex; gap: 24px; flex-wrap: wrap; align-items: center; font-size: 13px; }
  #header h1 { margin: 0; font-size: 16px; }
  #header .stats { color: #6b7280; }
  #legend { display: flex; gap: 16px; flex-wrap: wrap; font-size: 11px; align-items: center; }
  #legend .swatch { display: inline-block; width: 12px; height: 12px; border-radius: 50%; vertical-align: middle; margin-right: 4px; }
  #graph { width: 100%; height: calc(100vh - 60px); background: white; }
  #side { position: fixed; right: 12px; top: 80px; width: 320px; max-height: 70vh; overflow: auto; background: white; border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.05); font-size: 12px; display: none; }
  #side code { background: #f3f4f6; padding: 1px 4px; border-radius: 3px; }
  #side h3 { margin: 0 0 8px; font-size: 14px; }
  #search { padding: 4px 8px; border: 1px solid #d1d5db; border-radius: 4px; font-size: 12px; width: 220px; }
</style>
</head>
<body>
<div id="header">
  <h1>Crawler graph</h1>
  <span class="stats">${nodeArr.length} pages • ${navCount} click-nav • ${xhrCount} in-page • ${redirCount} redirects</span>
  <input id="search" placeholder="Search by path…" autocomplete="off">
  <div id="legend">
    ${sections.map(s => `<span><span class="swatch" style="background:${colorFor(s)}"></span>${s}</span>`).join('')}
    <span>—&nbsp;blue solid: click nav</span>
    <span>—&nbsp;orange dashed: redirect</span>
    <span>—&nbsp;grey dashed: in-page click</span>
  </div>
</div>
<div id="graph"></div>
<aside id="side"></aside>
<script>
const nodes = new vis.DataSet(${JSON.stringify(nodeArr)});
const edges = new vis.DataSet(${JSON.stringify(edges)});
const network = new vis.Network(document.getElementById('graph'), { nodes, edges }, {
  layout: { improvedLayout: true },
  physics: {
    enabled: true,
    solver: 'forceAtlas2Based',
    forceAtlas2Based: { gravitationalConstant: -50, springLength: 120, springConstant: 0.08, damping: 0.4 },
    stabilization: { iterations: 200 },
  },
  nodes: { shape: 'dot', size: 14, font: { size: 11, face: 'monospace' }, borderWidth: 1 },
  edges: { smooth: { type: 'continuous', forceDirection: 'none' }, arrows: { to: { scaleFactor: 0.5 } } },
  interaction: { hover: true, multiselect: true, navigationButtons: true, keyboard: true },
});

const side = document.getElementById('side');
network.on('selectNode', params => {
  const id = params.nodes[0];
  const n = nodes.get(id);
  const outEdges = edges.get({ filter: e => e.from === id });
  const inEdges  = edges.get({ filter: e => e.to === id });
  side.style.display = 'block';
  side.innerHTML =
    '<h3>' + (n.label || id) + '</h3>' +
    '<div><b>Section:</b> ' + n.group + '</div>' +
    '<div><b>URL:</b> <code>' + id + '</code></div>' +
    '<div style="margin-top:8px"><b>Outgoing edges (' + outEdges.length + '):</b></div>' +
    '<ul style="padding-left:18px;margin:4px 0">' + outEdges.map(e => '<li>"' + (e.label || '') + '" → ' + (nodes.get(e.to)?.label || e.to) + '</li>').join('') + '</ul>' +
    '<div><b>Incoming edges (' + inEdges.length + '):</b></div>' +
    '<ul style="padding-left:18px;margin:4px 0">' + inEdges.map(e => '<li>(' + (nodes.get(e.from)?.label || e.from) + ') "' + (e.label || '') + '"</li>').join('') + '</ul>';
});
network.on('deselectNode', () => { side.style.display = 'none'; });

document.getElementById('search').addEventListener('input', ev => {
  const q = ev.target.value.toLowerCase();
  if (!q) { nodes.forEach(n => nodes.update({ id: n.id, opacity: 1 })); return; }
  nodes.forEach(n => {
    const hit = (n.label || '').toLowerCase().includes(q) || n.id.toLowerCase().includes(q);
    nodes.update({ id: n.id, opacity: hit ? 1 : 0.15 });
  });
});
</script>
</body>
</html>`;

fs.writeFileSync(OUT_HTML, html);
console.log(`[graph-html] wrote ${path.relative(REPO_ROOT, OUT_HTML)}  (${nodeArr.length} nodes, ${edges.length} edges)`);
console.log(`[graph-html] open with: open "${OUT_HTML}"`);
