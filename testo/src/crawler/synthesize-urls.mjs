// synthesize-urls.mjs
//
// Data-driven detail-URL discovery. Inspired by browser-to-api's premise:
// an app's structure lives in its network traffic, not only its DOM. The
// click-walker can only reach rows that actually render (it misses
// virtualized rows, page-2+ rows, and rows behind finicky click targets).
// But the LIST/SEARCH API responses the frontend already fetched contain
// EVERY row's id — and the detail route is a simple template keyed by that
// id. So instead of depending on clicking every row, we:
//
//   1. learn the frontend "detail" route TEMPLATE(s) from observed
//      navigations that carry an id (e.g. `/endpoints/detail?endpointId=<uuid>`
//      or a `/users/<uuid>` path segment),
//   2. mine ID POOLS from captured collection responses
//      (`{results:[…]}` / `{data:[…]}` / `{items:[…]}` / top-level arrays),
//   3. pair pools↔templates (by the leading path segment of the API
//      response's pageUrl, with an id-field/param-name affinity fallback),
//   4. SYNTHESIZE one detail URL per (template, id).
//
// Reads (same conventions as spec.mjs):
//   output/crawler/raw/{requests,responses}.ndjson
//   output/crawler/bodies/<bodyHash>.bin
// Writes:
//   output/crawler/synthesized-urls.json   full report (templates, pools, urls)
//   output/crawler/synthesized-urls.txt    one path per line — ready to feed
//                                           back as POST_CRAWL_URLS for a
//                                           second crawl pass that visits the
//                                           detail pages clicking never reached.
//
// This AUGMENTS the click-based drill-down; it does not replace it. The
// walker's clicks are what reveal the detail template in the first place;
// this pass fans that template out over the complete id set.
//
// Env:
//   CRAWLER_OUT_DIR_NAME       which output/<dir> to read (default 'crawler')
//   SYNTH_MAX_PER_TEMPLATE     cap synthesized URLs per template (default 50)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const OUT_DIR = path.join(REPO_ROOT, 'output', process.env.CRAWLER_OUT_DIR_NAME || 'crawler');
const RAW_DIR = path.join(OUT_DIR, 'raw');
const BODIES_DIR = path.join(OUT_DIR, 'bodies');
const MAX_PER_TEMPLATE = Number(process.env.SYNTH_MAX_PER_TEMPLATE || 50);

// ───────── shared helpers (mirror spec.mjs) ─────────────────────────────
function* ndjson(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    if (!line) continue;
    try { yield JSON.parse(line); } catch {}
  }
}
function readBody(bodyHash) {
  if (!bodyHash) return null;
  const p = path.join(BODIES_DIR, `${bodyHash}.bin`);
  if (!fs.existsSync(p)) return null;
  try { return fs.readFileSync(p); } catch { return null; }
}
function parseJsonMaybe(buf, contentType) {
  if (!buf) return null;
  if (contentType && !/json/i.test(contentType)) return null;
  try { return JSON.parse(buf.toString('utf8')); } catch { return null; }
}

// ───────── id-shape classifier ──────────────────────────────────────────
// A value is "id-shaped" if it's a UUID, a pure integer, or a long hex
// string. Slugs/emails/free text are NOT — we don't want to splice those
// into a URL slot that the app expects to be an opaque id.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_RE  = /^[0-9a-f]{16,}$/i;
const INT_RE  = /^\d{1,18}$/;
function idShape(v) {
  if (typeof v === 'number' && Number.isInteger(v)) return 'int';
  if (typeof v !== 'string') return null;
  if (UUID_RE.test(v)) return 'uuid';
  if (INT_RE.test(v))  return 'int';
  if (HEX_RE.test(v))  return 'hex';
  return null;
}
const firstSeg = (pathname) => (pathname.split('/').filter(Boolean)[0] || '').toLowerCase();
// Params that carry id-shaped values but are NOT resource ids: framework
// navigation internals (Next.js `_rsc`), analytics, and the OAuth/OIDC
// handshake params (state/nonce/code/… are UUID-shaped but identify a login
// flow, not a page). Splicing these would synthesize garbage auth URLs.
const NOISE_PARAMS = /^(_rsc|_next|__|utm_|fbclid|gclid|state|nonce|session_state|code|code_challenge|code_verifier|iss|client_id|redirect_uri|response_type|response_mode|grant_type|scope|id_token|access_token|refresh_token)$/i;
// Auth / OIDC endpoints never host browsable detail pages — skip wholesale.
const AUTH_PATH_RE = /(\/realms\/|\/protocol\/openid-connect\/|\/oauth2?\/|\/login\b|\/signin\b|\/sso\b|\/auth\b)/i;

