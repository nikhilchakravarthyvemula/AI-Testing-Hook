// Mock-data extractor — distil real request/response samples from the
// crawler bundle into a clean, purpose-built artifact.
//
// Why a separate source instead of "consumers read the crawler bundle":
//   * The crawler bundle is a kitchen sink. Consumers shouldn't have to
//     know its internal shape to use the samples.
//   * Sensitive header redaction is already done by the crawler — we
//     just re-emit, no extra surface to keep in sync.
//   * Future enrichers (LLM that infers a sensible request body from an
//     observed response shape, masking PII in samples, etc.) plug in
//     here without touching the crawler.
//
// NOTE: an EMPTY bundle just means the crawl observed no API traffic with
// bodies (data-dependent, not a bug). The `api-spec` indexer topic falls
// back to the crawler-inferred OpenAPI in that case, so a per-endpoint
// test contract still exists.
//
// Output shape (kept flat + per-endpoint so it's trivially consumable):
//
//   output/mock-data/bundle.json
//   {
//     sourceId: "mock-data",
//     extractedAt, target, stats,
//     facts: {
//       endpoints: [
//         {
//           method:  "POST",
//           path:    "/app/v1/login",
//           origin:  "http://localhost:8000",
//           contentTypes: { "application/json": 2 },
//           statusCounts: { "200": 2 },
//           samples: [
//             {
//               status: 200,
//               request:  { body, contentType, headers, queryParams },
//               response: { body, contentType, headers },
//             }
//           ],
//           sampleCount: { request: 2, response: 2 }
//         }
//       ]
//     }
//   }
//
// Consumers:
//   * indexer's mock-data topic    — surfaces per-endpoint records
//   * api-test-generator           — uses samples for body synthesis,
//                                    response fixtures, header replay

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { provenance, DiscoveryTier } from '../../../knowledge-base/schema.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const CRAWLER_BUNDLE = path.join(REPO_ROOT, 'output', 'crawler', 'bundle.json');
const RAW_RESPONSES  = path.join(REPO_ROOT, 'output', 'crawler', 'raw', 'responses.ndjson');
const OUT_DIR        = path.join(REPO_ROOT, 'output', 'mock-data');
const OUT_FILE       = path.join(OUT_DIR, 'bundle.json');
const DIGEST_FILE    = path.join(OUT_DIR, 'api-responses.md');


function main() {
  if (!fs.existsSync(CRAWLER_BUNDLE)) {
    console.warn(`[mock-data] crawler bundle missing at ${path.relative(REPO_ROOT, CRAWLER_BUNDLE)} — nothing to do`);
    _writeEmpty();
    return;
  }
  const crawler = JSON.parse(fs.readFileSync(CRAWLER_BUNDLE, 'utf8'));
  const endpoints = crawler?.facts?.endpoints ?? [];

  // Build an index of observed concrete path-param values by matching
  // raw concrete URLs against each endpoint's declared pattern. This is
  // the bit that turns "/users/{user_id}/approvals samples=30" back into
  // "we saw user_id=1, user_id=5, …" — used downstream by the test
  // generator instead of always substituting "1".
  const observedParams = _buildObservedPathParamsIndex(endpoints, RAW_RESPONSES);

  /** @type {Array<Object>} */
  const out = [];
  let totalReq = 0;
  let totalResp = 0;
  let totalSamples = 0;
  let totalWithParams = 0;

  for (const ep of endpoints) {
    if (!ep || !ep.isApi) continue;     // skip text/html navigations
    const method = (ep.method ?? 'GET').toUpperCase();
    const epPath = ep.path;
    if (!epPath) continue;

    const reqBodies   = Array.isArray(ep.exampleRequestBodies) ? ep.exampleRequestBodies : [];
    const respByCode  = ep.exampleResponseBodiesByStatus ?? {};
    if (reqBodies.length === 0 && Object.keys(respByCode).length === 0) continue;

    const samples = _buildSamples({ ep, reqBodies, respByCode });
    totalReq  += reqBodies.length;
    totalResp += Object.values(respByCode).reduce((n, arr) => n + (arr?.length ?? 0), 0);
    totalSamples += samples.length;

    const pathParams = observedParams.get(`${method}:${epPath}`) ?? {};
    if (Object.keys(pathParams).length > 0) totalWithParams++;

    out.push({
      method,
      path: epPath,
      origin: ep.origin ?? null,
      contentTypes: ep.contentTypes ?? {},
      statusCounts: ep.statusCounts ?? {},
      requestHeaderNames:  ep.requestHeaderNames  ?? [],
      responseHeaderNames: ep.responseHeaderNames ?? [],
      sampleRequestHeaders:  ep.sampleRequestHeaders  ?? {},
      sampleResponseHeaders: ep.sampleResponseHeaders ?? {},
      sampleCount: {
        request:  reqBodies.length,
        response: Object.values(respByCode).reduce((n, arr) => n + (arr?.length ?? 0), 0),
      },
      // Concrete path-param values the crawler saw the frontend send for
      // this endpoint. E.g. {user_id: ["1", "5"], pattern_hash: ["abc…"]}.
      // Empty when the endpoint has no path params or the crawler never
      // hit a concrete instance.
      observedPathParams: pathParams,
      samples,
    });
  }

  // Stable order — easier to diff between runs.
  out.sort((a, b) => `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`));

  const bundle = {
    sourceId: 'mock-data',
    discoveryTier: DiscoveryTier.LIVE_OBSERVED,
    confidence: 0.95,
    extractedAt: new Date().toISOString(),
    extractedBy: 'context-layer/content-extractor/mock-data-extractor/extract.mjs',
    target: crawler?.target ?? null,
    stats: {
      endpointsWithSamples: out.length,
      requestSamples:  totalReq,
      responseSamples: totalResp,
      totalSamples,
    },
    provenance: provenance({
      sourceId: 'mock-data',
      tier: DiscoveryTier.LIVE_OBSERVED,
      extractedBy: 'mock-data-extractor (from crawler bundle)',
    }),
    facts: { endpoints: out },
  };

  bundle.stats.endpointsWithPathParams = totalWithParams;

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(bundle, null, 2));
  const sizeKB = (fs.statSync(OUT_FILE).size / 1024).toFixed(1);
  console.log(
    `[mock-data] ${out.length} endpoint(s) with samples · ` +
    `${totalReq} request body sample(s) · ${totalResp} response body sample(s) · ` +
    `${totalWithParams} with observed path-params`
  );
  console.log(`[mock-data] wrote ${path.relative(REPO_ROOT, OUT_FILE)} (${sizeKB} KB)`);

  // Human-readable digest: one row per API → status: response-preview.
  // Designed to skim — anything more structured lives in bundle.json.
  fs.writeFileSync(DIGEST_FILE, _renderDigest(bundle));
  console.log(`[mock-data] wrote ${path.relative(REPO_ROOT, DIGEST_FILE)} (human digest)`);
}


