// Generate OpenAPI 3.1 spec + markdown report from the latest crawl run.
//
// Reads:  output/crawler/raw/{requests,responses}.ndjson
//         output/crawler/bodies/<sha16>.bin
// Writes: output/crawler/api-spec/{openapi.yaml, openapi.json, report.md, summary.json}
//
// Path templating: numeric path segments → {id}.
// Schema inference: walk a JSON sample → {type, properties|items, ...}.
// Redaction: passwords / tokens / emails replaced before sample emission.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { templatePath } from './lib/url-template.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const OUT_DIR = path.join(REPO_ROOT, 'output', process.env.CRAWLER_OUT_DIR_NAME || 'crawler');
const RAW_DIR = path.join(OUT_DIR, 'raw');
const BODIES_DIR = path.join(OUT_DIR, 'bodies');
// Canonical crawler-inferred OpenAPI location (consumed by the indexer's
// api-spec topic + generation-layer/openapi-test-gen). Runs every scan via
// `npm run all` (crawl → analyze → spec).
const SPEC_DIR = path.join(OUT_DIR, 'api-spec');
fs.mkdirSync(SPEC_DIR, { recursive: true });

const REDACT_HEADERS = new Set([
  'authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-auth-token',
]);
const REDACT_BODY_KEYS = new Set([
  'password', 'access_token', 'refresh_token', 'token', 'api_key', 'secret',
]);

function* ndjson(filePath) {
  if (!fs.existsSync(filePath)) return;
  const txt = fs.readFileSync(filePath, 'utf8');
  for (const line of txt.split('\n')) {
    if (!line) continue;
    try { yield JSON.parse(line); } catch {}
  }
}

// templatePath moved to ./lib/url-template.mjs (shared with analyze.mjs).

function redactJson(node) {
  if (node === null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.slice(0, 5).map(redactJson);
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (REDACT_BODY_KEYS.has(k.toLowerCase()) || /password|token|secret/i.test(k)) {
      out[k] = '<redacted>';
    } else if (k.toLowerCase() === 'email' && typeof v === 'string') {
      out[k] = '<redacted>';
    } else {
      out[k] = redactJson(v);
    }
  }
  return out;
}

function inferSchema(node) {
  if (node === null) return { type: 'null' };
  if (Array.isArray(node)) {
    if (node.length === 0) return { type: 'array', items: {} };
    return { type: 'array', items: inferSchema(node[0]) };
  }
  switch (typeof node) {
    case 'string':  return { type: 'string' };
    case 'boolean': return { type: 'boolean' };
    case 'number':  return Number.isInteger(node) ? { type: 'integer' } : { type: 'number' };
    case 'object': {
      const properties = {};
      for (const [k, v] of Object.entries(node)) properties[k] = inferSchema(v);
      return { type: 'object', properties };
    }
    default: return {};
  }
}

function readBody(bodyHash) {
  if (!bodyHash) return null;
  const p = path.join(BODIES_DIR, `${bodyHash}.bin`);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p);
}

function parseJsonMaybe(buf, contentType) {
  if (!buf) return null;
  if (contentType && !/json/i.test(contentType)) return null;
  try { return JSON.parse(buf.toString('utf8')); } catch { return null; }
}

// ---- pair requests with responses ----
const requests = [...ndjson(path.join(RAW_DIR, 'requests.ndjson'))];
const responses = [...ndjson(path.join(RAW_DIR, 'responses.ndjson'))];

// key: METHOD url (used for greedy pairing — we don't have CDP requestId here)
const reqByKey = new Map();
for (const r of requests) {
  const key = `${r.method} ${r.url}`;
  if (!reqByKey.has(key)) reqByKey.set(key, []);
  reqByKey.get(key).push(r);
}

// endpoints: key = METHOD templatedPath
const endpoints = new Map();
function ep(method, tplPath) {
  const k = `${method} ${tplPath}`;
  if (!endpoints.has(k)) {
    endpoints.set(k, {
      method, path: tplPath,
      samples: [], statuses: new Map(), origins: new Set(),
      pageUrls: new Set(),
    });
  }
  return endpoints.get(k);
}

let pairedCount = 0;
const stats = {
  requests: requests.length,
  responses: responses.length,
  paired: 0,
  endpoints: 0,
  htmlPages: 0,
  jsonApis: 0,
  origins: new Set(),
  contentTypes: new Map(),
};