// ───────── load capture ─────────────────────────────────────────────────
const requests = [...ndjson(path.join(RAW_DIR, 'requests.ndjson'))];
const responses = [...ndjson(path.join(RAW_DIR, 'responses.ndjson'))];
const pages = [...ndjson(path.join(RAW_DIR, 'pages.ndjson'))];

// Normalized key for a URL: pathname + the non-noise query params (sorted),
// so `/x/detail?id=A&_rsc=q` and `/x/detail?id=A` compare equal. Used to
// tell whether a synthesized URL was ACTUALLY crawled as a page. A prefetch
// (network request) is NOT a crawl — those pages were never explored — so we
// compare against pages.ndjson finalUrl/requestedUrl, not the raw request log.
function normKey(urlStr) {
  let u; try { u = new URL(urlStr); } catch { return urlStr; }
  const ps = [...u.searchParams].filter(([k]) => !NOISE_PARAMS.test(k)).sort();
  return u.origin + u.pathname + (ps.length ? '?' + ps.map(([k, v]) => `${k}=${v}`).join('&') : '');
}
const crawledKeys = new Set();
for (const p of pages) {
  // A visit that BOUNCED to the login page never actually saw the requested
  // route — counting its requestedUrl as crawled would permanently exclude
  // that URL from every future deep-crawl feed.
  if (/\/(login|signin|sign-in|sso)\b/i.test(p.finalUrl || '')) continue;
  for (const k of [p.finalUrl, p.requestedUrl]) if (k) crawledKeys.add(normKey(k));
}

// Frontend origins = origins that served an HTML document. Detail-route
// templates only come from these; API id-pools come from JSON responses
// (typically a different origin).
const frontendOrigins = new Set();
for (const r of responses) {
  const isDoc = r.resourceType === 'document' || /text\/html/i.test(r.contentType || '');
  if (isDoc) { try { frontendOrigins.add(new URL(r.url).origin); } catch {} }
}

// ───────── 1. learn detail-route templates from frontend navigations ────
// Scan every same-origin frontend URL (from BOTH requests and responses —
// Next.js prefetch shows up as `_rsc` requests, real clicks show up as
// document navigations). A URL contributes a template if it carries an
// id-shaped value in a query param OR a path segment.
//
// template key shapes:
//   { kind:'query', origin, pathname, param, shape }
//   { kind:'path',  origin, pathTemplate (with {id}), segIndex, shape }
const templates = new Map();   // key string → template record (+ examples)
function addQueryTemplate(origin, pathname, param, shape, exampleId, exampleUrl) {
  const key = `q:${origin}${pathname}?${param}`;
  let t = templates.get(key);
  if (!t) { t = { kind: 'query', origin, pathname, param, shape, seg: firstSeg(pathname), examples: new Set(), exampleUrl }; templates.set(key, t); }
  t.examples.add(exampleId);
}
function addPathTemplate(origin, segs, segIndex, shape, exampleId, exampleUrl) {
  const tplSegs = segs.slice();
  tplSegs[segIndex] = '{id}';
  const pathTemplate = '/' + tplSegs.join('/');
  const key = `p:${origin}${pathTemplate}#${segIndex}`;
  let t = templates.get(key);
  if (!t) { t = { kind: 'path', origin, pathTemplate, segIndex, shape, seg: (tplSegs.filter(Boolean)[0] || '').toLowerCase(), examples: new Set(), exampleUrl }; templates.set(key, t); }
  t.examples.add(exampleId);
}

for (const rec of [...requests, ...responses]) {
  let u;
  try { u = new URL(rec.url); } catch { continue; }
  if (!frontendOrigins.has(u.origin)) continue;
  if (AUTH_PATH_RE.test(u.pathname)) continue;   // login/OIDC flow, not a detail page
  // query-param ids
  for (const [param, val] of u.searchParams) {
    if (NOISE_PARAMS.test(param)) continue;
    const shape = idShape(val);
    if (shape) addQueryTemplate(u.origin, u.pathname, param, shape, val, rec.url);
  }
  // path-segment ids
  const segs = u.pathname.split('/').filter(Boolean);
  for (let i = 0; i < segs.length; i++) {
    const shape = idShape(segs[i]);
    if (shape) addPathTemplate(u.origin, segs, i, shape, segs[i], rec.url);
  }
}

