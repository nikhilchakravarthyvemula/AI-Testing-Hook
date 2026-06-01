// OpenAPI extractor — probe the target for an OpenAPI / Swagger spec,
// parse it, resolve $refs, and emit a structured per-endpoint bundle.
//
// Generic across frameworks — the only requirement is that the target
// publishes an OpenAPI document at a well-known path. Covers FastAPI,
// NestJS, Spring, DRF, Express+swagger, Laravel, ASP.NET Core, etc.
//
// Origin discovery (in order):
//   1. TARGET_URL env (set by testo scan --url)
//   2. crawler bundle: every unique `facts.endpoints[*].origin`
//      (these are the actually-observed backends — usually the right ones)
//   3. fallback: nothing — skip with a clear log
//
// For each candidate origin × well-known path, fetch and look for
// `openapi:` or `swagger:` key in the JSON. First valid spec wins per
// origin. Multi-origin specs (rare but possible) are emitted as separate
// entries in `specs[]`.
//
// Output:
//   output/openapi/raw.json       — every spec we fetched (verbatim)
//   output/openapi/bundle.json    — distilled per-endpoint records
//
// Consumer interface — bundle.facts.endpoints[]:
//   {
//     method, path, origin,
//     operationId, summary, description, tags,
//     authRequired, security,
//     parameters: [{name, in, required, schema}],
//     requestSchema:   resolved JSON Schema or null,
//     requestExample:  example if the spec provided one, else null,
//     responseSchemas: { "200": resolved-schema, "401": ..., ... },
//     deprecated
//   }

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { provenance, DiscoveryTier } from '../../../knowledge-base/schema.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const CRAWLER_BUNDLE = path.join(REPO_ROOT, 'output', 'crawler', 'bundle.json');
const OUT_DIR        = path.join(REPO_ROOT, 'output', 'openapi');
const RAW_FILE       = path.join(OUT_DIR, 'raw.json');
const BUNDLE_FILE    = path.join(OUT_DIR, 'bundle.json');

const FETCH_TIMEOUT_MS = 8_000;

// Order matters — earlier paths are tried first per origin.
const PROBE_PATHS = [
  '/openapi.json',              // FastAPI default
  '/v3/api-docs',               // Spring Boot springdoc default
  '/api-docs/json',             // NestJS @nestjs/swagger common
  '/api-docs',                  // NestJS alt
  '/swagger/v1/swagger.json',   // ASP.NET Core default
  '/swagger.json',              // older Swagger 2 generic
  '/api/openapi.json',          // some Laravel / API-prefixed
  '/api/swagger.json',
  '/docs/openapi.json',
  '/openapi/v3',                // Spring alt
  '/openapi',                   // some Rust frameworks
];


