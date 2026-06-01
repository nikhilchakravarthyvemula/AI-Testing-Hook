// ui-routes shaper — frontend-only sitemap.
//
// Two node types — no APIs, no intents, no forms (those live in the
// click-graph). The point here is to see at a glance: what routes does
// the frontend declare, and which of them did the crawler actually reach?
//
//   route (purple)      declared frontend route from a code extractor
//                       (Next.js, react-router, vue-router, sveltekit, …)
//   page  (blue)        URL the crawler reached at runtime
//   page  (blue dashed) URL referenced but never crawled (404, deep nav, …)
//
// Edges:
//   route → page   "realizes" — pattern matches a crawled URL
//   page  → page   "navigates" — observed page→page transition
//
// Source files:
//   output/indexed_output/routes.json
//   output/indexed_output/pages.json

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

const PALETTE = Object.freeze({
  route:         { background: '#7b68ee', border: '#3d3475', highlight: { background: '#9384ee', border: '#3d3475' } },
  pageVisited:   { background: '#4682b4', border: '#1f4d6e', highlight: { background: '#5a96c8', border: '#1f4d6e' } },
  pageUnvisited: { background: '#a8c5dc', border: '#4682b4', highlight: { background: '#bcd4e6', border: '#1f4d6e' } },
});

const EDGE_STYLE = Object.freeze({
  realizes:  { color: '#7b68ee', dashes: [2, 4], width: 1 },
  navigates: { color: '#4682b4', dashes: false,  width: 1 },
});

export const sourceFile = 'output/indexed_output/routes.json';   // shaper reads multiple; this is the canonical "do I exist" check
export const outputFile = 'ui-routes.html';
export const title      = 'UI Routes — declared frontend routes × crawled pages';


/**
 * @param {Object} _bundle  the loaded routes.json (we also read pages.json
 *                          + click-graph.json directly).
 */
