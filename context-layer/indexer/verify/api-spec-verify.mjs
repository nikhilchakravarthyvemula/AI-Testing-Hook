// api-spec verifier — LLM-assisted authenticity check + body repair, run AFTER
// the indexer builds the topics and BEFORE the OpenAPI/test contract is used.
//
// Generic (framework-agnostic). Three stages:
//   1. Build a unified endpoint set (apis.json roster ∪ api-spec.json contracts)
//      and tier each endpoint's EVIDENCE: observed live / in the app's published
//      OpenAPI spec / code-only (static analysis).
//   2. Deterministic reconcile — drop phantom "stripped-prefix" duplicates: a
//      code-only endpoint whose path is a segment-aligned SUFFIX of a real
//      (observed|published) sibling (e.g. code-only `/users` under observed
//      `/api/v1/users`). This is the router/blueprint-prefix artifact, and the
//      rule holds for any framework.
//   3. LLM — judge the ambiguous remainder (keep/drop) and synthesize/repair
//      schema-valid request bodies for write endpoints that lack one (the gaps).
//
// Output: rewrites output/indexed_output/api-spec.json IN PLACE (verified,
// deduped, body-filled) + a sidecar api-spec.verification.json report.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adviseOn } from '../../content-extractor/crawler/llm-advisor/index.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const OUT = path.join(REPO_ROOT, 'output', 'indexed_output');

const LLM_CONCURRENCY = Number(process.env.API_VERIFY_CONCURRENCY || 6);
const LLM_BATCH = Number(process.env.API_VERIFY_BATCH || 10);
const LLM_ENABLED = (process.env.CRAWLER_LLM ?? '1') !== '0';
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH']);


// ── path helpers (generic) ──────────────────────────────────────────────────

const segs = (p) => String(p || '').split('/').filter(Boolean);
// Normalize templated ids ({user_id} → {}) so /users/{id} == /users/{user_id}.
const normSeg = (s) => (/^\{.*\}$/.test(s) || /^:/.test(s) ? '{}' : s.toLowerCase());
const normSegs = (p) => segs(p).map(normSeg);

/** True if `longP`'s segments END WITH `shortP`'s segments and longP is longer
 *  (i.e. shortP is longP with a non-empty prefix stripped). */
function isSuffixTwin(shortP, longP) {
  const a = normSegs(shortP), b = normSegs(longP);
  if (a.length === 0) return false;            // root "/" is not a stripped prefix of anything
  if (b.length <= a.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[a.length - 1 - i] !== b[b.length - 1 - i]) return false;
  }
  return true;
}


// ── load ──────────────────────────────────────────────────────────────────

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

function loadInputs() {
  const apis    = readJson(path.join(OUT, 'apis.json'));
  const apiSpec = readJson(path.join(OUT, 'api-spec.json'));
  const models  = readJson(path.join(OUT, 'models.json'));
  const published = readJson(path.join(REPO_ROOT, 'output', 'openapi', 'bundle.json'));
  const mock    = readJson(path.join(REPO_ROOT, 'output', 'mock-data', 'bundle.json'));
  return { apis, apiSpec, models, published, mock };
}

// Build a lookup of model name → field list for body synthesis hints.
function buildModelIndex(models) {
  const idx = {};
  for (const it of models?.items ?? []) {
    const m = it.primary ?? it;
    if (m?.name && Array.isArray(m.fields)) idx[m.name] = m.fields.map(f => ({ name: f.name, type: f.annotation ?? f.type ?? null }));
  }
  return idx;
}

// Set of `METHOD norm(path)` present in the app's PUBLISHED spec (ground truth).
function buildPublishedSet(published) {
  const set = new Set();
  const eps = published?.facts?.endpoints ?? published?.endpoints ?? [];
  for (const e of eps) if (e?.method && e?.path) set.add(`${e.method.toUpperCase()} ${normSegs(e.path).join('/')}`);
  return set;
}

