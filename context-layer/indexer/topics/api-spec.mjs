// Topic: api-spec — the per-endpoint TEST CONTRACT.
//
// One record per endpoint with everything an API-test generator needs:
//   method + path + origin, request headers, request body, and the
//   expected response body(ies) + status. This is the single source the
//   generation layer reads to build a request and assert a response.
//
// Distinct from the `apis` topic: `apis` is the lightweight discovery
// ROSTER (every endpoint seen); `api-spec` is the heavyweight contract,
// built only for endpoints we have enough sample/spec data to test.
//
// Sources merged (precedence noted):
//   * sources.crawlerOpenApi   — output/crawler/api-spec/openapi.json
//                                (spec.mjs, inferred from live captures:
//                                 header params + request/response examples)
//   * sources.mockData         — output/mock-data/bundle.json (real bodies +
//                                 sampled request/response headers)
//   * sources.crawler          — observedAuth + statusCounts
//
// When mock-data is absent (crawl saw no API bodies), the record is built
// purely from the crawler OpenAPI — so a contract still exists for every
// inferred endpoint.

import { indexedItem, observation } from '../lib/models.mjs';

export const topicName = 'api-spec';

// Header names whose VALUES must never be emitted (auth / session / secrets).
const SENSITIVE_HEADERS = new Set([
  'authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-auth-token',
  'api-key', 'x-csrf-token', 'x-xsrf-token', 'proxy-authorization',
]);
const SENSITIVE_VALUE_RE = /bearer\s|eyj[a-z0-9._-]{10,}|@[\w.-]+\.\w+|secret|token|password|sess/i;

function _redactHeaderValue(name, value) {
  if (SENSITIVE_HEADERS.has(String(name).toLowerCase())) return '<redacted>';
  if (typeof value === 'string' && SENSITIVE_VALUE_RE.test(value)) return '<redacted>';
  return value;
}
function _isSensitive(name) { return SENSITIVE_HEADERS.has(String(name).toLowerCase()); }