export function shape(_bundle) {
  // We need routes (for declared-route nodes), pages (for crawled-page
  // nodes), AND click-graph (for the page→page nav edges that the indexer
  // already extracted from the walker's per-edge `relation:'navigates_to'`).
  // The framework hands `_bundle` from `sourceFile`; this shaper joins
  // three sources because that's what "UI routes graph" actually means.
  const routesJson     = _bundle;
  const pagesJson      = _safeRead(path.join(REPO_ROOT, 'output', 'indexed_output', 'pages.json'));
  const clickGraphJson = _safeRead(path.join(REPO_ROOT, 'output', 'indexed_output', 'click-graph.json'));

  const routes = (routesJson?.items ?? []).map(it => it.primary);
  const pages  = (pagesJson?.items  ?? []).map(it => it.primary);

  if (routes.length === 0 && pages.length === 0) {
    return { nodes: [], edges: [], meta: { empty: true, reason: 'no routes or pages indexed' } };
  }

  // Numeric IDs for vis-network.
  const idMap = new Map();
  const visId = (key) => {
    if (idMap.has(key)) return idMap.get(key);
    const id = idMap.size + 1;
    idMap.set(key, id);
    return id;
  };

  const nodes = [];

  // ── route nodes ────────────────────────────────────────────────────────
  for (const r of routes) {
    const pattern = r.pattern ?? r.path ?? r.route ?? null;
    if (!pattern) continue;
    const fw = r.framework ?? 'frontend';
    const key = `route:${fw}:${pattern}`;
    nodes.push({
      id: visId(key),
      label: pattern,
      title: _tooltipRoute(r, pattern, fw),
      group: 'route',
      color: PALETTE.route,
      shape: 'box',
      shapeProperties: { borderRadius: 12 },
      _kind: 'route', _raw: { framework: fw, pattern, ...r },
    });
  }

  // ── page nodes ─────────────────────────────────────────────────────────
  const pageByUrl = new Map();
  for (const p of pages) {
    const url = p.url || p.requestedUrl || p.finalUrl;
    if (!url) continue;
    const key = `page:${url}`;
    if (pageByUrl.has(key)) continue;
    pageByUrl.set(key, p);
    const visited = p.visited !== false;
    nodes.push({
      id: visId(key),
      label: _shortPath(url),
      title: _tooltipPage(p, url, visited),
      group: visited ? 'page' : 'page-unvisited',
      color: visited ? PALETTE.pageVisited : PALETTE.pageUnvisited,
      shape: 'box',
      borderWidth: visited ? 2 : 1,
      shapeProperties: visited ? undefined : { borderDashes: [4, 4] },
      _kind: 'page', _raw: p,
    });
  }

  // ── edges: route → page (pattern match) ────────────────────────────────
  const edges = [];
  for (const r of routes) {
    const pattern = r.pattern ?? r.path ?? r.route ?? null;
    if (!pattern) continue;
    const fw = r.framework ?? 'frontend';
    const fromId = visId(`route:${fw}:${pattern}`);
    const re = _patternToRegex(pattern);
    if (!re) continue;
    for (const [pageKey, p] of pageByUrl) {
      const url = p.url || p.requestedUrl || p.finalUrl;
      if (!url) continue;
      let urlPath;
      try { urlPath = new URL(url).pathname; } catch { continue; }
      if (!re.test(urlPath)) continue;
      edges.push({
        from: fromId,
        to: visId(pageKey),
        arrows: 'to',
        color: { color: EDGE_STYLE.realizes.color, opacity: 0.65 },
        dashes: EDGE_STYLE.realizes.dashes,
        width: EDGE_STYLE.realizes.width,
        title: _tooltipEdge('realizes', pattern, urlPath),
        smooth: { type: 'dynamic' },
        _raw: { relation: 'realizes', pattern, urlPath },
      });
    }
  }

  // ── edges: page → page (observed navigations from the click-graph) ────
  //
  // The walker captures every click that produced a URL change as an
  // edge in click-graph.json with relation='navigates_to'. We mirror
  // those into the UI-routes view, deduping by (fromUrl, toUrl). This
  // is what turns the previous "11 nodes / 0 edges" empty graph into
  // an actual navigable site map.
  //
  // Why we read click-graph instead of pages.outgoingNavigations: the
  // indexer's pages topic never populates outgoingNavigations from the
  // walker's edges — the per-edge data lives in the click-graph topic.
  // Joining via the indexed click-graph means we don't have to change
  // the pages topic + we get the same dedup semantics for free.
  const cgEdges = clickGraphJson?.items?.[0]?.primary?.edges ?? [];
  const navSeen = new Set();
  let navEdgesAdded = 0, navEdgesSkipped = 0;
  for (const e of cgEdges) {
    // The indexed click-graph stores nav edges as relation='navigates_to'.
    // (The walker's raw edges use kind='nav'; the indexer renames it.)
    if (e.relation !== 'navigates_to') continue;
    if (!e.from || !e.to) continue;
    // The click-graph IDs are `page:<url>` strings — extract the URL.
    const fromUrl = String(e.from).replace(/^page:/, '');
    const toUrl   = String(e.to).replace(/^page:/,   '');
    // Some intent → page edges share the navigates_to relation but the
    // from-side is an intent id, not a page. Skip those.
    if (fromUrl === e.from && !pageByUrl.has(`page:${fromUrl}`)) { navEdgesSkipped++; continue; }
    const fromKey = `page:${fromUrl}`;
    const toKey   = `page:${toUrl}`;
    if (!pageByUrl.has(fromKey) || !pageByUrl.has(toKey)) { navEdgesSkipped++; continue; }
    const dedupKey = `${fromKey}::${toKey}`;
    if (navSeen.has(dedupKey)) continue;
    navSeen.add(dedupKey);
    edges.push({
      from: visId(fromKey),
      to: visId(toKey),
      arrows: 'to',
      color: { color: EDGE_STYLE.navigates.color, opacity: 0.55 },
      width: EDGE_STYLE.navigates.width,
      title: _tooltipEdge('navigates', fromUrl, toUrl),
      smooth: { type: 'dynamic' },
      _raw: { relation: 'navigates', via: e.via || 'click' },
    });
    navEdgesAdded++;
  }

  // Match orphan pages (visited but no declared route matched) — show them
  // separately so it's obvious which crawled URLs aren't documented by any
  // frontend extractor.
  const matchedPageIds = new Set(edges.filter(e => e._raw?.relation === 'realizes').map(e => e.to));
  let orphanCount = 0;
  for (const node of nodes) {
    if (node._kind === 'page' && node.group === 'page' && !matchedPageIds.has(node.id)) {
      orphanCount++;
    }
  }

  const meta = {
    title: 'UI Routes',
    subtitle: `${routes.length} declared routes · ${pageByUrl.size} crawled pages · ${edges.length} edges · ${orphanCount} orphan page(s) (visited but no matching route)`,
    generatedAt: routesJson?.generatedAt ?? pagesJson?.generatedAt ?? null,
    target: routesJson?.target ?? pagesJson?.target ?? null,
    counts: {
      routes: routes.length,
      pagesVisited: [...pageByUrl.values()].filter(p => p.visited !== false).length,
      pagesUnvisited: [...pageByUrl.values()].filter(p => p.visited === false).length,
      edges: edges.length,
      orphans: orphanCount,
    },
    legend: [
      { color: PALETTE.route.background,         label: 'Declared frontend route' },
      { color: PALETTE.pageVisited.background,   label: 'Page (crawled)' },
      { color: PALETTE.pageUnvisited.background, label: 'Page (referenced, not crawled)' },
    ],
  };
  return { nodes, edges, meta };
}


