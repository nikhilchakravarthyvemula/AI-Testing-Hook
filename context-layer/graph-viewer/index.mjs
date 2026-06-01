// graph-viewer — render the indexed graphs as standalone interactive HTML.
//
// Reads from output/indexed_output/ and writes self-contained .html files
// to output/indexed_output/graphs/ — open with `open <file>`, no server,
// no build step.
//
// Today: renders click-graph.json (pages × intents × APIs).
// Easy to extend: add a shaper under lib/shapers/ and register it in
// SHAPERS below. The render-html template is graph-agnostic.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderToFile } from './lib/render-html.mjs';

// Per-graph shapers — each knows where its source JSON lives and what
// output filename to use. Adding a new graph type means adding a row
// here + a shaper module.
import * as clickGraphShaper from './lib/shapers/click-graph.mjs';
import * as uiRoutesShaper   from './lib/shapers/ui-routes.mjs';

const SHAPERS = [
  clickGraphShaper,
  uiRoutesShaper,
];


// ── runner ────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.join(REPO_ROOT, 'output', 'indexed_output', 'graphs');

const t0 = Date.now();
console.log('[graph-viewer] rendering graphs from output/indexed_output/…');

const summaries = [];

for (const shaper of SHAPERS) {
  const sourcePath = path.join(REPO_ROOT, shaper.sourceFile);
  if (!fs.existsSync(sourcePath)) {
    console.warn(`[graph-viewer] skipping ${shaper.outputFile}: source missing at ${shaper.sourceFile}`);
    summaries.push({ outputFile: shaper.outputFile, skipped: 'source missing' });
    continue;
  }

  let bundle;
  try {
    bundle = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
  } catch (e) {
    console.warn(`[graph-viewer] skipping ${shaper.outputFile}: bad JSON (${e.message})`);
    summaries.push({ outputFile: shaper.outputFile, skipped: `bad JSON: ${e.message}` });
    continue;
  }

  const { nodes, edges, meta } = shaper.shape(bundle);
  if (meta.empty) {
    console.warn(`[graph-viewer] ${shaper.outputFile}: empty (${meta.reason}) — skipping render`);
    summaries.push({ outputFile: shaper.outputFile, skipped: meta.reason ?? 'empty' });
    continue;
  }

  const outputPath = path.join(OUT_DIR, shaper.outputFile);
  const { bytes } = renderToFile({ nodes, edges, meta, outputPath });

  console.log(
    `[graph-viewer] ${shaper.outputFile.padEnd(20)} ` +
    `nodes=${String(nodes.length).padStart(4)}  edges=${String(edges.length).padStart(4)}  ` +
    `${(bytes / 1024).toFixed(1)} KB  → ${path.relative(REPO_ROOT, outputPath)}`
  );
  summaries.push({
    outputFile: shaper.outputFile,
    nodes: nodes.length, edges: edges.length, bytes,
    sourceFile: shaper.sourceFile,
  });
}

// Write a tiny index alongside the HTMLs so consumers can discover them.
const indexJson = path.join(OUT_DIR, 'graphs-index.json');
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(indexJson, JSON.stringify({
  generatedAt: new Date().toISOString(),
  graphs: summaries,
}, null, 2));

console.log(`\n[graph-viewer] wrote ${path.relative(REPO_ROOT, indexJson)}`);
console.log(`[graph-viewer] total: ${Date.now() - t0}ms`);