// Observed request bodies keyed by `METHOD norm(path)`.
function buildObservedBodies(mock) {
  const out = {};
  const items = mock?.facts?.endpoints ?? mock?.endpoints ?? mock?.items ?? [];
  for (const e of items) {
    const m = e.method || e.request?.method, p = e.path || e.request?.path;
    const body = e.requestBody ?? e.request?.body ?? e.sampleRequest?.body;
    if (m && p && body != null) out[`${m.toUpperCase()} ${normSegs(p).join('/')}`] = body;
  }
  return out;
}


// ── evidence tiering ────────────────────────────────────────────────────────

const CODE_SRC = /ast|fastapi|express|flask|spring|django|rails|nest|router|framework/i;
const LIVE_SRC = /crawler|mock-data|live/i;

// Union evidence across ALL items that describe this endpoint (the apis.json
// roster entry AND the api-spec contract wrapper) — a live observation recorded
// on either one counts. Looking at just one missed e.g. the root `/`, whose
// crawler observation lived on the contract wrapper while a code-only roster
// entry shadowed it.
function evidenceFor(items, publishedSet, key) {
  const sources = new Set();
  for (const item of items) {
    if (!item) continue;
    for (const o of item.observations ?? []) if (o?.sourceId) sources.add(String(o.sourceId));
    for (const s of item.primary?.provenance?.sources ?? []) sources.add(String(s));
  }
  const arr = [...sources];
  const observed  = arr.some(s => LIVE_SRC.test(s));
  const published = publishedSet.has(key);
  const codeOnly  = !observed && !published && arr.some(s => CODE_SRC.test(s));
  return { observed, published, codeOnly, sources: arr };
}


// ── concurrency ──────────────────────────────────────────────────────────────

async function runPool(items, n, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; await fn(items[i], i); }
  }));
}


// ── main ────────────────────────────────────────────────────────────────────

