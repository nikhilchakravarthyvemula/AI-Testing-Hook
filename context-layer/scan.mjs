// Context Layer — scan entrypoint.
//
// The CLI hands every "scan" call off to this file. The context layer
// owns the sequence of sub-components that turn raw inputs into
// knowledge-base material.
//
// Today only the content-extractor exists. As the other sub-components
// land (gap-analyzer, knowledge-synthesizer, feature-extractor,
// mind-map-builder), this file becomes a small pipeline orchestrator:
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