async function main() {
  const origins = _discoverOrigins();
  if (origins.length === 0) {
    console.warn('[openapi] no origins to probe — set TARGET_URL or run the crawler first');
    _writeEmpty();
    return;
  }
  console.log(`[openapi] probing ${origins.length} origin(s): ${origins.join(', ')}`);

  /** @type {Array<{origin: string, url: string, spec: object}>} */
  const found = [];
  for (const origin of origins) {
    const hit = await _probeOrigin(origin);
    if (hit) {
      found.push(hit);
      console.log(`[openapi] ✓ ${origin} → ${hit.url}  (${hit.spec.openapi ?? hit.spec.swagger ?? '?'} · ${Object.keys(hit.spec.paths ?? {}).length} paths)`);
    } else {
      console.log(`[openapi] ✗ ${origin} → no spec at any of the ${PROBE_PATHS.length} well-known paths`);
    }
  }

  if (found.length === 0) {
    console.warn('[openapi] no specs found — writing empty bundle');
    _writeEmpty();
    return;
  }

  // Save raw specs first so consumers can re-process without re-fetching.
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(RAW_FILE, JSON.stringify({
    extractedAt: new Date().toISOString(),
    specs: found.map(({ origin, url, spec }) => ({ origin, url, spec })),
  }, null, 2));

  // Distil per-endpoint records (with $refs resolved).
  const endpoints = [];
  let totalWithReq = 0;
  let totalWithSec = 0;
  for (const { origin, url, spec } of found) {
    const resolved = _resolveRefs(spec);
    for (const ep of _extractEndpoints(resolved)) {
      endpoints.push({ ...ep, origin });
      if (ep.requestSchema) totalWithReq++;
      if (ep.authRequired)  totalWithSec++;
    }
  }

  // Stable order — easier to diff.
  endpoints.sort((a, b) =>
    `${a.method} ${a.origin}${a.path}`.localeCompare(`${b.method} ${b.origin}${b.path}`)
  );

  const bundle = {
    sourceId: 'openapi-spec',
    discoveryTier: DiscoveryTier.SPEC ?? 'spec',
    confidence: 0.92,
    extractedAt: new Date().toISOString(),
    extractedBy: 'context-layer/content-extractor/openapi-extractor/extract.mjs',
    target: { baseUrl: origins[0] },
    stats: {
      specsFound: found.length,
      endpoints: endpoints.length,
      withRequestSchema: totalWithReq,
      withSecurity: totalWithSec,
    },
    sources: found.map(({ origin, url, spec }) => ({
      origin, url,
      title: spec.info?.title ?? null,
      version: spec.info?.version ?? null,
      specVersion: spec.openapi ?? spec.swagger ?? null,
    })),
    provenance: provenance({
      sourceId: 'openapi-spec',
      tier: 'spec',
      extractedBy: 'openapi-extractor (live HTTP probe)',
    }),
    facts: { endpoints },
  };

  fs.writeFileSync(BUNDLE_FILE, JSON.stringify(bundle, null, 2));
  const sizeKB = (fs.statSync(BUNDLE_FILE).size / 1024).toFixed(1);
  console.log(
    `[openapi] ${endpoints.length} endpoint(s) · ${totalWithReq} with request schema · ` +
    `${totalWithSec} requiring auth`
  );
  console.log(`[openapi] wrote ${path.relative(REPO_ROOT, BUNDLE_FILE)} (${sizeKB} KB)`);
}


// ── origin discovery ───────────────────────────────────────────────────────


function _discoverOrigins() {
  const set = new Set();

  // Crawler-observed origins win — these are the actual backends that
  // serve APIs. Prefer over TARGET_URL (which is usually the frontend).
  const crawler = _safeReadJson(CRAWLER_BUNDLE);
  for (const ep of crawler?.facts?.endpoints ?? []) {
    if (ep.origin) set.add(_stripSlash(ep.origin));
  }

  // TARGET_URL as fallback / supplement.
  if (process.env.TARGET_URL) {
    try {
      const u = new URL(process.env.TARGET_URL);
      set.add(_stripSlash(u.origin));
    } catch { /* ignore */ }
  }

  // Heuristic — if we only have a frontend-y origin (port 3000/3001/4000/5173/8080),
  // also try the conventional backend port (8000/8001) so a cold-start scan
  // without prior crawler output still has a chance.
  if (set.size > 0) {
    for (const origin of [...set]) {
      const m = origin.match(/^(https?:\/\/[^:/]+):(\d+)$/);
      if (!m) continue;
      const [, host, port] = m;
      const portNum = Number(port);
      const FRONTEND_PORTS = new Set([3000, 3001, 4000, 5173, 8080]);
      if (FRONTEND_PORTS.has(portNum)) {
        set.add(`${host}:8000`);     // FastAPI / Django default
        set.add(`${host}:8001`);     // common alt
      }
    }
  }

  return [...set];
}


async function _probeOrigin(origin) {
  for (const probePath of PROBE_PATHS) {
    const url = origin + probePath;
    const spec = await _tryFetch(url);
    if (spec) return { origin, url, spec };
  }
  return null;
}


async function _tryFetch(url) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    let body;
    if (ct.includes('json') || ct.includes('javascript')) {
      body = await res.json();
    } else {
      // Some servers omit content-type; try parsing as JSON anyway.
      const text = await res.text();
      try { body = JSON.parse(text); } catch { return null; }
    }
    if (!body || typeof body !== 'object') return null;
    // Validate it's an OpenAPI/Swagger doc.
    if (!body.openapi && !body.swagger) return null;
    if (!body.paths || typeof body.paths !== 'object') return null;
    return body;
  } catch {
    return null;   // network error, timeout, parse error — try next
  }
}


// ── $ref resolution ────────────────────────────────────────────────────────