// ───────── 2. mine id pools from collection responses ───────────────────
// A response body is a "collection" if it's a top-level array, or an object
// with a results/data/items/rows/hits/records array. For each element we
// collect its id-shaped fields (preferring keys named id / *_id / *Id).
const COLLECTION_KEYS = ['results', 'data', 'items', 'rows', 'hits', 'records', 'list', 'entries'];
function collectionOf(body) {
  if (Array.isArray(body)) return body;
  if (body && typeof body === 'object') {
    for (const k of COLLECTION_KEYS) if (Array.isArray(body[k])) return body[k];
  }
  return null;
}
function idFieldsOf(el) {
  // returns [{ field, value, shape }] for id-shaped fields on the element
  if (!el || typeof el !== 'object') {
    const shape = idShape(el);
    return shape ? [{ field: '$value', value: el, shape }] : [];
  }
  const out = [];
  for (const [k, v] of Object.entries(el)) {
    if (!/^(id|uuid|_id)$|_id$|Id$/.test(k) && k.toLowerCase() !== 'id') continue;
    const shape = idShape(v);
    if (shape) out.push({ field: k, value: String(v), shape });
  }
  return out;
}

const pools = [];   // { apiUrl, pagePath, pageSeg, count, idFields:Map(field→Set(values)) }
for (const resp of responses) {
  if (resp.status < 200 || resp.status >= 300) continue;
  const body = parseJsonMaybe(readBody(resp.bodyHash), resp.contentType);
  if (!body) continue;
  const coll = collectionOf(body);
  if (!coll || coll.length === 0) continue;
  let pagePath = '/'; let pageSeg = '';
  try { const pu = new URL(resp.pageUrl); pagePath = pu.pathname; pageSeg = firstSeg(pu.pathname); } catch {}
  const idFields = new Map();   // field → Set(values)
  for (const el of coll) {
    for (const { field, value } of idFieldsOf(el)) {
      if (!idFields.has(field)) idFields.set(field, new Set());
      idFields.get(field).add(String(value));
    }
  }
  if (idFields.size === 0) continue;
  pools.push({ apiUrl: resp.url, pagePath, pageSeg, count: coll.length, idFields });
}

// ───────── 3. pair pools↔templates, 4. synthesize ───────────────────────
// Affinity: param `endpointId` → base token `endpoint`; prefer pool fields
// `endpoint_id` / `endpointId` / generic `id`. Pools are matched to a
// template when their pageUrl's first path segment equals the template's
// first segment (e.g. /endpoints/search fetched on /endpoints → template
// /endpoints/detail). If no segment match exists for a template, fall back
// to ANY pool whose id field shape matches the template's id shape.
function baseToken(name) { return name.replace(/[_-]?id$/i, '').replace(/[_-]+/g, '').toLowerCase(); }
function rankFields(template, pool) {
  // ordered list of [field, values[]] best-first for this template
  const want = template.kind === 'query' ? baseToken(template.param) : template.seg;
  const scored = [];
  for (const [field, set] of pool.idFields) {
    const vals = [...set].filter(v => idShape(v) === template.shape);
    if (!vals.length) continue;
    const tok = baseToken(field);
    let score = 0;
    if (tok === want) score = 3;                 // endpoint == endpoint
    else if (field.toLowerCase() === 'id') score = 2;   // generic id
    else if (tok && want && (tok.includes(want) || want.includes(tok))) score = 1;
    scored.push({ field, vals, score });
  }
  return scored.sort((a, b) => b.score - a.score);
}

const synthesized = [];           // { url, path, template, id, idField, apiUrl }
const seen = new Set();
const perTemplateDropped = {};

