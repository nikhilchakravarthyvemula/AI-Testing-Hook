// Post-hoc feature tagging for the unified report.
//
// Phase-3 approach: generate + run every test as today, then attach a featureId
// to each result row by joining it back to feature-manifest.json (Phase 2). The
// manifest keys endpoints as "<METHOD> <templatedPath>" and routes as templated
// pathnames; the report rows carry either a method+path (API / auth-gate / API
// UI specs — titles already use the templated path) or a route chain (e2e
// flows). We derive the same key from each row and look it up.
//
// Deterministic, no deps. Used by byo-llm-poc/ctx.mjs buildUnifiedReport and the
// feature-grouped PDF (Phase 4).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MANIFEST = path.join(REPO_ROOT, 'output', 'features', 'feature-manifest.json');

export function loadFeatureManifest(p = MANIFEST) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// Normalize a path for matching: decode %xx, collapse volatile segments
// (ids/uuids/numbers) to {id}, and drop a trailing slash. Applied to BOTH the
// manifest keys and the row-derived keys so encoding/slash differences (e.g.
// "/models/" vs "/models", "Resume%20Analysis" vs "Resume Analysis") match.
export function templatizePath(pathname) {
  let decoded = pathname;
  try { decoded = decodeURIComponent(pathname); } catch { /* keep raw */ }
  const t = decoded.split('/').map((seg) => {
    if (!seg) return seg;
    if (/^\d+$/.test(seg)) return '{id}';
    if (/^[0-9a-fA-F]{8,}$/.test(seg)) return '{id}';
    if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-/.test(seg)) return '{id}';
    return seg;
  }).join('/');
  return t.length > 1 ? t.replace(/\/+$/, '') : t;
}

function buildIndex(manifest) {
  const ep = new Map();      // "METHOD /templated/path" -> featureId
  const route = new Map();   // "/templated/route" -> featureId
  for (const f of manifest.features || []) {
    for (const e of f.endpoints || []) ep.set(`${e.method.toUpperCase()} ${templatizePath(e.path)}`, f.featureId);
    for (const r of f.routes || []) route.set(templatizePath(r), f.featureId);
  }
  return { ep, route };
}

// Derive a lookup key from a report row (see module header for the row shapes).
function deriveKey(row) {
  const name = row.name || '';
  if (row.suite === 'api') {
    const m = /^([A-Z]+)\s+(\S+)/.exec(name);
    if (!m) return null;
    let p = m[2];
    if (/^https?:\/\//.test(p)) { try { p = new URL(p).pathname; } catch { /* keep */ } }
    return { kind: 'endpoint', key: `${m[1]} ${templatizePath(p)}` };
  }
  // UI: API / AUTH-GATE specs carry a templated method+path in the title.
  let m = /^(?:API|AUTH-GATE)\s+([A-Z]+)\s+(\/\S+?)(?:\s+→|\s+blocks|$)/.exec(name);
  if (m) return { kind: 'endpoint', key: `${m[1]} ${templatizePath(m[2])}` };
  // UI: e2e flows are a route chain "/a → /b → /c".
  m = /^e2e:\s*(.+)$/.exec(name);
  if (m) return { kind: 'routes', routes: m[1].split('→').map((s) => templatizePath(s.trim())) };
  // UI: form specs — "FORM submit on /home?createNewAgent=true (N fields)".
  m = /^FORM\b.*\son\s+(\/\S*)/i.exec(name);
  if (m) return { kind: 'routes', routes: [templatizePath(m[1].split(/[?#]/)[0])] };
  return null;
}

// Attach `featureId` to each row in place (null when it can't be mapped).
export function tagRows(rows, manifest) {
  if (!manifest) return rows;
  const idx = buildIndex(manifest);
  for (const row of rows) {
    const d = deriveKey(row);
    let fid = null;
    if (d?.kind === 'endpoint') fid = idx.ep.get(d.key) || null;
    else if (d?.kind === 'routes') {
      // A flow crosses pages; attribute it to its DESTINATION feature (last
      // matching route), falling back to any matching route.
      for (let i = d.routes.length - 1; i >= 0 && !fid; i--) fid = idx.route.get(d.routes[i]) || null;
    }
    row.featureId = fid;
  }
  return rows;
}

// Per-feature rollup: test tallies joined with the manifest's coverage + gaps.
// Features are emitted in manifest (priority) order; an "_untagged" bucket
// collects rows that couldn't be mapped (e.g. third-party IdP endpoints, forms).
export function summarizeFeatures(rows, manifest) {
  if (!manifest) return [];
  const byId = new Map();
  for (const f of manifest.features || []) {
    byId.set(f.featureId, {
      featureId: f.featureId, name: f.name,
      priority: f.priority || {},
      gapCount: (f.gaps || []).length,
      testableEndpoints: f.priority?.testableEndpoints ?? (f.endpoints || []).filter((e) => e.matched).length,
      total: 0, passed: 0, failed: 0, skipped: 0,
    });
  }
  const untagged = { featureId: '_untagged', name: 'Untagged', priority: {}, gapCount: 0, testableEndpoints: 0, total: 0, passed: 0, failed: 0, skipped: 0 };
  for (const row of rows) {
    const bucket = (row.featureId && byId.get(row.featureId)) || untagged;
    bucket.total++;
    if (row.status === 'passed') bucket.passed++;
    else if (row.status === 'failed') bucket.failed++;
    else if (row.status === 'skipped') bucket.skipped++;
  }
  const out = [...byId.values()].filter((f) => f.total > 0);
  if (untagged.total > 0) out.push(untagged);
  return out;
}