function _resolveRefs(spec) {
  // Walk the spec, replace any `{$ref: "#/components/schemas/X"}` with the
  // referenced schema. Tracks visited refs per chain to break cycles.
  const schemas = spec.components?.schemas || {};
  const definitions = spec.definitions || {};   // Swagger 2

  function resolve(node, seen) {
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(n => resolve(n, seen));

    if (typeof node.$ref === 'string') {
      const ref = node.$ref;
      if (seen.has(ref)) {
        // Cyclic — bail with a placeholder rather than recurse forever.
        return { type: 'object', _ref: ref, _cyclic: true };
      }
      const target = _lookupRef(ref, schemas, definitions);
      if (!target) return node;
      const nextSeen = new Set(seen);
      nextSeen.add(ref);
      return resolve(target, nextSeen);
    }

    const out = {};
    for (const [k, v] of Object.entries(node)) {
      out[k] = resolve(v, seen);
    }
    return out;
  }

  return resolve(spec, new Set());
}


function _lookupRef(ref, schemas, definitions) {
  const m = ref.match(/^#\/components\/schemas\/(.+)$/);
  if (m) return schemas[m[1]] ?? null;
  const m2 = ref.match(/^#\/definitions\/(.+)$/);
  if (m2) return definitions[m2[1]] ?? null;
  return null;   // external $ref or unknown form — leave as-is
}


// ── endpoint extraction ────────────────────────────────────────────────────


function _extractEndpoints(spec) {
  const out = [];
  const paths = spec.paths || {};
  const baseSecurity = spec.security || [];
  const VERBS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'];

  for (const [pathPattern, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    const pathLevelParams = pathItem.parameters || [];

    for (const verb of VERBS) {
      const op = pathItem[verb];
      if (!op) continue;

      const params = [...pathLevelParams, ...(op.parameters || [])];
      const security = (op.security !== undefined) ? op.security : baseSecurity;

      // Request body schema (prefer JSON content type, fall back to first available).
      let requestSchema = null;
      let requestExample = null;
      let requestContentType = null;
      const reqBody = op.requestBody;
      if (reqBody?.content) {
        const jsonKey = Object.keys(reqBody.content).find(k => k.includes('json')) ?? Object.keys(reqBody.content)[0];
        const content = reqBody.content[jsonKey];
        if (content) {
          requestSchema = content.schema ?? null;
          requestContentType = jsonKey;
          if (content.example !== undefined) requestExample = content.example;
          else if (content.examples && typeof content.examples === 'object') {
            const firstEx = Object.values(content.examples)[0];
            if (firstEx?.value !== undefined) requestExample = firstEx.value;
          }
        }
      }

      // Response schemas keyed by status.
      const responseSchemas = {};
      for (const [status, resp] of Object.entries(op.responses || {})) {
        if (!resp?.content) continue;
        const jsonKey = Object.keys(resp.content).find(k => k.includes('json')) ?? Object.keys(resp.content)[0];
        const content = resp.content[jsonKey];
        if (content?.schema) responseSchemas[status] = content.schema;
      }

      out.push({
        method: verb.toUpperCase(),
        path: pathPattern,
        operationId: op.operationId ?? null,
        summary: op.summary ?? null,
        description: op.description ?? null,
        tags: op.tags ?? [],
        authRequired: Array.isArray(security) && security.length > 0,
        security: security ?? [],
        parameters: params.map(p => ({
          name: p.name,
          in: p.in,
          required: p.required ?? false,
          schema: p.schema ?? null,
          description: p.description ?? null,
        })),
        requestContentType,
        requestSchema,
        requestExample,
        responseSchemas,
        deprecated: op.deprecated === true,
      });
    }
  }
  return out;
}


// ── helpers ────────────────────────────────────────────────────────────────


function _stripSlash(s) {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}


function _safeReadJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
}


function _writeEmpty() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(BUNDLE_FILE, JSON.stringify({
    sourceId: 'openapi-spec',
    discoveryTier: 'spec',
    confidence: 0.92,
    extractedAt: new Date().toISOString(),
    target: null,
    stats: { specsFound: 0, endpoints: 0, withRequestSchema: 0, withSecurity: 0 },
    sources: [],
    facts: { endpoints: [] },
  }, null, 2));
}


await main();
