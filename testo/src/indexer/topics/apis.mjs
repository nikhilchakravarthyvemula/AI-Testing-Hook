// Topic: apis — HTTP endpoints discovered by ANY source.
//
// Sources contributing:
//   * python-ast / python-fastapi / python-flask / python-django
//   * java-spring / java-jaxrs
//   * csharp-aspnet
//   * openapi-file / markdown-apispec
//   * crawler (endpoints where isApi=true)
//   * graphify (nodes that look like API endpoints — best-effort)
//
// Dedup key: `${METHOD}:${normalized-path}`.

import { indexedItem, observation, provenanceOf } from '../lib/models.mjs';


const SOURCE_TIER = {
  'python-ast':       'ast',
  'python-fastapi':   'ast',
  'python-flask':     'ast',
  'python-django':    'ast',
  'java-spring':      'ast',
  'java-jaxrs':       'ast',
  'csharp-aspnet':    'code_regex',
  'openapi-file':     'spec',
  'markdown-apispec': 'docs_extracted',
  // crawler + graphify handled inline below
};

const CODE_EXTRACTOR_IDS = Object.keys(SOURCE_TIER);

/** Fields only a live run can observe — the crawler owns these outright. */
const LIVE_ONLY_FIELDS = new Set([
  'statusCounts', 'contentTypes', 'observedAuth', 'observedJwtClaims',
  'avgRequestMs', 'avgResponseBytes', 'triggeredByPages', 'sampleCount',
  'queryParamNames', 'origin',
]);


/** @param {import('../lib/sources.mjs').LoadedSources} sources */
export function build(sources) {
  /** @type {Map<string, {primary: Object, observations: import('../lib/models.mjs').Observation[]}>} */
  const byKey = new Map();

  for (const id of CODE_EXTRACTOR_IDS) {
    const bundle = sources.codeExtractors[id];
    if (!bundle?.endpoints?.length) continue;
    for (const ep of bundle.endpoints) {
      const method = (ep.method || 'GET').toUpperCase();
      const epPath = _normalisePath(ep.path);
      if (!epPath) continue;
      const key = `${method}:${epPath}`;

      const fields = {
        method,
        path: epPath,
        operationId: ep.operation_id ?? null,
        summary: ep.summary ?? null,
        description: ep.description ?? null,
        tags: ep.tags ?? [],
        authRequired: ep.auth_required ?? null,
        parameters: ep.parameters ?? null,
        requestSchemaRef: ep.schema_ref ?? null,
        responseSchemas: ep.response_schemas ?? null,
        idempotentHint: ep.idempotent_hint ?? null,
        framework: ep.framework ?? null,
        handler: ep.handler ?? null,
      };
      _addObservation(byKey, key, fields, {
        sourceId: id,
        discoveryTier: SOURCE_TIER[id],
        ...provenanceOf(ep),
      });
    }
  }

  // crawler — live-observed endpoints (only the ones flagged isApi=true)
  const crawlerEndpoints = sources.crawler?.facts?.endpoints ?? [];
  for (const ep of crawlerEndpoints) {
    if (!ep.isApi) continue;
    const method = (ep.method || 'GET').toUpperCase();
    const epPath = _normalisePath(ep.path);
    if (!epPath) continue;
    const key = `${method}:${epPath}`;

    const fields = {
      method,
      path: epPath,
      origin: ep.origin,
      blocked: ep.blocked ?? false,                    // spec-15: guard intercepted this write (never hit the server)
      interceptedSamples: ep.interceptedSamples ?? 0,  // times we clicked it + blocked it at the wire
      statusCounts: ep.statusCounts,
      contentTypes: ep.contentTypes,
      observedAuth: ep.observedAuth,
      observedJwtClaims: ep.observedJwtClaims,
      queryParamNames: ep.queryParamNames,
      avgRequestMs: ep.avgRequestMs,
      avgResponseBytes: ep.avgResponseBytes,
      triggeredByPages: ep.triggeredByPages,
      sampleCount: ep.samples?.length ?? 0,
    };
    _addObservation(byKey, key, fields, {
      sourceId: 'crawler',
      discoveryTier: 'live_observed',
    });
  }

  // graphify — best-effort match on file/symbol names that look like
  // endpoint handlers. Conservative: only counts a graphify node if its
  // label includes an HTTP verb or matches an existing endpoint key.
  // (Anything more aggressive would create false positives.)
  // For v1 we skip graphify here — it surfaces relationships better
  // expressed in the `interactions` topic.

  return [...byKey.entries()].map(([key, { primary, observations }]) =>
    indexedItem('apis', key, primary, observations, _apiAgrees)
  );
}


// ── helpers ────────────────────────────────────────────────────────────────

function _addObservation(byKey, key, fields, prov) {
  let bucket = byKey.get(key);
  if (!bucket) {
    bucket = {
      primary: { method: fields.method, path: fields.path },
      observations: [],
    };
    byKey.set(key, bucket);
  }
  bucket.observations.push(observation({ ...prov, fields }));
  // Merge useful fields into `primary` — semantic fields keep the first
  // non-empty value; runtime-only fields are owned by the live-observed source.
  _mergeIntoPrimary(bucket.primary, fields, prov.sourceId);
}

function _mergeIntoPrimary(primary, fields, sourceId) {
  const isLive = sourceId === 'crawler';
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (LIVE_ONLY_FIELDS.has(k)) {
      // Only runtime can know these, so live owns them: it overwrites, and no
      // other source may fill them in.
      if (isLive) primary[k] = v;
      continue;
    }
    primary[k] ??= v;  // first non-empty wins for semantic fields
  }
}

function _apiAgrees(a, b) {
  return a.fields?.method === b.fields?.method && a.fields?.path === b.fields?.path;
}

/** Strip trailing slash (except root); collapse repeated slashes. */
function _normalisePath(p) {
  if (!p || typeof p !== 'string') return null;
  let s = p.replace(/\/{2,}/g, '/');
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}
