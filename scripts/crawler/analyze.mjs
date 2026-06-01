// Read raw crawl streams and emit two structured JSON files:
//
//   output/crawler/routes.json
//     Aggregated, app-wide view: every endpoint and every page in one place,
//     with status codes, auth/JWT observations, redirect chains, security
//     headers summary, performance hotspots, failed requests, third-party
//     hosts contacted.
//
//   output/crawler/pages.json
//     Per-page deep info: title, meta, headings, forms (with fields + buttons),
//     clickables (buttons + links), images, iframes, scripts, storage (cookies +
//     localStorage + sessionStorage), console messages, websocket connections,
//     timing, screenshot path, triggered backend endpoints.
//
// Both are derived from `output/crawler/raw/*.ndjson` + body cache.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
// Mirrors crawl.mjs — read from the same OUT_DIR_NAME the crawler wrote to.
// Default 'crawler'; crawler-llm extractor sets CRAWLER_OUT_DIR_NAME=crawler-llm.
const OUT_DIR = path.join(REPO_ROOT, 'output', process.env.CRAWLER_OUT_DIR_NAME || 'crawler');
const RAW_DIR = path.join(OUT_DIR, 'raw');
const BODIES_DIR = path.join(OUT_DIR, 'bodies');
const DATA_DIR = path.join(OUT_DIR, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const STATIC_RE = /\/(_next\/static\/|static\/chunks\/|favicon\.|\.(?:js|css|map|woff2?|ttf|otf|png|jpe?g|gif|svg|webp|ico)(?:$|\?))/i;

function loadNd(file) {
  const p = path.join(RAW_DIR, file);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

const requests   = loadNd('requests.ndjson');
const responses  = loadNd('responses.ndjson');
const pagesRaw   = loadNd('pages.ndjson');
const consoleLog = loadNd('console.ndjson');
const failedLog  = loadNd('failed.ndjson');
const wsLog      = loadNd('websockets.ndjson');

// ---- helpers ----
function templatePath(p) {
  return p.split('/').map(seg => {
    if (!seg) return seg;
    if (/^\d+$/.test(seg)) return '{id}';
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return '{id}';
    if (/^[0-9a-f]{16,}$/i.test(seg)) return '{id}';
    return seg;
  }).join('/');
}

function isApi(r) {
  if (STATIC_RE.test(r.url)) return false;
  const ct = (r.contentType || '').toLowerCase();
  if (ct.includes('json')) return true;
  try {
    const u = new URL(r.url);
    if (/^\/(app\/v\d+|api)\//.test(u.pathname)) return true;
  } catch {}
  return false;
}

function readBody(hash) {
  if (!hash) return null;
  const p = path.join(BODIES_DIR, `${hash}.bin`);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p);
}
function tryJson(buf, ct) {
  if (!buf) return null;
  if (ct && !/json/i.test(ct)) return null;
  try { return JSON.parse(buf.toString('utf8')); } catch { return null; }
}

function decodeJwt(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return payload;
  } catch { return null; }
}

// Section classification: tries common patterns first (auth/dashboard/profile
// look the same on most apps), then falls back to "Title-Case first path
// segment". So /products/* → "Products", /orders/* → "Orders", etc., without
// any per-app config. Override via SECTION_RULES env (JSON: {"label":"regex"}).
const customRules = (() => {
  try { return JSON.parse(process.env.SECTION_RULES || '{}'); } catch { return {}; }
})();
// ── header sampling ───────────────────────────────────────────────────────
//
// Per endpoint we keep up to 3 distinct values per header name. Values
// from sensitive headers are redacted by NAME (so consumers can still
// see the shape — e.g. `Bearer ***`, `session=***` — without leaking
// real tokens into output/).

const _SENSITIVE_HEADERS = new Set([
  'authorization', 'cookie', 'set-cookie', 'x-api-key',
  'x-csrf-token', 'x-xsrf-token', 'proxy-authorization',
]);
const _MAX_SAMPLES_PER_HEADER = 3;
const _MAX_VAL_LEN            = 240;

function _redactHeaderValue(name, val) {
  const n = name.toLowerCase();
  if (!_SENSITIVE_HEADERS.has(n)) return String(val).slice(0, _MAX_VAL_LEN);
  if (typeof val !== 'string') return '<redacted>';
  // Preserve scheme prefix (Bearer / Basic / Digest / NTLM) for shape.
  const m = val.match(/^(Bearer|Basic|Digest|NTLM|Token)\s+/i);
  if (m) return `${m[1]} <redacted>`;
  // Cookies: keep names, drop values  (sid=abc; csrf=xyz → sid=<redacted>; csrf=<redacted>)
  if (n === 'cookie' || n === 'set-cookie') {
    return val.split(/;\s*/).map(pair => {
      const eq = pair.indexOf('=');
      if (eq < 0) return pair;
      return `${pair.slice(0, eq)}=<redacted>`;
    }).join('; ').slice(0, _MAX_VAL_LEN);
  }
  return '<redacted>';
}

function _addHeaderSample(bucket, name, val) {
  const key = String(name).toLowerCase();
  const safe = _redactHeaderValue(key, val);
  const arr = bucket[key] ?? (bucket[key] = []);
  if (arr.length < _MAX_SAMPLES_PER_HEADER && !arr.includes(safe)) arr.push(safe);
}


const GENERIC_RULES = {
  Auth:      /^\/(login|register|forgot-password|reset-password|logout|signout|signin|sign-in|sign-up|signup|oauth)/i,
  Profile:   /^\/(me|profile|account|settings|preferences)/i,
  Dashboard: /^\/(overview|dashboard|home)$/i,
  Admin:     /^\/(admin|console)/i,
};
function sectionOf(p) {
  for (const [label, re] of Object.entries(customRules)) {
    if (new RegExp(re).test(p)) return label;
  }
  for (const [label, re] of Object.entries(GENERIC_RULES)) {
    if (re.test(p)) return label;
  }
  // Fallback: title-case first path segment, e.g. /index-list/foo → "Index list"
  const seg = (p.split('/').filter(Boolean)[0] || '').replace(/[-_]+/g, ' ');
  if (!seg) return 'Other';
  return seg.charAt(0).toUpperCase() + seg.slice(1).toLowerCase();
}

// ---- build endpoint records ----
// key: "METHOD templatedPath origin"
const endpoints = new Map();
function epKey(method, origin, tplPath) { return `${method} ${origin}${tplPath}`; }

// Pair requests with responses by exact URL+method (best effort — Playwright
// doesn't expose CDP requestId in event records).
const reqByKey = new Map();
for (const r of requests) {
  const k = `${r.method} ${r.url}`;
  if (!reqByKey.has(k)) reqByKey.set(k, []);
  reqByKey.get(k).push(r);
}

// Track JWTs we observe (decoded payloads) per endpoint usage.
const jwtSet = new Map(); // payloadHash → { decoded, seen }
const jwtsByEndpoint = new Map(); // epKey → Set(payloadHash)

for (const resp of responses) {
  if (STATIC_RE.test(resp.url)) continue;
  let u;
  try { u = new URL(resp.url); } catch { continue; }
  const tpl = templatePath(u.pathname);
  const key = epKey(resp.method, u.origin, tpl);

  if (!endpoints.has(key)) {
    endpoints.set(key, {
      method: resp.method,
      origin: u.origin,
      path: tpl,
      isApi: false,
      samples: 0,
      statusCounts: {},
      pageUrls: new Set(),
      queryParamNames: new Set(),
      contentTypes: {},
      avgBytes: 0, _byteSum: 0, _byteN: 0,
      avgTimingMs: 0, _msSum: 0, _msN: 0,
      requestBodies: [],
      responseBodiesByStatus: {},
      observedAuth: { bearer: false, cookie: false, none: false },
      _redirected: [],
      // Headers — sampled, deduped, redacted. Up to 3 distinct values per
      // header name across all samples. Used downstream by mock-data
      // generation (auth schemes, content negotiation, cache hints, etc.).
      requestHeaderSamples:  {},   // { 'authorization': ['Bearer <redacted>', ...], ... }
      responseHeaderSamples: {},   // { 'set-cookie':    ['session=<redacted>', ...], ... }
      requestHeaderNames:    new Set(),
      responseHeaderNames:   new Set(),
    });
  }
  const e = endpoints.get(key);
  e.samples++;
  e.statusCounts[resp.status] = (e.statusCounts[resp.status] || 0) + 1;
  if (resp.pageUrl) e.pageUrls.add(resp.pageUrl);
  for (const k of u.searchParams.keys()) e.queryParamNames.add(k);
  const ct = (resp.contentType || 'unknown').split(';')[0].trim();
  e.contentTypes[ct] = (e.contentTypes[ct] || 0) + 1;
  if (resp.bodyLen > 0) { e._byteSum += resp.bodyLen; e._byteN++; }
  if (resp.timingMs > 0) { e._msSum += resp.timingMs; e._msN++; }
  if (isApi(resp)) e.isApi = true;

  // Auth signal from request headers (we copied them into responses for convenience)
  const reqHdr = resp.requestHeaders || {};
  const auth = reqHdr.authorization || reqHdr.Authorization;
  if (auth?.toLowerCase().startsWith('bearer ')) {
    e.observedAuth.bearer = true;
    const token = auth.slice(7).trim();
    const decoded = decodeJwt(token);
    if (decoded) {
      const h = JSON.stringify(decoded);
      if (!jwtSet.has(h)) jwtSet.set(h, { decoded, seen: 0 });
      jwtSet.get(h).seen++;
      if (!jwtsByEndpoint.has(key)) jwtsByEndpoint.set(key, new Set());
      jwtsByEndpoint.get(key).add(h);
    }
  } else if (reqHdr.cookie) {
    e.observedAuth.cookie = true;
  } else {
    e.observedAuth.none = true;
  }

  if (resp.requestHeaders?.['x-redirect-from'] || resp.headers?.location) {
    e._redirected.push({
      from: resp.pageUrl,
      to: resp.headers?.location || null,
      status: resp.status,
    });
  }

  // Sample request + response headers per endpoint. Up to 3 distinct
  // values per header name. Sensitive headers are redacted by name so
  // we keep the SHAPE for mock-data generation without leaking secrets.
  for (const [name, val] of Object.entries(resp.requestHeaders || {})) {
    e.requestHeaderNames.add(name.toLowerCase());
    _addHeaderSample(e.requestHeaderSamples, name, val);
  }
  for (const [name, val] of Object.entries(resp.headers || {})) {
    e.responseHeaderNames.add(name.toLowerCase());
    _addHeaderSample(e.responseHeaderSamples, name, val);
  }

  // attach a sample request body
  const matchReqs = reqByKey.get(`${resp.method} ${resp.url}`) || [];
  const reqRec = matchReqs.shift();
  if (reqRec?.postData) {
    try {
      const parsed = JSON.parse(reqRec.postData);
      if (e.requestBodies.length < 3) e.requestBodies.push(parsed);
    } catch {
      if (e.requestBodies.length < 3) e.requestBodies.push({ _raw: reqRec.postData.slice(0, 500) });
    }
  }

  // attach a sample response body per status
  if (!e.responseBodiesByStatus[resp.status]) {
    const buf = readBody(resp.bodyHash);
    const j = tryJson(buf, resp.contentType);
    if (j != null) e.responseBodiesByStatus[resp.status] = j;
    else if (buf && buf.length < 500) {
      e.responseBodiesByStatus[resp.status] = { _text: buf.toString('utf8').slice(0, 500) };
    }
  }
}

// ---- build page records ----
const pages = [];
for (const p of pagesRaw) {
  if (p.err) {
    pages.push({ requestedUrl: p.requestedUrl, error: p.err, phase: p.phase });
    continue;
  }
  const pageUrl = p.finalUrl;
  // gather things triggered by this page
  const triggered = new Set();
  for (const r of responses) {
    if (r.pageUrl === pageUrl && isApi(r)) {
      let u;
      try { u = new URL(r.url); } catch { continue; }
      triggered.add(`${r.method} ${u.origin}${templatePath(u.pathname)}`);
    }
  }
  const consoleMsgs = consoleLog.filter(c => c.pageUrl === pageUrl);
  const failed = failedLog.filter(f => f.pageUrl === pageUrl);
  const wsConns = wsLog.filter(w => w.pageUrl === pageUrl);

  const snap = p.snapshot || {};
  // Group forms by their resolved action endpoint for the "actions" summary
  const actions = [];
  for (const form of snap.forms || []) {
    const target = form.resolvedAction || form.action || pageUrl;
    actions.push({
      type: 'form-submit',
      method: form.method.toUpperCase(),
      target,
      fields: form.fields?.map(f => f.name).filter(Boolean) || [],
    });
  }
  // External-target anchors are "navigation" actions to other origins
  for (const link of snap.links || []) {
    try {
      const lu = new URL(link.href);
      if (lu.origin !== new URL(pageUrl).origin) {
        actions.push({ type: 'external-nav', target: link.href, text: link.text });
      }
    } catch {}
  }

  pages.push({
    requestedUrl: p.requestedUrl,
    finalUrl: pageUrl,
    section: sectionOf(new URL(pageUrl).pathname),
    title: snap.title || null,
    lang: snap.lang || null,
    navStatus: p.navStatus,
    timing: snap.timing || {},
    screenshot: p.screenshotPath || null,
    meta: snap.meta || [],
    headings: snap.headings || [],
    dom: {
      nodeCount: snap.domNodeCount || 0,
      scriptCount: (snap.scripts || []).length,
      imageCount: (snap.images || []).length,
      iframeCount: (snap.iframes || []).length,
    },
    forms: snap.forms || [],
    clickables: {
      buttons: snap.buttonsOutsideForms || [],
      links: (snap.links || []).map(l => ({ href: l.href, text: l.text, target: l.target })),
    },
    actions,
    images: snap.images || [],
    iframes: snap.iframes || [],
    scripts: snap.scripts || [],
    storage: {
      cookies: p.cookies || [],
      localStorage: snap.localStorage || {},
      sessionStorage: snap.sessionStorage || {},
    },
    consoleMessages: consoleMsgs.map(c => ({ type: c.type, text: c.text, location: c.location || null })),
    failedRequests: failed.map(f => ({ url: f.url, method: f.method, errorText: f.errorText })),
    websockets: wsConns,
    triggeredApis: [...triggered].sort(),
    phase: p.phase,
  });
}

// ---- security: cookies + headers ----
const allCookies = new Map();
for (const p of pages) {
  for (const c of (p.storage?.cookies || [])) {
    const k = `${c.domain}|${c.name}`;
    if (!allCookies.has(k)) allCookies.set(k, c);
  }
}
const insecureCookies = [...allCookies.values()].filter(c => !c.secure || !c.httpOnly);

const securityHeaderChecks = ['content-security-policy', 'strict-transport-security', 'x-frame-options', 'x-content-type-options', 'referrer-policy', 'permissions-policy'];
const headerCoverage = Object.fromEntries(securityHeaderChecks.map(h => [h, { present: 0, missing: 0 }]));
const origins = new Set();
const samplesByOrigin = {};
for (const r of responses) {
  if (STATIC_RE.test(r.url)) continue;
  let u; try { u = new URL(r.url); } catch { continue; }
  origins.add(u.origin);
  samplesByOrigin[u.origin] = (samplesByOrigin[u.origin] || 0) + 1;
  for (const h of securityHeaderChecks) {
    if (r.headers?.[h]) headerCoverage[h].present++;
    else headerCoverage[h].missing++;
  }
}

// ---- redirect chains ----
// Two flavors:
//   serverRedirects   — HTTP 3xx + Playwright's redirectedFrom() chain
//   clientNavRedirects — pages where requestedUrl !== finalUrl (SPA router push,
//                        auth-gate redirects, etc.)
const serverRedirects = [];
for (const r of requests) {
  if (r.redirectedFromUrl) serverRedirects.push({ from: r.redirectedFromUrl, to: r.url, pageUrl: r.pageUrl });
}
for (const r of responses) {
  if (r.status >= 300 && r.status < 400 && r.headers?.location) {
    serverRedirects.push({ from: r.url, to: r.headers.location, status: r.status, pageUrl: r.pageUrl });
  }
}
const clientNavRedirects = [];
const seenNavPair = new Set();
for (const p of pagesRaw) {
  if (!p.requestedUrl || !p.finalUrl) continue;
  if (p.requestedUrl === p.finalUrl) continue;
  let a, b;
  try { a = new URL(p.requestedUrl).pathname + (new URL(p.requestedUrl).search || ''); } catch { a = p.requestedUrl; }
  try { b = new URL(p.finalUrl).pathname + (new URL(p.finalUrl).search || ''); } catch { b = p.finalUrl; }
  if (a === b) continue;
  const key = `${a} → ${b}${p.clickSelector ? ' [click ' + p.clickSelector + ']' : ''}`;
  if (seenNavPair.has(key)) continue;
  seenNavPair.add(key);
  clientNavRedirects.push({
    from: a, to: b,
    phase: p.phase || 'crawl',
    clickSelector: p.clickSelector || null,
  });
}

// ---- third-party hosts ----
const FRONTEND_ORIGIN = pages[0]?.finalUrl ? new URL(pages[0].finalUrl).origin : null;
const thirdParty = new Map();
for (const r of responses) {
  try {
    const u = new URL(r.url);
    if (FRONTEND_ORIGIN && u.origin !== FRONTEND_ORIGIN) {
      thirdParty.set(u.origin, (thirdParty.get(u.origin) || 0) + 1);
    }
  } catch {}
}

// ---- finalize endpoint records ----
const endpointList = [...endpoints.values()].map(e => ({
  method: e.method,
  origin: e.origin,
  path: e.path,
  isApi: e.isApi,
  samples: e.samples,
  statusCounts: e.statusCounts,
  contentTypes: e.contentTypes,
  queryParamNames: [...e.queryParamNames],
  triggeredByPages: [...e.pageUrls],
  observedAuth: e.observedAuth,
  observedJwtClaims: [...(jwtsByEndpoint.get(epKey(e.method, e.origin, e.path)) || [])]
    .map(h => jwtSet.get(h).decoded),
  avgResponseBytes: e._byteN ? Math.round(e._byteSum / e._byteN) : 0,
  avgRequestMs: e._msN ? Math.round(e._msSum / e._msN) : 0,
  exampleRequestBodies: e.requestBodies,
  exampleResponseBodiesByStatus: e.responseBodiesByStatus,
  // Sampled, deduped, redacted headers — for mock-data / test-script generation
  requestHeaderNames:    [...e.requestHeaderNames].sort(),
  responseHeaderNames:   [...e.responseHeaderNames].sort(),
  sampleRequestHeaders:  e.requestHeaderSamples,
  sampleResponseHeaders: e.responseHeaderSamples,
})).sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));

