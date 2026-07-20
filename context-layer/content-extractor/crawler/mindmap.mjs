// Renders mindmap.md from output/crawler/routes.json + click-graph.json:
//   1. Mermaid `mindmap` — sections → pages → backend APIs they call
//   2. Mermaid `flowchart` — navigation/redirect flow between pages
//   3. Mermaid `flowchart` — click graph (page → page via button click)
//   4. Plain-text fallback
//
// Reads:  output/crawler/routes.json       (required — from analyze.mjs)
//         output/crawler/click-graph.json  (optional — from crawl.mjs INTERACT_MODE=1)
// Writes: output/crawler/api-spec/mindmap.md

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const OUT_DIR = path.join(REPO_ROOT, 'output', process.env.CRAWLER_OUT_DIR_NAME || 'crawler');
const DATA_DIR = path.join(OUT_DIR, 'data');
const ROUTES_JSON = path.join(DATA_DIR, 'routes.json');
const OUT = path.join(OUT_DIR, 'reports', 'mindmap.md');
fs.mkdirSync(path.dirname(OUT), { recursive: true });

if (!fs.existsSync(ROUTES_JSON)) {
  console.error(`[mindmap] missing ${ROUTES_JSON}. Run \`node analyze.mjs\` first.`);
  process.exit(1);
}
const routes = JSON.parse(fs.readFileSync(ROUTES_JSON, 'utf8'));

const CLICK_GRAPH_JSON = path.join(DATA_DIR, 'click-graph.json');
const clickGraph = fs.existsSync(CLICK_GRAPH_JSON)
  ? JSON.parse(fs.readFileSync(CLICK_GRAPH_JSON, 'utf8'))
  : null;

const mq = s => `["${String(s).replace(/"/g, '\\"')}"]`;
const safeId = s => 'n_' + s.replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 60);

// Mindmap root label: derive from frontend origin's hostname unless overridden.
const MINDMAP_ROOT = process.env.MINDMAP_ROOT || (() => {
  try { return new URL(routes.summary.origins[0]).hostname.split('.')[0]; }
  catch { return 'app'; }
})();

// ----- section 1: mindmap tree -----
const pageBySection = new Map();
for (const p of routes.pages) {
  if (!pageBySection.has(p.section)) pageBySection.set(p.section, []);
  pageBySection.get(p.section).push(p);
}
// Section ordering: well-known sections first, then everything else alphabetical.
const PREFERRED = ['Auth', 'Dashboard', 'Admin', 'Profile'];
const SECTION_ORDER = [
  ...PREFERRED.filter(s => pageBySection.has(s)),
  ...[...pageBySection.keys()].filter(s => !PREFERRED.includes(s) && s !== 'Other').sort(),
  ...(pageBySection.has('Other') ? ['Other'] : []),
];

const lines = [];
lines.push('# Application mindmap');
lines.push('');
lines.push(`Generated: ${routes.generatedAt}.`);
lines.push(`Source: \`output/crawler/routes.json\` (Crawlee + Playwright crawl).`);
lines.push('');
lines.push(`Summary: **${routes.summary.totalEndpoints} endpoints** (${routes.summary.apiEndpoints} APIs), **${routes.summary.totalPages} pages** across ${routes.summary.origins.length} origins.`);
lines.push('');
lines.push('## Application structure');
lines.push('');
lines.push('```mermaid');
lines.push('mindmap');
lines.push(`  root((${MINDMAP_ROOT}))`);
for (const sect of SECTION_ORDER) {
  if (!pageBySection.has(sect)) continue;
  lines.push(`    ${mq(sect)}`);
  const sorted = pageBySection.get(sect).sort((a, b) => a.url.localeCompare(b.url));
  for (const p of sorted) {
    const u = new URL(p.url);
    const pageLabel = u.pathname + (u.search || '');
    lines.push(`      ${mq(pageLabel)}`);
    for (const t of p.triggeredApis.sort()) {
      lines.push(`        ${mq(t.replace(/https?:\/\/[^\/]+/, ''))}`);
    }
  }
}
lines.push('```');
lines.push('');