function _normalisePath(p) {
  if (!p || typeof p !== 'string') return null;
  let s = p.replace(/\/{2,}/g, '/');
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

const _isSuccess = (s) => Number(s) >= 200 && Number(s) < 400;


/** @param {import('../lib/sources.mjs').LoadedSources} sources */
export function build(sources) {
  /** key `METHOD:path` → { primary, obs:{} } */
  const byKey = new Map();

  const _ensure = (method, rawPath, origin) => {
    const path = _normalisePath(rawPath);
    if (!method || !path) return null;
    const id = `${method.toUpperCase()}:${path}`;
    if (!byKey.has(id)) {
      byKey.set(id, {
        primary: {
          id, method: method.toUpperCase(), path, origin: origin ?? null,
          auth: { scheme: null, required: null, headerName: null },
          requestHeaders: {},
          requestBody: { example: null, schema: null, contentType: null },
          responses: {},
          expectedStatus: null,
          sampleCount: { request: 0, response: 0 },
          provenance: { sources: [], primarySource: null },
        },
        obs: {},
      });
    }
    const rec = byKey.get(id);
    if (origin && !rec.primary.origin) rec.primary.origin = origin;
    return rec;
  };

  _foldCrawlerOpenApi(sources, _ensure);
  _foldMockData(sources, _ensure);
  _foldCrawlerAuth(sources, _ensure);

  // Finalize each record: expectedStatus, provenance, build observations.
  const items = [];
  for (const { primary, obs } of byKey.values()) {
    primary.expectedStatus = _pickExpectedStatus(primary.responses);
    const observations = [];
    if (obs.mockData) observations.push(observation({
      sourceId: 'mock-data', discoveryTier: 'live_observed',
      fields: { method: primary.method, path: primary.path, ...obs.mockData },
    }));
    if (obs.openapi) observations.push(observation({
      sourceId: 'crawler-openapi', discoveryTier: 'spec', confidenceOverride: 0.80,
      fields: { method: primary.method, path: primary.path, ...obs.openapi },
    }));
    if (obs.crawler) observations.push(observation({
      sourceId: 'crawler', discoveryTier: 'live_observed',
      fields: { method: primary.method, path: primary.path, ...obs.crawler },
    }));
    primary.provenance.sources = observations.map(o => o.sourceId);
    // real samples outrank inductive spec
    primary.provenance.primarySource = obs.mockData ? 'mock-data' : (obs.openapi ? 'crawler-openapi' : 'crawler');
    items.push(indexedItem(topicName, primary.id, primary, observations, _agrees));
  }
  items.sort((a, b) => a.id.localeCompare(b.id));
  return items;
}

function _agrees(a, b) {
  return a.fields?.method === b.fields?.method && a.fields?.path === b.fields?.path;
}


// ── source folders ───────────────────────────────────────────────────────

function _foldCrawlerOpenApi(sources, ensure) {
  const spec = sources.crawlerOpenApi;
  if (!spec?.paths) return;
  const servers = (spec.servers ?? []).map(s => s.url).filter(Boolean);
  const origin = servers[0] ?? null;
  for (const [rawPath, ops] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(ops)) {
      if (!['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(method)) continue;
      const rec = ensure(method, rawPath, origin);
      if (!rec) continue;
      const p = rec.primary;

      // request headers (header params)
      for (const param of op.parameters ?? []) {
        if (param.in !== 'header') continue;
        const name = String(param.name).toLowerCase();
        if (!(name in p.requestHeaders)) {
          p.requestHeaders[name] = {
            example: _redactHeaderValue(name, param.example),
            sensitive: _isSensitive(name),
          };
        }
      }
      // request body (schema always from spec; example only if not already set)
      const reqCt = op.requestBody?.content && Object.keys(op.requestBody.content)[0];
      if (reqCt) {
        const c = op.requestBody.content[reqCt];
        p.requestBody.contentType ??= reqCt;
        if (p.requestBody.schema == null && c.schema) p.requestBody.schema = c.schema;
        if (p.requestBody.example == null && c.example !== undefined) p.requestBody.example = c.example;
      }
      // responses (schema from spec; example only if not already set)
      for (const [status, r] of Object.entries(op.responses ?? {})) {
        const ct = r.content && Object.keys(r.content)[0];
        const slot = (p.responses[status] ??= { headers: {}, body: { example: null, schema: null }, contentType: null });
        if (ct) {
          slot.contentType ??= ct;
          if (slot.body.schema == null && r.content[ct].schema) slot.body.schema = r.content[ct].schema;
          if (slot.body.example == null && r.content[ct].example !== undefined) slot.body.example = r.content[ct].example;
        }
      }
      // auth from security
      const sec = op.security ?? [];
      if (sec.some(s => 'bearerAuth' in s)) { p.auth.scheme ??= 'bearer'; p.auth.headerName ??= 'authorization'; p.auth.required = true; }
      else if (sec.some(s => 'cookieAuth' in s)) { p.auth.scheme ??= 'cookie'; p.auth.required = true; }

      rec.obs.openapi = { hasRequestBody: !!reqCt, statuses: Object.keys(op.responses ?? {}) };
    }
  }
}

function _foldMockData(sources, ensure) {
  const eps = sources.mockData?.facts?.endpoints ?? [];
  for (const ep of eps) {
    const rec = ensure(ep.method, ep.path, ep.origin);
    if (!rec) continue;
    const p = rec.primary;

    // request headers — real observed values win over spec; sampleRequestHeaders
    // may be an object {name:value} or {name:[values]}.
    for (const [name, val] of Object.entries(ep.sampleRequestHeaders ?? {})) {
      const lname = String(name).toLowerCase();
      const v = Array.isArray(val) ? val[0] : val;
      p.requestHeaders[lname] = { example: _redactHeaderValue(lname, v), sensitive: _isSensitive(lname) };
    }
    // request body — real body wins
    const reqBody = ep.firstRequestBody ?? (ep.exampleRequestBodies ?? [])[0];
    if (reqBody !== undefined && reqBody !== null) {
      p.requestBody.example = reqBody;
      p.requestBody.contentType ??= 'application/json';
    }
    // responses — real body example wins; keep spec schema if present
    const byStatus = ep.exampleResponseBodiesByStatus ?? {};
    for (const [status, body] of Object.entries(byStatus)) {
      const slot = (p.responses[status] ??= { headers: {}, body: { example: null, schema: null }, contentType: null });
      slot.body.example = body;
      slot.contentType ??= 'application/json';
    }
    if (ep.firstSuccessResponseBody != null) {
      // ensure at least one success slot carries the real body
      const sStatus = Object.keys(byStatus).find(_isSuccess) || '200';
      const slot = (p.responses[sStatus] ??= { headers: {}, body: { example: null, schema: null }, contentType: null });
      if (slot.body.example == null) slot.body.example = ep.firstSuccessResponseBody;
    }
    // response headers
    for (const [name, val] of Object.entries(ep.sampleResponseHeaders ?? {})) {
      const lname = String(name).toLowerCase();
      const v = Array.isArray(val) ? val[0] : val;
      // attach to every known response slot (header set is per-endpoint in mock-data)
      for (const slot of Object.values(p.responses)) {
        slot.headers[lname] = { example: _redactHeaderValue(lname, v), sensitive: _isSensitive(lname) };
      }
    }
    p.sampleCount.request = ep.sampleCount?.request ?? (ep.samples?.length ?? p.sampleCount.request);
    p.sampleCount.response = ep.sampleCount?.response ?? (ep.samples?.length ?? p.sampleCount.response);
    rec.obs.mockData = {
      sampleCount: ep.sampleCount ?? null,
      sampleRequestHeaders: ep.sampleRequestHeaders ?? null,
      sampleResponseHeaders: ep.sampleResponseHeaders ?? null,
    };
  }
}

function _foldCrawlerAuth(sources, ensure) {
  const eps = sources.crawler?.facts?.endpoints ?? [];
  for (const ep of eps) {
    if (ep.isApi === false) continue;
    const rec = ensure(ep.method, ep.path, ep.origin);
    if (!rec) continue;
    const p = rec.primary;
    const a = ep.observedAuth ?? {};
    if (p.auth.scheme == null) {
      if (a.bearer) { p.auth.scheme = 'bearer'; p.auth.headerName = 'authorization'; p.auth.required = true; }
      else if (a.cookie) { p.auth.scheme = 'cookie'; p.auth.required = true; }
      else if (a.none) { p.auth.scheme = 'none'; p.auth.required = false; }
    }
    rec.obs.crawler = { observedAuth: ep.observedAuth ?? null, statusCounts: ep.statusCounts ?? null };
  }
}


function _pickExpectedStatus(responses) {
  const codes = Object.keys(responses).map(Number).filter(n => !Number.isNaN(n));
  if (!codes.length) return null;
  const success = codes.filter(_isSuccess).sort((a, b) => a - b);
  return success.length ? success[0] : codes.sort((a, b) => a - b)[0];
}