export async function verifyApiSpec() {
  const { apis, apiSpec, models, published, mock } = loadInputs();
  if (!apis && !apiSpec) { console.warn('[api-verify] no apis.json / api-spec.json — nothing to verify'); return null; }

  const publishedSet = buildPublishedSet(published);
  const modelIdx = buildModelIndex(models);
  const observedBodies = buildObservedBodies(mock);
  const hasPublishedSpec = publishedSet.size > 0;

  // 1) Unified endpoint map (api-spec contract wins for shape; apis.json adds coverage).
  const ep = new Map();   // key → { key, method, path, contract|null, apisItem|null, evidence }
  const keyOf = (m, p) => `${String(m).toUpperCase()}:${p}`;   // conventional METHOD:path id
  const ensure = (m, p) => { const k = keyOf(m, p); if (!ep.has(k)) ep.set(k, { key: k, method: String(m).toUpperCase(), path: p, contract: null, apisItem: null }); return ep.get(k); };

  for (const it of apiSpec?.items ?? []) {
    const pr = it.primary; if (!pr?.method || !pr?.path) continue;
    const e = ensure(pr.method, pr.path); e.contract = pr; e.specWrap = it;
  }
  for (const it of apis?.items ?? []) {
    const pr = it.primary; if (!pr?.method || !pr?.path) continue;
    const e = ensure(pr.method, pr.path); e.apisItem = it; e.apisPrimary = pr;
  }
  for (const e of ep.values()) {
    const nkey = `${e.method} ${normSegs(e.path).join('/')}`;
    e.evidence = evidenceFor([e.apisItem, e.specWrap], publishedSet, nkey);
    e.authRequired = e.apisPrimary?.authRequired ?? e.contract?.auth?.required ?? null;
    e.requestSchemaRef = e.apisPrimary?.requestSchemaRef ?? null;
    e.observedBody = observedBodies[nkey] ?? null;
  }
  const allEps = [...ep.values()];

  // 2) Deterministic phantom removal (generic stripped-prefix suffix-twins).
  const realPaths = allEps.filter(e => e.evidence.observed || e.evidence.published);
  const dropped = [];
  for (const e of allEps) {
    if (!e.evidence.codeOnly) continue;            // only code-only can be a stripped artifact
    const twin = realPaths.find(r => r.method === e.method && r.path !== e.path && isSuffixTwin(e.path, r.path));
    if (twin) { e.drop = true; e.dropReason = `stripped-prefix duplicate of ${twin.key}`; e.decidedBy = 'deterministic';
      dropped.push({ id: e.key, reason: e.dropReason, by: 'deterministic' }); }
  }

  // 3) LLM — judge ambiguous (code-only survivors) + fill/repair write bodies.
  const survivors = allEps.filter(e => !e.drop);
  const needsLlm = survivors.filter(e => {
    const ambiguous = e.evidence.codeOnly && !e.evidence.published;     // not proven real
    const missingBody = WRITE_METHODS.has(e.method) && !(e.contract?.requestBody?.example);
    return ambiguous || missingBody;
  });

  let llmBatches = 0, bodiesFilled = [];
  if (LLM_ENABLED && needsLlm.length) {
    const batches = [];
    for (let i = 0; i < needsLlm.length; i += LLM_BATCH) batches.push(needsLlm.slice(i, i + LLM_BATCH));
    console.log(`[api-verify] ${allEps.length} endpoints | ${dropped.length} dropped (deterministic) | ` +
      `${needsLlm.length} → LLM (${batches.length} batches @ ${LLM_CONCURRENCY}); published-spec=${hasPublishedSpec ? 'yes' : 'no'}`);
    await runPool(batches, LLM_CONCURRENCY, async (batch) => {
      const endpoints = batch.map(e => ({
        method: e.method, path: e.path, evidence: e.evidence, authRequired: e.authRequired,
        siblings: realPaths.filter(r => r.method === e.method && isSuffixTwin(e.path, r.path)).map(r => r.path),
        existingBody: e.contract?.requestBody?.example ?? null,
        observedBody: e.observedBody,
        models: e.requestSchemaRef && modelIdx[e.requestSchemaRef] ? { [e.requestSchemaRef]: modelIdx[e.requestSchemaRef] } : null,
      }));
      const advice = await adviseOn({ kind: 'api-verify', input: { endpoints, hasPublishedSpec } });
      llmBatches++;
      const verdicts = advice?.recommendation?.verdicts ?? [];
      for (const v of verdicts) {
        const e = batch[v.i - 1]; if (!e) continue;
        if (e.evidence.codeOnly && !e.evidence.published && v.keep === false) {
          e.drop = true; e.dropReason = v.reason || 'LLM: not a real endpoint'; e.decidedBy = 'llm';
          e.authenticity = v.authenticity;
          dropped.push({ id: e.key, reason: e.dropReason, by: 'llm', authenticity: v.authenticity });
        } else {
          e.authenticity = v.authenticity;
          if (v.requestBody?.example != null && WRITE_METHODS.has(e.method) && !(e.contract?.requestBody?.example)) {
            e._filledBody = v.requestBody;
            bodiesFilled.push({ id: e.key, contentType: v.requestBody.contentType });
          }
        }
      }
    });
  } else {
    console.log(`[api-verify] ${allEps.length} endpoints | ${dropped.length} dropped (deterministic) | ` +
      `LLM ${LLM_ENABLED ? 'no ambiguous endpoints' : 'disabled (CRAWLER_LLM=0)'} — deterministic only`);
  }

  // 3b) Deterministic body-gap fill — reliable fallback for any kept write
  // endpoint still missing a body (LLM body, when present, already won above).
  const kept = survivors.filter(e => !e.drop);
  for (const e of kept) {
    if (!WRITE_METHODS.has(e.method)) continue;
    if (e._filledBody || e.contract?.requestBody?.example) continue;     // already have one
    if (!e.requestSchemaRef || !modelIdx[e.requestSchemaRef]) continue;  // no model to build from
    const body = synthBodyFromFields(modelIdx[e.requestSchemaRef]);
    if (body) { e._filledBody = { example: body, contentType: 'application/json' };
      bodiesFilled.push({ id: e.key, contentType: 'application/json', by: 'deterministic' }); }
  }

  // 4) Emit verified api-spec.json (in place) — kept endpoints as contracts.
  const items = kept.map(e => {
    const base = e.contract ?? synthContract(e);
    if (e._filledBody) {
      base.requestBody = { example: e._filledBody.example, schema: base.requestBody?.schema ?? null, contentType: e._filledBody.contentType };
    }
    const wrap = e.specWrap ?? { id: e.key, topic: 'api-spec', observations: [], consensus: 'verified' };
    return { ...wrap, primary: base, verification: { authenticity: e.authenticity ?? (e.evidence.observed || e.evidence.published ? 0.95 : 0.6),
      evidence: e.evidence, decidedBy: e.decidedBy ?? 'kept' } };
  });

  const target = apiSpec?.target ?? apis?.target ?? null;
  const verifiedBundle = {
    topic: 'api-spec',
    description: 'VERIFIED per-endpoint test contract (authenticity-checked, phantom-deduped, bodies repaired).',
    generatedAt: apiSpec?.generatedAt ?? null,
    target,
    itemCount: items.length,
    sourcesContributing: [...new Set(items.flatMap(i => i.verification.evidence.sources))],
    verification: {
      ranAt: null, llmEnabled: LLM_ENABLED, llmBatches, hasPublishedSpec,
      totalCandidates: allEps.length, kept: items.length, droppedCount: dropped.length, bodiesFilled: bodiesFilled.length,
    },
    items,
  };
  fs.writeFileSync(path.join(OUT, 'api-spec.json'), JSON.stringify(verifiedBundle, null, 2));

  const report = {
    generatedAt: null, llmEnabled: LLM_ENABLED, hasPublishedSpec,
    totals: { candidates: allEps.length, kept: items.length, dropped: dropped.length, bodiesFilled: bodiesFilled.length },
    dropped, bodiesFilled,
  };
  fs.writeFileSync(path.join(OUT, 'api-spec.verification.json'), JSON.stringify(report, null, 2));

  console.log(`[api-verify] verified api-spec.json: ${allEps.length} candidates → ${items.length} kept, ` +
    `${dropped.length} dropped (${dropped.filter(d => d.by === 'deterministic').length} phantom + ${dropped.filter(d => d.by === 'llm').length} LLM), ` +
    `${bodiesFilled.length} bodies filled. Report: api-spec.verification.json`);
  return verifiedBundle;
}