// ----- section 2: navigation/redirect flow -----
const nav = routes.clientNavRedirects || [];
const srv = routes.serverRedirects || [];
lines.push('## Navigation & redirect flow');
lines.push('');
if (nav.length === 0 && srv.length === 0) {
  lines.push('_No redirects observed during this crawl._');
} else {
  lines.push(`Observed **${srv.length} server-side** + **${nav.length} client-side** redirect(s).`);
  lines.push('');
  lines.push('```mermaid');
  lines.push('flowchart LR');
  const seenNode = new Set();
  function node(p) {
    const id = safeId(p);
    if (!seenNode.has(id)) {
      lines.push(`  ${id}["${p}"]`);
      seenNode.add(id);
    }
    return id;
  }
  for (const r of srv) {
    const a = node(r.from);
    const b = node(r.to);
    const label = r.status ? `${r.status}` : 'server';
    lines.push(`  ${a} -->|"${label}"| ${b}`);
  }
  for (const r of nav) {
    const a = node(r.from);
    const b = node(r.to);
    lines.push(`  ${a} -.->|"client (${r.phase})"| ${b}`);
  }
  lines.push('```');
  lines.push('');
  lines.push('Solid arrows = HTTP 3xx / Playwright `redirectedFrom`. Dashed arrows = client-side router push (URL changes without 3xx).');
}
lines.push('');

// ----- section 3: click graph (from INTERACT_MODE run) -----
if (clickGraph) {
  const edges = clickGraph.edges || [];
  const navEdges = edges.filter(e => e.hadNav);
  const xhrEdges = edges.filter(e => !e.hadNav);
  lines.push('## Click graph');
  lines.push('');
  lines.push(`From the INTERACT_MODE pass. Pages visited: **${(clickGraph.nodes || []).length}**, edges: **${edges.length}** (${navEdges.length} navigations, ${xhrEdges.length} in-page XHRs), pages discovered via click: **${(clickGraph.discoveredViaClick || []).length}**.`);
  lines.push('');
  if (edges.length === 0) {
    lines.push('_No clickable candidates exercised — every button was either destructive, in a form, or duplicate of one already clicked._');
  } else {
    lines.push('```mermaid');
    lines.push('flowchart LR');
    const cgSeen = new Set();
    function cgNode(u) {
      const id = 'c_' + safeId(u);
      if (!cgSeen.has(id)) {
        let label = u;
        try { const url = new URL(u); label = url.pathname + (url.search || ''); } catch {}
        lines.push(`  ${id}["${label}"]`);
        cgSeen.add(id);
      }
      return id;
    }
    for (const e of navEdges) {
      const a = cgNode(e.from), b = cgNode(e.to);
      lines.push(`  ${a} -->|"${e.button.replace(/"/g, '\\"').slice(0, 30)}"| ${b}`);
    }
    lines.push('```');
    lines.push('');
    lines.push('Arrows show URL-changing clicks. In-page clicks (modals, tab toggles, pagination) are recorded as edges with `hadNav:false` in `click-graph.json` but omitted from the diagram for readability.');
  }

  if (xhrEdges.length) {
    lines.push('');
    lines.push('### In-page clicks (no URL change)');
    lines.push('');
    lines.push('| Page | Button | Triggered |');
    lines.push('|---|---|---|');
    for (const e of xhrEdges.slice(0, 50)) {
      let p = e.from; try { p = new URL(e.from).pathname; } catch {}
      lines.push(`| \`${p}\` | "${e.button}" | XHR/fetch only |`);
    }
  }
  lines.push('');
}

// ----- section 4: plain-text fallback -----
lines.push('## Plain text');
lines.push('');
for (const sect of SECTION_ORDER) {
  if (!pageBySection.has(sect)) continue;
  lines.push(`### ${sect}`);
  for (const p of pageBySection.get(sect).sort((a, b) => a.url.localeCompare(b.url))) {
    const u = new URL(p.url);
    const pageLabel = u.pathname + (u.search || '');
    const triggers = p.triggeredApis;
    if (triggers.length === 0) {
      lines.push(`- **${pageLabel}** — no backend API calls`);
    } else {
      lines.push(`- **${pageLabel}**`);
      for (const t of triggers.sort()) lines.push(`  - \`${t.replace(/https?:\/\/[^\/]+/, '')}\``);
    }
  }
  lines.push('');
}
if (nav.length || srv.length) {
  lines.push('### Redirects observed');
  for (const r of srv) lines.push(`- 🔁 \`${r.from}\` → \`${r.to}\` (HTTP ${r.status || 'n/a'})`);
  for (const r of nav) lines.push(`- ↪️ \`${r.from}\` → \`${r.to}\` (client / ${r.phase})`);
  lines.push('');
}

fs.writeFileSync(OUT, lines.join('\n'));
console.log(`[mindmap] wrote ${path.relative(REPO_ROOT, OUT)}`);
console.log(`[mindmap] pages=${routes.pages.length} redirects=${srv.length}+${nav.length}`);
