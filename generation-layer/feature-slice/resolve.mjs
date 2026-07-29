// Feature-slice resolver — the join the context layer leaves for generation.
//
// features.json describes each feature by fact IDs (endpoint::METHOD::origin::path,
// page::path). The generators speak a different language: the api-test-generator
// keys off apis.json (method+path) and the e2e generator off routes.json (routes
// + pages). This module resolves each feature's fact-ID members into the concrete
// endpoints + route templates those generators produce, attaches the feature's
// actual gap records (features.json only carries gap COUNTS), and orders features
// by gap severity so the highest-risk slices come first.
//
// Output: output/features/feature-manifest.json — the single artifact the
// feature-slice test tagging (Phase 3) and the feature-grouped PDF (Phase 4) read.
//
// Deterministic, no LLM, no deps. Run standalone: `node resolve.mjs`
// or import { buildFeatureManifest } from it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(REPO_ROOT, 'output');

const P = {
  features: path.join(OUT, 'features', 'features.json'),
  gaps: path.join(OUT, 'gaps', 'gaps.json'),
  apis: path.join(OUT, 'indexed_output', 'apis.json'),
  routes: path.join(OUT, 'crawler', 'data', 'routes.json'),
  manifest: path.join(OUT, 'features', 'feature-manifest.json'),
};

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// endpoint::<METHOD>::<originKey>::<pathTemplate>
function parseEndpointFactId(id) {
  const m = /^endpoint::([^:]+)::([^:]+)::(.+)$/.exec(id);
  return m ? { method: m[1].toUpperCase(), originKey: m[2], path: m[3] } : null;
}
// page::<pathTemplate>
function parsePageFactId(id) {
  const m = /^page::(.+)$/.exec(id);
  return m ? m[1] : null;
}

/**
 * Build the per-feature test manifest by joining features.json to the
 * generators' inputs. Returns the manifest object (also written to disk by the
 * CLI path). Pure with respect to its file inputs.
 */
export function buildFeatureManifest() {
  const featuresDoc = readJson(P.features);
  if (!featuresDoc || !Array.isArray(featuresDoc.features)) {
    throw new Error(`no usable features.json at ${path.relative(REPO_ROOT, P.features)} — run \`ctx scan\` first`);
  }
  const gapsDoc = readJson(P.gaps);
  const apisDoc = readJson(P.apis);
  const routesDoc = readJson(P.routes);

  // Index apis.json by "<METHOD> <path>" for O(1) endpoint resolution.
  const apiItems = (apisDoc && (apisDoc.items || apisDoc)) || [];
  const apiIndex = new Map();
  for (const it of apiItems) {
    const pr = it.primary || {};
    if (pr.method && pr.path) apiIndex.set(`${pr.method.toUpperCase()} ${pr.path}`, pr);
  }

  // Index gaps by the fact ID they concern, so we can attach a feature's gaps.
  const gapsByFactId = new Map();
  for (const g of (gapsDoc?.gaps || [])) {
    const fid = g.subject?.factId;
    if (!fid) continue;
    if (!gapsByFactId.has(fid)) gapsByFactId.set(fid, []);
    gapsByFactId.get(fid).push({ gapId: g.gapId, type: g.type, severity: g.severity, priority: g.priority, title: g.title });
  }

  let resolved = 0, unmatched = 0, routeCount = 0;
  const features = featuresDoc.features.map((f) => {
    const members = f.members || {};

    // Endpoints: parse each fact ID, then enrich from apis.json when present.
    const endpoints = (members.endpoints || []).map((fid) => {
      const e = parseEndpointFactId(fid);
      if (!e) return null;
      const pr = apiIndex.get(`${e.method} ${e.path}`);
      if (pr) resolved++; else unmatched++;
      return {
        method: e.method,
        path: e.path,
        origin: pr?.origin || null,
        bearer: !!pr?.observedAuth?.bearer,
        matched: !!pr,          // false = in features/facts but not in apis.json (e.g. code-only/shadow)
        factId: fid,
      };
    }).filter(Boolean);

    // Routes: union of page members + the feature's entrypoints (path templates).
    const routes = [...new Set([
      ...(members.pages || []).map(parsePageFactId).filter(Boolean),
      ...(f.entrypoints || []),
    ])];
    routeCount += routes.length;

    // Gaps: every gap whose subject fact belongs to this feature (any member kind).
    const memberIds = new Set([
      ...(members.endpoints || []), ...(members.pages || []),
      ...(members.interactions || []), ...(members.redirects || []), ...(members.other || []),
    ]);
    const gaps = [];
    for (const id of memberIds) for (const g of (gapsByFactId.get(id) || [])) gaps.push(g);
    gaps.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

    const cov = f.coverage || {};
    return {
      featureId: f.featureId,
      name: f.name,
      signal: f.signal,
      confidence: f.confidence,
      priority: {
        highSeverityGaps: cov.highSeverityGaps ?? 0,
        openGaps: cov.openGaps ?? 0,
        testableEndpoints: cov.testableEndpoints ?? 0,
      },
      endpoints,
      routes,
      gaps,
    };
  });

  // Highest-risk features first: severity, then total gaps, then breadth.
  features.sort((a, b) =>
    (b.priority.highSeverityGaps - a.priority.highSeverityGaps) ||
    (b.priority.openGaps - a.priority.openGaps) ||
    (b.endpoints.length - a.endpoints.length));

  return {
    target: featuresDoc.target || null,
    source: 'output/features/features.json',
    stats: {
      features: features.length,
      endpointsResolved: resolved,
      endpointsUnmatched: unmatched,
      routes: routeCount,
      apisAvailable: apiItems.length,
      routesAvailable: (routesDoc?.endpoints || []).length,
    },
    features,
  };
}

// CLI: write the manifest and print a one-line summary to stderr, JSON to stdout.
function main() {
  const manifest = buildFeatureManifest();
  fs.mkdirSync(path.dirname(P.manifest), { recursive: true });
  fs.writeFileSync(P.manifest, JSON.stringify(manifest, null, 2));
  const s = manifest.stats;
  process.stderr.write(
    `[feature-slice] ${s.features} features · ${s.endpointsResolved} endpoints resolved` +
    `${s.endpointsUnmatched ? ` (${s.endpointsUnmatched} unmatched)` : ''} · ${s.routes} routes` +
    ` → ${path.relative(REPO_ROOT, P.manifest)}\n`);
  process.stdout.write(JSON.stringify({ ok: true, manifest: 'output/features/feature-manifest.json', stats: s }) + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
