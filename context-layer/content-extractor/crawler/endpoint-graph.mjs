// Interactive endpoint-graph viewer.
//
// Bipartite force-directed graph: frontend pages ↔ backend endpoints they
// trigger. Click any node to inspect: pages show their triggered endpoints,
// endpoints show samples + which pages triggered them + status codes + auth.
//
// Reads:  output/crawler/data/routes.json + pages.json
// Writes: output/crawler/reports/endpoint-graph.html
//
// Same vis-network library as graph.html — self-contained HTML, no build.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const OUT_DIR = path.join(REPO_ROOT, 'output', process.env.CRAWLER_OUT_DIR_NAME || 'crawler');
const DATA_DIR = path.join(OUT_DIR, 'data');
const REPORTS_DIR = path.join(OUT_DIR, 'reports');
const ROUTES_JSON = path.join(DATA_DIR, 'routes.json');
const OUT_HTML = path.join(REPORTS_DIR, 'endpoint-graph.html');
fs.mkdirSync(REPORTS_DIR, { recursive: true });

if (!fs.existsSync(ROUTES_JSON)) {
  console.error(`[endpoint-graph] missing ${ROUTES_JSON}. Run \`node analyze.mjs\` first.`);
  process.exit(1);
}
const routes = JSON.parse(fs.readFileSync(ROUTES_JSON, 'utf8'));

// HTTP-method color palette.
const METHOD_COLORS = {
  GET:    '#10b981',
  POST:   '#f59e0b',
  PUT:    '#3b82f6',
  PATCH:  '#8b5cf6',
  DELETE: '#ef4444',
  HEAD:   '#9ca3af',
  OPTIONS:'#6b7280',
};
const PAGE_COLOR = '#1f2937';

function shortPath(url) {
  try { const u = new URL(url); return u.pathname + (u.search || ''); } catch { return url; }
}

function fmtBody(obj) {
  if (obj == null) return '<i>n/a</i>';
  let s = JSON.stringify(obj, null, 2);
  if (s.length > 1500) s = s.slice(0, 1500) + '\n…';
  return `<pre style="margin:0;padding:8px;background:#f3f4f6;border-radius:4px;font-size:11px;overflow:auto;max-height:300px">${s.replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</pre>`;
}

const nodes = [];
const edges = [];
const nodeMap = new Map();

// Index endpoints by full id (METHOD origin+path) for edge lookup
const endpoints = (routes.endpoints || []).filter(e => e.isApi);
for (const e of endpoints) {
  const id = `EP:${e.method} ${e.origin}${e.path}`;
  const label = `${e.method} ${e.path}`;
  const statusList = Object.entries(e.statusCounts).map(([s, n]) => `${s}×${n}`).join(', ');
  const auth = e.observedAuth?.bearer ? 'bearer' : e.observedAuth?.cookie ? 'cookie' : 'none';
  const tooltip = [
    `${e.method} ${e.origin}${e.path}`,
    `samples: ${e.samples}`,
    `status: ${statusList}`,
    `auth: ${auth}`,
    `avg ${e.avgRequestMs}ms · ${e.avgResponseBytes}B`,
  ].join('\n');
  const detailHtml = [
    `<h3>${label}</h3>`,
    `<div><b>URL:</b> <code>${e.origin}${e.path}</code></div>`,
    `<div><b>Samples:</b> ${e.samples} · <b>Auth:</b> ${auth}</div>`,
    `<div><b>Status:</b> ${statusList}</div>`,
    `<div><b>Avg request:</b> ${e.avgRequestMs}ms · <b>Avg response:</b> ${e.avgResponseBytes}B</div>`,
    `<div><b>Query params:</b> ${e.queryParamNames.join(', ') || '<i>none</i>'}</div>`,
    `<div><b>Triggered by ${e.triggeredByPages.length} page(s):</b><ul style="margin:4px 0;padding-left:18px">${e.triggeredByPages.slice(0, 8).map(p => `<li><code>${shortPath(p)}</code></li>`).join('')}${e.triggeredByPages.length > 8 ? `<li>… ${e.triggeredByPages.length - 8} more</li>` : ''}</ul></div>`,
    e.observedJwtClaims?.length ? `<div><b>JWT claims observed:</b>${fmtBody(e.observedJwtClaims[0])}</div>` : '',
    e.exampleRequestBodies?.length ? `<div><b>Sample request body:</b>${fmtBody(e.exampleRequestBodies[0])}</div>` : '',
    Object.keys(e.exampleResponseBodiesByStatus || {}).length
      ? `<div><b>Sample response body:</b>${fmtBody(e.exampleResponseBodiesByStatus[Object.keys(e.exampleResponseBodiesByStatus)[0]])}</div>`
      : '',
  ].join('');

  const node = {
    id, label,
    title: tooltip,
    shape: 'box',
    color: { background: METHOD_COLORS[e.method] || '#94a3b8', border: '#1f2937' },
    font: { color: 'white', size: 11, face: 'monospace' },
    size: 16 + Math.min(20, Math.log2(e.samples + 1) * 4),
    group: 'endpoint',
    _detail: detailHtml,
  };
  nodes.push(node);
  nodeMap.set(id, node);
}

// Add page nodes for any page that triggers at least one API.
const pageTriggers = new Map(); // pageUrl -> Set of endpoint ids it triggers
for (const p of routes.pages || []) {
  if (!p.triggeredApis || p.triggeredApis.length === 0) continue;
  pageTriggers.set(p.url, new Set(p.triggeredApis.map(t => `EP:${t}`)));
}