// ---- performance hotspots ----
const slowestEndpoints = [...endpointList].sort((a, b) => b.avgRequestMs - a.avgRequestMs).slice(0, 10)
  .map(e => ({ endpoint: `${e.method} ${e.origin}${e.path}`, avgMs: e.avgRequestMs, samples: e.samples }));
const largestEndpoints = [...endpointList].sort((a, b) => b.avgResponseBytes - a.avgResponseBytes).slice(0, 10)
  .map(e => ({ endpoint: `${e.method} ${e.origin}${e.path}`, avgBytes: e.avgResponseBytes }));
const slowestPages = [...pages].filter(p => p.timing?.loadMs)
  .sort((a, b) => b.timing.loadMs - a.timing.loadMs).slice(0, 10)
  .map(p => ({ url: p.finalUrl, loadMs: p.timing.loadMs }));

// ---- write routes.json ----
const routesJson = {
  generatedAt: new Date().toISOString(),
  summary: {
    totalEndpoints: endpointList.length,
    apiEndpoints: endpointList.filter(e => e.isApi).length,
    nonApiEndpoints: endpointList.filter(e => !e.isApi).length,
    totalPages: pages.length,
    totalRequests: requests.length,
    totalResponses: responses.length,
    bodiesCached: fs.existsSync(BODIES_DIR) ? fs.readdirSync(BODIES_DIR).length : 0,
    consoleMessages: consoleLog.length,
    failedRequests: failedLog.length,
    origins: [...origins].sort(),
    samplesByOrigin,
  },
  endpoints: endpointList,
  pages: pages.filter(p => p.finalUrl).map(p => ({
    url: p.finalUrl,
    requestedUrl: p.requestedUrl,
    section: p.section,
    title: p.title,
    navStatus: p.navStatus,
    loadMs: p.timing?.loadMs || null,
    triggeredApis: p.triggeredApis,
    consoleErrorCount: (p.consoleMessages || []).filter(c => c.type === 'error' || c.type === 'pageerror').length,
    failedRequestCount: (p.failedRequests || []).length,
    phase: p.phase,
  })),
  serverRedirects,
  clientNavRedirects,
  failedRequests: failedLog,
  authObservations: {
    uniqueJwtPayloads: [...jwtSet.values()].map(j => j.decoded),
    endpointsRequiringBearer: endpointList.filter(e => e.observedAuth.bearer).map(e => `${e.method} ${e.origin}${e.path}`),
    endpointsRequiringCookie: endpointList.filter(e => e.observedAuth.cookie && !e.observedAuth.bearer).map(e => `${e.method} ${e.origin}${e.path}`),
    endpointsObservedUnauth: endpointList.filter(e => !e.observedAuth.bearer && !e.observedAuth.cookie).map(e => `${e.method} ${e.origin}${e.path}`),
  },
  security: {
    cookies: [...allCookies.values()],
    insecureCookies: insecureCookies.map(c => ({
      name: c.name, domain: c.domain, secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite,
    })),
    headerCoverage,
  },
  performance: {
    slowestEndpoints,
    largestEndpoints,
    slowestPages,
  },
  thirdPartyHosts: [...thirdParty.entries()].map(([host, count]) => ({ host, count })),
};

fs.writeFileSync(path.join(DATA_DIR, 'routes.json'), JSON.stringify(routesJson, null, 2));

// ---- write pages.json ----
const pagesJson = {
  generatedAt: new Date().toISOString(),
  count: pages.length,
  pages,
};
fs.writeFileSync(path.join(DATA_DIR, 'pages.json'), JSON.stringify(pagesJson, null, 2));

console.log(`[analyze] endpoints=${endpointList.length}  apis=${endpointList.filter(e => e.isApi).length}  pages=${pages.length}  jwtPayloads=${jwtSet.size}`);
console.log(`[analyze] wrote output/crawler/data/routes.json (${(fs.statSync(path.join(DATA_DIR, 'routes.json')).size / 1024).toFixed(1)} KB)`);
console.log(`[analyze] wrote output/crawler/data/pages.json  (${(fs.statSync(path.join(DATA_DIR, 'pages.json')).size / 1024).toFixed(1)} KB)`);
