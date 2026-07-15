// Context Layer — scan entrypoint.
//
// The CLI hands every "scan" call off to this file. The context layer
// owns the sequence of sub-components that turn raw inputs into
// knowledge-base material.
//
// Live today: content-extractor → indexer → knowledge-synthesizer →
// gap-analyzer → feature-extractor → graph-viewer. As the remaining
// sub-components land (mind-map-builder), they slot into this pipeline:
//
//   inputs
//     ↓
//   content-extractor   ← runs first; produces output/sources/*.json
//     ↓
//   knowledge-synthesizer   ← reconciles same-fact-from-many-sources  (planned)
//     ↓
//   gap-analyzer            ← surface coverage gaps                   (planned)
//     ↓
//   feature-extractor       ← cluster endpoints+pages into features   (planned)
//     ↓
//   mind-map-builder        ← Mermaid / interactive graphs            (planned)
//
// Failure of any one sub-component is logged but does not abort the
// rest (mirrors content-extractor's per-source error handling).

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── pipeline ───────────────────────────────────────────────────────────────

const STAGES = [
  {
    id: 'content-extractor',
    entrypoint: path.join(__dirname, 'content-extractor', 'run.mjs'),
    description: 'Run all auto-discovered source extractors (crawler + graphify + code-extractors)',
  },
  {
    id: 'indexer',
    entrypoint: path.join(__dirname, 'indexer', 'index.mjs'),
    description: 'Synthesise per-topic indices (apis, routes, pages, models, …) from all sources',
  },
  {
    id: 'knowledge-synthesizer',
    entrypoint: path.join(__dirname, 'knowledge-synthesizer', 'synthesize.mjs'),
    description: 'Reconcile exact-key duplicates into one trustworthy CanonicalFact per entity',
  },
  {
    id: 'gap-analyzer',
    entrypoint: path.join(__dirname, 'gap-analyzer', 'analyze.mjs'),
    description: 'Surface + rank coverage holes (shadow / untested / conflict / low-trust) from the facts',
  },
  {
    id: 'feature-extractor',
    entrypoint: path.join(__dirname, 'feature-extractor', 'extract.mjs'),
    description: 'Cluster facts into features (functional areas) and roll up gaps per feature',
  },
  {
    id: 'graph-viewer',
    entrypoint: path.join(__dirname, 'graph-viewer', 'index.mjs'),
    description: 'Render the indexed graphs (click-graph, …) as standalone interactive HTML',
  },
  // The remaining context-layer sub-components are scaffolds today.
  // { id: 'gap-analyzer',     entrypoint: '...', description: '...' },
  // { id: 'mind-map-builder', entrypoint: '...', description: '...' },
];

const t0 = Date.now();
const results = [];

for (const stage of STAGES) {
  console.log(`\n┌─ context-layer ─ ${stage.id} ────────────────────`);
  const startedAt = Date.now();
  try {
    execFileSync('node', [stage.entrypoint], { stdio: 'inherit' });
    results.push({ id: stage.id, ok: true, durationMs: Date.now() - startedAt });
  } catch (e) {
    console.warn(`└─ context-layer: stage ${stage.id} FAILED: ${e.message}`);
    results.push({ id: stage.id, ok: false, error: e.message, durationMs: Date.now() - startedAt });
  }
}

// ── summary ────────────────────────────────────────────────────────────────

console.log('\n━━━━━━━━━━ context-layer summary ━━━━━━━━━━');
for (const r of results) {
  const status = r.ok ? '✓' : '✗';
  const detail = r.ok ? `${r.durationMs}ms` : r.error;
  console.log(`  ${status}  ${r.id.padEnd(24)} ${detail}`);
}
console.log(`\n[context-layer] total time: ${Date.now() - t0}ms`);

const allOk = results.every(r => r.ok);
process.exit(allOk ? 0 : 1);