for (const [pageUrl, triggers] of pageTriggers.entries()) {
  const id = `PG:${pageUrl}`;
  if (nodeMap.has(id)) continue;
  const label = shortPath(pageUrl);
  const triggeredList = [...triggers].filter(t => nodeMap.has(t)).slice(0, 8);
  const detailHtml = [
    `<h3>${label}</h3>`,
    `<div><b>Frontend page</b></div>`,
    `<div><b>URL:</b> <code>${pageUrl}</code></div>`,
    `<div><b>Triggers ${triggers.size} backend endpoint(s):</b><ul style="margin:4px 0;padding-left:18px">${triggeredList.map(t => `<li><code>${t.slice(3)}</code></li>`).join('')}${triggers.size > 8 ? `<li>… ${triggers.size - 8} more</li>` : ''}</ul></div>`,
  ].join('');
  const node = {
    id, label,
    title: `${label}\n${triggers.size} APIs triggered`,
    shape: 'ellipse',
    color: { background: PAGE_COLOR, border: '#111827' },
    font: { color: 'white', size: 11 },
    size: 14,
    group: 'page',
    _detail: detailHtml,
  };
  nodes.push(node);
  nodeMap.set(id, node);
}

// Edges: page -> endpoint
for (const [pageUrl, triggers] of pageTriggers.entries()) {
  const fromId = `PG:${pageUrl}`;
  for (const tId of triggers) {
    if (!nodeMap.has(tId)) continue;
    edges.push({
      from: fromId, to: tId,
      arrows: 'to',
      color: { color: '#cbd5e1', opacity: 0.4 },
      width: 1,
      smooth: { type: 'continuous' },
    });
  }
}

const counts = {
  endpoints: nodes.filter(n => n.group === 'endpoint').length,
  pages: nodes.filter(n => n.group === 'page').length,
  edges: edges.length,
  methods: [...new Set(endpoints.map(e => e.method))].sort(),
};

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Endpoint graph</title>
<script src="https://unpkg.com/vis-network/standalone/umd/vis-network.min.js"></script>
<style>
  html, body { margin:0; padding:0; height:100%; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; background:#0f172a; color:#e2e8f0; }
  #header { padding:10px 16px; background:#1e293b; border-bottom:1px solid #334155; display:flex; gap:20px; flex-wrap:wrap; align-items:center; font-size:13px; }
  #header h1 { margin:0; font-size:16px; }
  #header .stats { color:#94a3b8; }
  #legend { display:flex; gap:14px; flex-wrap:wrap; font-size:11px; align-items:center; }
  #legend .swatch { display:inline-block; width:12px; height:12px; border-radius:3px; vertical-align:middle; margin-right:4px; }
  #graph { width:100%; height:calc(100vh - 56px); background:#0f172a; }
  #side { position:fixed; right:12px; top:72px; width:380px; max-height:calc(100vh - 96px); overflow:auto; background:#1e293b; border:1px solid #334155; border-radius:8px; padding:14px; box-shadow:0 4px 20px rgba(0,0,0,0.4); font-size:12px; display:none; color:#e2e8f0; }
  #side code { background:#334155; padding:1px 5px; border-radius:3px; font-size:11px; }
  #side h3 { margin:0 0 10px; font-size:14px; color:white; }
  #side ul { color:#cbd5e1; }
  #search { padding:4px 8px; border:1px solid #334155; border-radius:4px; font-size:12px; width:220px; background:#0f172a; color:#e2e8f0; }
</style>
</head>
<body>
<div id="header">
  <h1>Endpoint graph</h1>
  <span class="stats">${counts.endpoints} APIs · ${counts.pages} pages · ${counts.edges} page→API edges</span>
  <input id="search" placeholder="Search path or method…" autocomplete="off">
  <div id="legend">
    <span><span class="swatch" style="background:${PAGE_COLOR}"></span>frontend page</span>
    ${counts.methods.map(m => `<span><span class="swatch" style="background:${METHOD_COLORS[m] || '#94a3b8'}"></span>${m}</span>`).join('')}
  </div>
</div>
<div id="graph"></div>
<aside id="side"></aside>
<script>
const nodes = new vis.DataSet(${JSON.stringify(nodes)});
const edges = new vis.DataSet(${JSON.stringify(edges)});
const network = new vis.Network(document.getElementById('graph'), { nodes, edges }, {
  layout: { improvedLayout: true },
  physics: {
    enabled: true,
    solver: 'forceAtlas2Based',
    forceAtlas2Based: { gravitationalConstant: -80, springLength: 140, springConstant: 0.06, damping: 0.5 },
    stabilization: { iterations: 200 },
  },
  nodes: { borderWidth: 1, font: { size: 11 } },
  edges: { arrows: { to: { scaleFactor: 0.4 } } },
  interaction: { hover: true, multiselect: true, navigationButtons: true, keyboard: true },
});

const side = document.getElementById('side');
network.on('selectNode', params => {
  const n = nodes.get(params.nodes[0]);
  side.style.display = 'block';
  side.innerHTML = n._detail || (n.label + '<br>' + n.id);
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
console.log(`[endpoint-graph] wrote ${path.relative(REPO_ROOT, OUT_HTML)}  (${counts.endpoints} endpoints, ${counts.pages} pages, ${counts.edges} edges)`);