// Deterministic request-body synthesis from model field types (generic across
// languages — maps common type annotations to sample values). Used to fill body
// gaps reliably; the LLM body, when it returns one, takes precedence.
function sampleFromType(ann) {
  const t = String(ann || '').toLowerCase();
  if (/\b(list|array|sequence|\[\])/.test(t) || t.endsWith('[]')) return [];
  if (/\b(dict|map|object|json)\b/.test(t)) return {};
  if (/\b(bool|boolean)\b/.test(t)) return true;
  if (/\b(int|integer|long|number)\b/.test(t)) return 0;
  if (/\b(float|double|decimal)\b/.test(t)) return 0.0;
  if (/\b(datetime|date|time)\b/.test(t)) return '2024-01-01T00:00:00Z';
  if (/\b(uuid|guid)\b/.test(t)) return '00000000-0000-0000-0000-000000000000';
  return 'string';
}
function synthBodyFromFields(fields) {
  if (!Array.isArray(fields) || !fields.length) return null;
  const body = {};
  for (const f of fields) {
    if (!f?.name || /^(id|created_at|updated_at)$/i.test(f.name)) continue;  // server-managed
    body[f.name] = sampleFromType(f.type ?? f.annotation);
  }
  return Object.keys(body).length ? body : null;
}

// Minimal contract for a code-only endpoint that had no api-spec entry.
function synthContract(e) {
  return {
    id: e.key, method: e.method, path: e.path, origin: null,
    auth: { scheme: null, required: e.authRequired, headerName: null },
    requestHeaders: {}, requestBody: { example: null, schema: null, contentType: null },
    responses: {}, expectedStatus: null,
    provenance: { sources: e.evidence.sources, primarySource: e.evidence.sources[0] ?? null },
  };
}

// CLI entry: `node context-layer/indexer/verify/api-spec-verify.mjs`
// (compare decoded paths — `import.meta.url` percent-encodes spaces, so a naive
//  `file://${argv[1]}` comparison fails on paths like "testing Harness").
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyApiSpec().catch(e => { console.error(`[api-verify] failed: ${e.message}`); process.exit(1); });
}