function _renderDigest(bundle) {
  const lines = [];
  lines.push('# API Responses (crawler-observed)');
  lines.push('');
  lines.push(`_generated ${bundle.extractedAt}_`);
  lines.push('');
  lines.push(`**${bundle.stats.endpointsWithSamples}** endpoint(s) · `
    + `**${bundle.stats.requestSamples}** request body sample(s) · `
    + `**${bundle.stats.responseSamples}** response body sample(s)`);
  lines.push('');

  for (const ep of bundle.facts.endpoints) {
    const origin = ep.origin ?? '';
    lines.push(`## ${ep.method} ${origin}${ep.path}`);
    if (Object.keys(ep.observedPathParams ?? {}).length) {
      lines.push('');
      lines.push('observed path-params: `' + JSON.stringify(ep.observedPathParams) + '`');
    }
    // Group samples by status; show one preview per status.
    const seen = new Set();
    for (const s of ep.samples) {
      const code = s.status ?? '?';
      if (seen.has(code)) continue;
      seen.add(code);
      lines.push('');
      lines.push(`**${code}**`);
      if (s.request?.body !== undefined && s.request?.body !== null) {
        lines.push('request:');
        lines.push('```json');
        lines.push(_previewJson(s.request.body, 600));
        lines.push('```');
      }
      if (s.response?.body !== undefined && s.response?.body !== null) {
        lines.push('response:');
        lines.push('```json');
        lines.push(_previewJson(s.response.body, 600));
        lines.push('```');
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}


function _previewJson(v, maxLen) {
  let s;
  try { s = typeof v === 'string' ? v : JSON.stringify(v, null, 2); }
  catch { s = String(v); }
  if (s.length > maxLen) return s.slice(0, maxLen) + '\n…[truncated]';
  return s;
}


// ── path-param extraction ──────────────────────────────────────────────────


/**
 * Build a map `<METHOD>:<pattern>` → `{paramName: [concrete values…]}` by
 * scanning raw response NDJSON and reverse-matching each concrete URL
 * against every known endpoint pattern.
 *
 * The crawler captures concrete URLs (`/users/1/approvals`) and the analyze
 * step normalises them to patterns (`/users/{id}/approvals`) for dedup.
 * Without this re-extraction, the concrete values would be lost — and the
 * api-test-generator would have to substitute a literal "1" everywhere.
 */
function _buildObservedPathParamsIndex(endpoints, rawPath) {
  const index = new Map();   // key → {paramName: Set(values)}
  if (!fs.existsSync(rawPath)) return new Map();

  // Pre-compile a regex per endpoint pattern that captures each path param.
  // Patterns support both `{name}` and `:name` styles.
  /** @type {Array<{key: string, method: string, origin: string|null, paramNames: string[], re: RegExp}>} */
  const compiled = [];
  for (const ep of endpoints) {
    if (!ep || !ep.isApi || !ep.path) continue;
    const method = (ep.method ?? 'GET').toUpperCase();
    if (!/[{:]/.test(ep.path)) continue;   // no params to extract
    const paramNames = [];
    const reSource = ep.path
      .replace(/\{([^}]+)\}/g, (_, n) => { paramNames.push(n); return '([^/?#]+)'; })
      .replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, n) => { paramNames.push(n); return '([^/?#]+)'; });
    compiled.push({
      key: `${method}:${ep.path}`,
      method,
      origin: ep.origin ?? null,
      paramNames,
      re: new RegExp(`^${reSource}$`),
    });
  }
  if (compiled.length === 0) return new Map();

  // Walk every line of the raw NDJSON. Cheap — we only do string parsing + regex.
  const text = fs.readFileSync(rawPath, 'utf8');
  for (const line of text.split('\n')) {
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const method = (rec.method ?? 'GET').toUpperCase();
    const url = rec.url;
    if (!url) continue;
    let urlObj;
    try { urlObj = new URL(url); } catch { continue; }
    const pathOnly = urlObj.pathname;

    // Try matching against every endpoint of the same method.
    for (const c of compiled) {
      if (c.method !== method) continue;
      // Origin must match if the endpoint declared one (so /app/v1/users/1
      // doesn't match a different host's same-shape route).
      if (c.origin && c.origin !== urlObj.origin) continue;
      const m = c.re.exec(pathOnly);
      if (!m) continue;
      let entry = index.get(c.key);
      if (!entry) {
        entry = {};
        for (const n of c.paramNames) entry[n] = new Set();
        index.set(c.key, entry);
      }
      c.paramNames.forEach((n, i) => entry[n].add(m[i + 1]));
      break;   // first match wins; patterns are mutually exclusive in practice
    }
  }

  // Collapse Sets → arrays (cap each at 5 values to keep the bundle small).
  const out = new Map();
  for (const [key, entry] of index) {
    const obj = {};
    for (const [name, set] of Object.entries(entry)) {
      obj[name] = [...set].slice(0, 5);
    }
    out.set(key, obj);
  }
  return out;
}


// ── helpers ────────────────────────────────────────────────────────────────


function _buildSamples({ ep, reqBodies, respByCode }) {
  // Pair request bodies with the most-common observed status's response
  // body when we can. Always also emit response-only entries for every
  // status code observed.
  const samples = [];

  // Primary status = most-common one (response samples are the strongest signal).
  const primaryStatus = Object.entries(ep.statusCounts ?? {})
    .sort(([, a], [, b]) => b - a)[0]?.[0] ?? null;
  const primaryRespBody = primaryStatus && (respByCode[primaryStatus] ?? [])[0] || null;

  // Request-driven samples — one per captured request body, paired with primary response.
  for (let i = 0; i < reqBodies.length; i++) {
    samples.push({
      status: primaryStatus ? Number(primaryStatus) : null,
      request: {
        body: reqBodies[i],
        contentType: _firstValue(ep.sampleRequestHeaders?.['content-type']) ?? 'application/json',
        headers: _flatten(ep.sampleRequestHeaders),
        queryParams: ep.queryParamNames ?? [],
      },
      response: primaryRespBody ? {
        body: _maybeParseJson(primaryRespBody),
        contentType: _firstValue(ep.sampleResponseHeaders?.['content-type']) ?? null,
        headers: _flatten(ep.sampleResponseHeaders),
      } : null,
    });
  }

  // Response-only samples for every status (good for assertions + fixtures).
  for (const [code, bodies] of Object.entries(respByCode)) {
    for (let j = 0; j < (bodies ?? []).length; j++) {
      const body = bodies[j];
      // Skip the body we already paired above (avoid 2× the primary response).
      if (samples.some(s => s.response?.body && s.status === Number(code) && _shallowEqual(s.response.body, _maybeParseJson(body)))) {
        continue;
      }
      samples.push({
        status: Number(code),
        request: null,
        response: {
          body: _maybeParseJson(body),
          contentType: _firstValue(ep.sampleResponseHeaders?.['content-type']) ?? null,
          headers: _flatten(ep.sampleResponseHeaders),
        },
      });
    }
  }

  return samples;
}


function _maybeParseJson(v) {
  // Crawler stores bodies as parsed objects when JSON, strings otherwise.
  // Keep them as-is; just guard against accidentally-double-stringified.
  if (typeof v !== 'string') return v;
  const s = v.trim();
  if (!s) return s;
  if (s[0] === '{' || s[0] === '[') {
    try { return JSON.parse(s); } catch { return v; }
  }
  return v;
}


function _flatten(headers) {
  // Crawler stores each header value as an array (one per observation).
  // Flatten to first-observed value for use as a replay header.
  if (!headers || typeof headers !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = Array.isArray(v) ? v[0] : v;
  }
  return out;
}


function _firstValue(v) {
  return Array.isArray(v) ? v[0] : v;
}


function _shallowEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (a[k] !== b[k]) return false;
  return true;
}


function _writeEmpty() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify({
    sourceId: 'mock-data',
    discoveryTier: DiscoveryTier.LIVE_OBSERVED,
    confidence: 0.95,
    extractedAt: new Date().toISOString(),
    target: null,
    stats: { endpointsWithSamples: 0, requestSamples: 0, responseSamples: 0, totalSamples: 0 },
    facts: { endpoints: [] },
  }, null, 2));
  console.log(`[mock-data] wrote empty bundle (no crawler input)`);
}


main();
