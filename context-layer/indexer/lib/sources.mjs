// Reads bundles from the three source folders under output/.
//
// Hides the on-disk layout from the topic normalizers — topics ask
// `loadAllSources()` and get back a uniform `LoadedSources` object.

import fs from 'node:fs';
import path from 'node:path';

/**
 * @typedef {Object} LoadedSources
 * @property {Object|null} crawler              - output/crawler/bundle.json
 * @property {Object|null} graphify             - output/graphify/bundle.json
 * @property {Object|null} graphifyGraph        - output/graphify/graph.json (parsed)
 * @property {Object|null} dbSchema             - output/db-schema/bundle.json
 * @property {Object<string, Object>} codeExtractors  - keyed by source id
 * @property {Object|null} frameworkDetection   - output/code-extractors/framework-detection.json
 * @property {string|null} target               - resolved from any bundle that has it
 */


/**
 * Load every source bundle from the canonical output/ layout.
 * Missing files are tolerated — the indexer should still emit topics
 * from whichever sources DID produce output.
 *
 * @param {string} repoRoot - absolute path to the testing-harness repo
 * @returns {LoadedSources}
 */
export function loadAllSources(repoRoot) {
  const out = {
    crawler: null,
    mockData: null,
    openapiSpec: null,
    graphify: null,
    graphifyGraph: null,
    dbSchema: null,
    codeExtractors: {},
    frameworkDetection: null,
    target: null,
  };

  // crawler — the deterministic heuristic crawler's bundle.
  out.crawler = _safeReadJson(path.join(repoRoot, 'output', 'crawler', 'bundle.json'));
  if (out.crawler?.target) out.target ??= out.crawler.target;

  // mock-data — real request/response samples distilled from the crawler.
  out.mockData = _safeReadJson(path.join(repoRoot, 'output', 'mock-data', 'bundle.json'));
  if (out.mockData?.target) out.target ??= out.mockData.target;

  // openapi-spec — live-served OpenAPI/Swagger spec (parsed + $refs resolved).
  out.openapiSpec = _safeReadJson(path.join(repoRoot, 'output', 'openapi-probe', 'bundle.json'));
  if (out.openapiSpec?.target) out.target ??= out.openapiSpec.target;

  // graphify — both the bundle (small) and the actual graph (big)
  out.graphify = _safeReadJson(path.join(repoRoot, 'output', 'graphify', 'bundle.json'));
  if (out.graphify?.target) out.target ??= out.graphify.target;
  const graphPath = path.join(repoRoot, 'output', 'graphify', 'graph.json');
  out.graphifyGraph = _safeReadJson(graphPath);

  // db-schema — single merged bundle produced by the db-schema orchestrator.
  out.dbSchema = _safeReadJson(path.join(repoRoot, 'output', 'db-schema', 'bundle.json'));
  if (out.dbSchema?.target) out.target ??= out.dbSchema.target;

  // code-extractors — every JSON in the folder, keyed by source id
  const codeDir = path.join(repoRoot, 'output', 'code-extractors');
  if (fs.existsSync(codeDir)) {
    for (const file of fs.readdirSync(codeDir)) {
      if (!file.endsWith('.json')) continue;
      const bundle = _safeReadJson(path.join(codeDir, file));
      if (!bundle) continue;
      const id = bundle.sourceId ?? file.replace(/\.json$/, '');
      if (id === 'framework-detection') {
        out.frameworkDetection = bundle;
      } else {
        out.codeExtractors[id] = bundle;
      }
      if (bundle.target) out.target ??= bundle.target;
    }
  }

  return out;
}


// ── helpers ───────────────────────────────────────────────────────────────

function _safeReadJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    console.warn(`[indexer] failed to read ${filePath}: ${e.message}`);
    return null;
  }
}