// ── helpers ────────────────────────────────────────────────────────────────


function _patternToRegex(pattern) {
  // Convert a route pattern like `/users/[id]` or `/users/:id` or
  // `/users/{id}` into a regex that matches a concrete pathname.
  // Strict — anchored to start/end so we don't false-match prefixes.
  if (!pattern || typeof pattern !== 'string') return null;
  let src = pattern;
  // Next.js / Remix bracket-style: [id] or [...slug]
  src = src.replace(/\[\.\.\..+?\]/g, '.+');
  src = src.replace(/\[.+?\]/g, '[^/]+');
  // Express / react-router colon: :id
  src = src.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, '[^/]+');
  // OpenAPI curly: {id}
  src = src.replace(/\{[^}]+\}/g, '[^/]+');
  // Trailing slash optional.
  src = src.replace(/\/$/, '');
  try { return new RegExp(`^${src}\\/?$`); } catch { return null; }
}


function _safeRead(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}


function _shortPath(url) {
  try {
    const u = new URL(url);
    const p = u.pathname + (u.search || '');
    return p.length > 36 ? p.slice(0, 35) + '…' : (p || u.host);
  } catch {
    return (url || '').slice(0, 36);
  }
}


function _tooltipRoute(r, pattern, framework) {
  return [
    `<b>Route</b>: <code>${_esc(pattern)}</code>`,
    `Framework: <b>${_esc(framework)}</b>`,
    r.file       ? `File: <code>${_esc(r.file)}</code>` : null,
    r.component  ? `Component: <code>${_esc(r.component)}</code>` : null,
  ].filter(Boolean).join('<br/>');
}


function _tooltipPage(p, url, visited) {
  return [
    `<b>Page</b>: <code>${_esc(url)}</code>`,
    p.title    ? `<i>${_esc(p.title)}</i>` : null,
    p.section  ? `Section: ${_esc(p.section)}` : null,
    !visited   ? '<span style="color:#999">[not crawled]</span>' : null,
  ].filter(Boolean).join('<br/>');
}


function _tooltipEdge(rel, from, to) {
  return `<b>${_esc(rel)}</b>: <code>${_esc(from)}</code> → <code>${_esc(to)}</code>`;
}


function _esc(s) {
  if (typeof s !== 'string') return String(s ?? '');
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
