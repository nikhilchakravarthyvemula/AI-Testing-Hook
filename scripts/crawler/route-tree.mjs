// route-tree.mjs — build a clean, templatized UI route tree from the crawl.
// Reads pages.ndjson finalUrls + click-graph nav edges, templatizes ids, and
// prints a hierarchical tree (with how many concrete URLs collapse to each).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(REPO_ROOT, 'output', process.env.CRAWLER_OUT_DIR_NAME || 'crawler');

const ndjson = (p) => fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOISE = /^(_rsc|_next|state|nonce|session_state|code|code_challenge|iss|client_id|redirect_uri|response_type|response_mode|scope)$/i;
function tplVal(v) {
  if (UUID.test(v)) return '{id}';
  if (/^\d+$/.test(v)) return '{n}';
  if (/^(application|ide_ext|skill|mcp|model|unknown|api|prompt):/i.test(v)) return '{assetId}';
  if (/\.local$|^[a-z0-9-]+\.[a-z]{2,}$/i.test(v)) return '{host}';
  if (/[0-9a-f]{16,}/i.test(v)) return '{hash}';
  return v;   // keep short enums like tab=overview, from=endpoints
}
function sig(urlStr, origins) {
  let u; try { u = new URL(urlStr); } catch { return null; }
  if (!origins.has(u.origin)) return null;
  const params = [...u.searchParams]
    .filter(([k]) => !NOISE.test(k))
    .map(([k, v]) => [k, tplVal(v)])
    .sort((a, b) => a[0].localeCompare(b[0]));
  const q = params.length ? '?' + params.map(([k, v]) => `${k}=${v}`).join('&') : '';
  return u.pathname + q;
}

// frontend origins = those that served HTML docs
const responses = ndjson(path.join(OUT, 'raw', 'responses.ndjson'));
const origins = new Set();
for (const r of responses) if (r.resourceType === 'document' || /text\/html/i.test(r.contentType || '')) { try { origins.add(new URL(r.url).origin); } catch {} }

// collect all discovered frontend URLs: page visits + click-graph nav targets
const urls = [];
for (const p of ndjson(path.join(OUT, 'raw', 'pages.ndjson'))) { if (p.finalUrl) urls.push(p.finalUrl); if (p.requestedUrl) urls.push(p.requestedUrl); }
const cg = fs.existsSync(path.join(OUT, 'data', 'click-graph.json')) ? JSON.parse(fs.readFileSync(path.join(OUT, 'data', 'click-graph.json'), 'utf8')) : null;
if (cg) for (const e of (cg.edges || cg.clickGraph || cg)) { if (e && e.to) urls.push(e.to); if (e && e.from) urls.push(e.from); }

// count concrete URLs per route signature
const routeCount = new Map();      // sig → count of distinct concrete urls
const concretePerSig = new Map();  // sig → Set(concrete url, id stripped of noise)
for (const raw of urls) {
  const s = sig(raw, origins);
  if (!s) continue;
  let key; try { const u = new URL(raw); key = u.pathname + [...u.searchParams].filter(([k]) => !NOISE.test(k)).sort().map(([k, v]) => k + '=' + v).join('&'); } catch { key = raw; }
  if (!concretePerSig.has(s)) concretePerSig.set(s, new Set());
  concretePerSig.get(s).add(key);
}
for (const [s, set] of concretePerSig) routeCount.set(s, set.size);

// build a tree from path segments; query-variants attach as children of their pathname
const root = { name: '/', children: new Map(), routes: [] };
function insert(s) {
  const [pathname, query] = s.split('?');
  const segs = pathname.split('/').filter(Boolean);
  let node = root;
  let acc = '';
  for (const seg of segs) {
    acc += '/' + seg;
    if (!node.children.has(seg)) node.children.set(seg, { name: seg, path: acc, children: new Map(), routes: [] });
    node = node.children.get(seg);
  }
  node.routes.push({ sig: s, query: query ? '?' + query : '(index)', count: routeCount.get(s) || 1 });
}
for (const s of [...concretePerSig.keys()].sort()) insert(s);

// render
const lines = [];
let totalRoutes = 0, totalConcrete = 0;
function render(node, prefix, isLast, isRoot) {
  if (!isRoot) {
    lines.push(`${prefix}${isLast ? '└─ ' : '├─ '}/${node.name}`);
  }
  const childPrefix = isRoot ? '' : prefix + (isLast ? '   ' : '│  ');
  // route variants on this node (query strings)
  const variants = node.routes.sort((a, b) => a.query.localeCompare(b.query));
  for (let i = 0; i < variants.length; i++) {
    const v = variants[i];
    const lastV = i === variants.length - 1 && node.children.size === 0;
    totalRoutes++; totalConcrete += v.count;
    const badge = v.count > 1 ? `   ×${v.count} concrete` : '';
    lines.push(`${childPrefix}${lastV ? '└· ' : '├· '}${v.query}${badge}`);
  }
  const kids = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (let i = 0; i < kids.length; i++) render(kids[i], childPrefix, i === kids.length - 1, false);
}
lines.push('/  (app root)');
render(root, '', true, true);

const header = `UI ROUTE TREE — ${origins.size ? [...origins][0] : ''}\n` +
  `${totalRoutes} distinct route templates · ${totalConcrete} concrete URLs discovered\n` +
  '─'.repeat(60);
const out = header + '\n' + lines.join('\n') + '\n';
fs.writeFileSync(path.join(OUT, 'reports', 'route-tree.txt'), out);
console.log(out);
console.log(`[route-tree] wrote ${path.relative(REPO_ROOT, path.join(OUT, 'reports', 'route-tree.txt'))}`);