for (const t of templates.values()) {
  // candidate pools: segment match first; else shape-compatible pools
  let cand = pools.filter(p => p.pageSeg && p.pageSeg === t.seg);
  if (!cand.length) cand = pools.filter(p => [...p.idFields.values()].some(s => [...s].some(v => idShape(v) === t.shape)));
  // gather ids best-first
  const ids = [];
  const idSrc = new Map();   // id → {field, apiUrl}
  for (const p of cand) {
    for (const { field, vals } of rankFields(t, p)) {
      for (const v of vals) {
        if (!idSrc.has(v)) { idSrc.set(v, { field, apiUrl: p.apiUrl }); ids.push(v); }
      }
    }
  }
  let made = 0;
  for (const id of ids) {
    if (made >= MAX_PER_TEMPLATE) { perTemplateDropped[templKey(t)] = (perTemplateDropped[templKey(t)] || 0) + 1; continue; }
    const url = buildUrl(t, id);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const src = idSrc.get(id);
    synthesized.push({
      url, path: new URL(url).pathname + new URL(url).search,
      template: templKey(t), id, idField: src?.field, apiUrl: src?.apiUrl,
      // already CRAWLED as a page (not merely prefetched/observed in network)
      alreadyCrawled: crawledKeys.has(normKey(url)),
    });
    made++;
  }
}

function templKey(t) {
  return t.kind === 'query' ? `${t.pathname}?${t.param}={id}` : t.pathTemplate;
}
function buildUrl(t, id) {
  if (t.kind === 'query') {
    const u = new URL(t.origin + t.pathname);
    u.searchParams.set(t.param, id);     // only the id param — framework noise dropped
    return u.href;
  }
  // path template: replace the {id} segment
  const segs = t.pathTemplate.split('/').filter(Boolean);
  // segIndex counts non-empty segments from addPathTemplate (segs.filter(Boolean))
  const idxs = segs.map((s, i) => s === '{id}' ? i : -1).filter(i => i >= 0);
  if (!idxs.length) return null;
  segs[idxs[0]] = id;
  return new URL(t.origin + '/' + segs.join('/')).href;
}

// ───────── emit ─────────────────────────────────────────────────────────
fs.mkdirSync(OUT_DIR, { recursive: true });
const report = {
  generatedAt: new Date().toISOString(),
  outDir: path.relative(REPO_ROOT, OUT_DIR),
  frontendOrigins: [...frontendOrigins],
  stats: {
    templates: templates.size,
    pools: pools.length,
    totalUniqueIds: new Set(synthesized.map(s => s.id)).size,
    synthesizedUrls: synthesized.length,
    cappedPerTemplate: MAX_PER_TEMPLATE,
    droppedToCapByTemplate: perTemplateDropped,
  },
  templates: [...templates.values()].map(t => ({
    key: templKey(t), kind: t.kind, origin: t.origin, idShape: t.shape, seg: t.seg,
    observedExamples: [...t.examples].slice(0, 5), observedCount: t.examples.size,
    exampleUrl: t.exampleUrl,
  })),
  pools: pools.map(p => ({
    apiUrl: p.apiUrl, pagePath: p.pagePath, elements: p.count,
    idFields: Object.fromEntries([...p.idFields].map(([f, s]) => [f, { count: s.size, sample: [...s].slice(0, 3) }])),
  })),
  synthesized,
};
fs.writeFileSync(path.join(OUT_DIR, 'synthesized-urls.json'), JSON.stringify(report, null, 2));
// only NOT-YET-CRAWLED paths in the .txt feed — these are the detail pages
// the walker never actually explored (clicking missed them, or they were
// only prefetched). This is the deep-crawl work list.
const feedPaths = [...new Set(synthesized.filter(s => !s.alreadyCrawled).map(s => s.path))];
fs.writeFileSync(path.join(OUT_DIR, 'synthesized-urls.txt'), feedPaths.join('\n') + (feedPaths.length ? '\n' : ''));

console.log(`[synth] templates=${templates.size} pools=${pools.length} → synthesized ${synthesized.length} url(s) (${feedPaths.length} new)`);
for (const t of report.templates) {
  const n = synthesized.filter(s => s.template === t.key).length;
  if (n) console.log(`[synth]   ${t.key}  ← ${n} url(s)  (id ${t.idShape}, observed ${t.observedCount})`);
}
const totalDropped = Object.values(perTemplateDropped).reduce((a, b) => a + b, 0);
if (totalDropped) console.log(`[synth]   note: ${totalDropped} url(s) dropped to per-template cap (${MAX_PER_TEMPLATE}); raise SYNTH_MAX_PER_TEMPLATE to include them`);
console.log(`[synth] wrote ${path.relative(REPO_ROOT, OUT_DIR)}/synthesized-urls.{json,txt}`);
if (feedPaths.length) {
  console.log(`[synth] feed a second pass:  POST_CRAWL_URLS="$(paste -sd, '${path.relative(REPO_ROOT, path.join(OUT_DIR, 'synthesized-urls.txt'))}')" npm run crawl`);
}