const STATIC_ASSET_RE = /\/(_next\/static\/|static\/chunks\/|favicon\.|\.(?:js|css|map|woff2?|ttf|otf|png|jpe?g|gif|svg|webp|ico)(?:$|\?))/i;

for (const resp of responses) {
  if (STATIC_ASSET_RE.test(resp.url)) continue;
  if (resp.status === 0 || resp.status === 204 || resp.status === 304) {
    // still count, but skip body parsing
  }
  const url = new URL(resp.url);
  const tplPath = templatePath(url.pathname);
  const e = ep(resp.method, tplPath);
  e.origins.add(url.origin);
  e.pageUrls.add(resp.pageUrl);
  e.statuses.set(resp.status, (e.statuses.get(resp.status) || 0) + 1);

  stats.origins.add(url.origin);
  const ct = (resp.contentType || '').split(';')[0].trim() || 'unknown';
  stats.contentTypes.set(ct, (stats.contentTypes.get(ct) || 0) + 1);

  const matchReqs = reqByKey.get(`${resp.method} ${resp.url}`) || [];
  const reqRec = matchReqs.shift() || null;
  if (reqRec) pairedCount++;

  const reqBodyJson = reqRec?.postData
    ? (() => { try { return JSON.parse(reqRec.postData); } catch { return null; } })()
    : null;
  const respBodyBuf = readBody(resp.bodyHash);
  const respBodyJson = parseJsonMaybe(respBodyBuf, resp.contentType);

  e.samples.push({
    queryParams: Object.fromEntries(url.searchParams),
    reqHeaders: reqRec?.headers || {},
    reqBodyJson,
    status: resp.status,
    respHeaders: resp.headers || {},
    respBodyJson,
    contentType: resp.contentType,
  });
}
stats.paired = pairedCount;
stats.endpoints = endpoints.size;
for (const e of endpoints.values()) {
  if ([...e.statuses.keys()].some(s => s >= 200 && s < 400)) {
    const sample = e.samples.find(s => s.respBodyJson != null);
    if (sample) stats.jsonApis++;
    else stats.htmlPages++;
  }
}

// ---- emit openapi ----
const openapi = {
  openapi: '3.1.0',
  info: {
    title: 'Crawled API',
    version: '0.1.0-crawled',
    description: `Spec inferred from a Crawlee+Playwright crawl. ${endpoints.size} endpoints discovered. Inductive, not contractual.`,
  },
  servers: [...stats.origins].map(o => ({ url: o })),
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      cookieAuth: { type: 'apiKey', in: 'cookie', name: 'session' },
    },
  },
  paths: {},
};

// Request headers we never want to surface as spec parameters: hop-by-hop,
// fetch-metadata, and browser-managed headers add noise and aren't part of
// the API contract. Auth/cookie ARE surfaced (as security), not as params.
const HEADER_NOISE = new Set([
  'host','connection','content-length','accept-encoding','accept-language',
  'user-agent','referer','origin','authorization','cookie','priority',
  'cache-control','pragma','dnt','te','upgrade-insecure-requests',
  'sec-fetch-dest','sec-fetch-mode','sec-fetch-site','sec-fetch-user',
  'sec-ch-ua','sec-ch-ua-mobile','sec-ch-ua-platform','sec-gpc',
]);

const sortedEndpoints = [...endpoints.values()].sort((a, b) =>
  a.path.localeCompare(b.path) || a.method.localeCompare(b.method)
);

for (const e of sortedEndpoints) {
  if (!openapi.paths[e.path]) openapi.paths[e.path] = {};
  const op = {
    summary: `${e.method} ${e.path}`,
    operationId: (`${e.method.toLowerCase()}_${e.path}`.replace(/[^a-zA-Z0-9]+/g, '_')).replace(/^_|_$/g, ''),
    responses: {},
    'x-sample-count': e.samples.length,
    'x-pages-triggering': [...e.pageUrls].slice(0, 5),
  };

  // query params from observed samples
  const params = [];
  const paramNames = new Set();
  for (const s of e.samples) for (const k of Object.keys(s.queryParams)) paramNames.add(k);
  for (const name of paramNames) {
    // representative observed value → example
    const ex = e.samples.map(s => s.queryParams[name]).find(v => v != null);
    params.push({ name, in: 'query', required: false, schema: { type: 'string' }, example: ex });
  }

  // header params from observed REQUEST headers (minus noise + auth/cookie).
  // Surfaces content-type, accept, and any custom x-* the API expects.
  const headerVals = new Map();   // name → first observed value
  let sawBearer = false, sawCookieAuth = false;
  for (const s of e.samples) {
    for (const [k, v] of Object.entries(s.reqHeaders || {})) {
      const lk = k.toLowerCase();
      if (lk === 'authorization' && /^bearer/i.test(v)) sawBearer = true;
      if (lk === 'cookie') sawCookieAuth = true;
      if (HEADER_NOISE.has(lk)) continue;
      if (!headerVals.has(lk)) headerVals.set(lk, v);
    }
  }
  for (const [name, value] of headerVals) {
    params.push({
      name, in: 'header', required: false, schema: { type: 'string' },
      example: REDACT_HEADERS.has(name) ? '<redacted>' : value,
    });
  }
  if (params.length) op.parameters = params;

  // security: bearer / cookie as observed
  const sec = [];
  if (sawBearer) sec.push({ bearerAuth: [] });
  if (sawCookieAuth) sec.push({ cookieAuth: [] });
  if (sec.length) op.security = sec;

  // request body (first non-null)
  const reqSample = e.samples.find(s => s.reqBodyJson != null);
  if (reqSample) {
    op.requestBody = {
      content: {
        'application/json': {
          schema: inferSchema(reqSample.reqBodyJson),
          example: redactJson(reqSample.reqBodyJson),
        },
      },
    };
  }

  // responses (one per observed status)
  const statusToSample = new Map();
  for (const s of e.samples) {
    if (!statusToSample.has(s.status) && s.respBodyJson != null) statusToSample.set(s.status, s);
  }
  if (statusToSample.size === 0) {
    // record at least one status, no body
    const anyStatus = e.samples[0]?.status || 200;
    op.responses[String(anyStatus)] = { description: 'No body captured' };
  } else {
    for (const [status, s] of statusToSample.entries()) {
      op.responses[String(status)] = {
        description: 'Captured',
        content: {
          'application/json': {
            schema: inferSchema(s.respBodyJson),
            example: redactJson(s.respBodyJson),
          },
        },
      };
    }
  }

  openapi.paths[e.path][e.method.toLowerCase()] = op;
}

fs.writeFileSync(path.join(SPEC_DIR, 'openapi.yaml'), yaml.dump(openapi, { lineWidth: 120 }));
fs.writeFileSync(path.join(SPEC_DIR, 'openapi.json'), JSON.stringify(openapi, null, 2));

// ---- markdown report ----
const lines = [];
lines.push('# Crawled API');
lines.push('');
lines.push(`- Generated: ${new Date().toISOString()}`);
lines.push(`- Origins: ${[...stats.origins].join(', ')}`);
lines.push(`- Requests captured: **${stats.requests}**`);
lines.push(`- Responses captured: **${stats.responses}** (paired: ${stats.paired})`);
lines.push(`- Unique endpoints: **${stats.endpoints}** (json-bodied: ${stats.jsonApis}, html/other: ${stats.htmlPages})`);
lines.push(`- Body cache: ${fs.readdirSync(BODIES_DIR).length} unique blobs`);
lines.push('');
lines.push('## Endpoints');
lines.push('');
lines.push('| Method | Path | Samples | Statuses | JSON body |');
lines.push('|---|---|---|---|---|');
for (const e of sortedEndpoints) {
  const statuses = [...e.statuses.entries()].map(([s, n]) => `${s}×${n}`).join(', ');
  const hasJson = e.samples.some(s => s.respBodyJson != null) ? 'yes' : 'no';
  lines.push(`| ${e.method} | \`${e.path}\` | ${e.samples.length} | ${statuses} | ${hasJson} |`);
}
fs.writeFileSync(path.join(SPEC_DIR, 'report.md'), lines.join('\n') + '\n');

// ---- summary.json ----
const summary = {
  generatedAt: new Date().toISOString(),
  requests: stats.requests,
  responses: stats.responses,
  paired: stats.paired,
  endpoints: stats.endpoints,
  jsonApis: stats.jsonApis,
  htmlPages: stats.htmlPages,
  origins: [...stats.origins],
  contentTypes: Object.fromEntries(stats.contentTypes),
};
fs.writeFileSync(path.join(SPEC_DIR, 'summary.json'), JSON.stringify(summary, null, 2));

console.log(`[spec] endpoints=${stats.endpoints} jsonApis=${stats.jsonApis} htmlPages=${stats.htmlPages}`);
console.log(`[spec] wrote ${SPEC_DIR}/`);
