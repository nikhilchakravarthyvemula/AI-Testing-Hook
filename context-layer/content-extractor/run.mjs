// Content Extractor — the wrapper.
//
// Pipeline runs in dependency stages, with sources INSIDE each stage
// running in parallel. The longest-running source (crawler) sets the
// stage-1 wall-clock — graphify, db-schema, and framework-detector
// finish "for free" alongside it.
//
//   Stage 1 (parallel, independent inputs):
//     framework-detector   needs codebase only      → ~1s
//     crawler               needs target URL         → ~5-10 min (LLM intent-extract)
//     graphify              needs codebase only      → ~30-60s
//     db-schema             needs codebase only      → ~30s deterministic (+ LLM if DBSCHEMA_LLM=1)
//
//   Stage 2 (parallel, after crawler):
//     mock-data   reads crawler bundle     → ~1s
//     openapi-probe     uses observed origins    → ~1s
//
//   Stage 3 (parallel, after framework-detector):
//     code-extractors/<name>   only those framework-detector recommended
//                              (each ~300-400ms, run concurrently)
//
// Toggles:
//   ONLY=python-fastapi,nextjs-app       run only these code-extractors
//   SKIP=crawler,graphify                skip these sources entirely
//   TARGET_CODEBASE=/abs/path            enables graphify + framework-detector + db-schema + code-extractors
//   SKIP_FRAMEWORK_DETECTION=1           force-run ALL code-extractors regardless of detection
//   PARALLEL=0                           force serial execution (debugging / single-thread machines)
//   MAX_PARALLEL=N                       cap concurrent subprocesses (default: stage-defined)
//
// Failure of any source is logged but doesn't abort other sources in the
// same stage. Downstream stages still run with whatever sources succeeded.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const VENV_PY = path.join(__dirname, '_lib', '.venv', 'bin', 'python');

// Stages — explicit dependency graph. Each stage runs in parallel.
const STAGES = [
  {
    name: 'stage 1 — independent primary sources',
    primary: ['framework-detector', 'crawler', 'graphify'],
  },
  {
    name: 'stage 2 — depends on crawler',
    primary: ['mock-data', 'openapi-probe'],
  },
  {
    name: 'stage 3 — code-extractors (depend on framework-detector)',
    // Includes db-schema, which now lives under code-extractors/ and is
    // recommended by framework detection (catalog wildcard `*any`).
    codeExtractors: true,
  },
];

// Gates apply to PRIMARY sources only. Code-extractors (incl. db-schema) are
// gated on TARGET_CODEBASE collectively by the stage-3 guard in _decideCodeExtractors.
const GATES = {
  crawler:              null,
  'mock-data':          null,
  'openapi-probe':      null,
  graphify:             'TARGET_CODEBASE',
  'framework-detector': 'TARGET_CODEBASE',
};

const ONLY = (process.env.ONLY ?? '').split(',').filter(Boolean);
const SKIP = (process.env.SKIP ?? '').split(',').filter(Boolean);
const SKIP_FRAMEWORK_DETECTION = (process.env.SKIP_FRAMEWORK_DETECTION ?? '0') === '1';
const PARALLEL = (process.env.PARALLEL ?? '1') !== '0';
const MAX_PARALLEL = Math.max(1, parseInt(process.env.MAX_PARALLEL ?? '8', 10) || 8);


// ── discovery ──────────────────────────────────────────────────────────────


/** @typedef {{id:string, kind:'primary'|'code-extractor', entrypoint:string, runtime:'node'|'python'}} Source */

/** @returns {Source[]} */
function discoverSources() {
  /** @type {Source[]} */
  const out = [];

  // Top-level folders (one source per folder).
  for (const entry of fs.readdirSync(__dirname, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
    if (entry.name === 'code-extractors') continue;   // handled below

    const dir = path.join(__dirname, entry.name);
    const node = path.join(dir, 'extract.mjs');
    const py = path.join(dir, 'extract.py');
    if (fs.existsSync(node)) out.push({ id: entry.name, kind: 'primary', entrypoint: node, runtime: 'node' });
    else if (fs.existsSync(py)) out.push({ id: entry.name, kind: 'primary', entrypoint: py, runtime: 'python' });
  }

  // Nested code-extractors.
  const codeDir = path.join(__dirname, 'code-extractors');
  if (fs.existsSync(codeDir)) {
    for (const entry of fs.readdirSync(codeDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
      if (entry.name === 'code_extractors') continue;

      const py = path.join(codeDir, entry.name, 'extract.py');
      if (fs.existsSync(py)) out.push({ id: entry.name, kind: 'code-extractor', entrypoint: py, runtime: 'python' });
    }
  }
  return out;
}


function readRecommendedExtractors() {
  const detection = path.join(REPO_ROOT, 'output', 'framework-detector', 'framework-detection.json');
  if (!fs.existsSync(detection)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(detection, 'utf8'));
    if (Array.isArray(data.recommendedExtractors)) return new Set(data.recommendedExtractors);
  } catch { /* ignore */ }
  return null;
}


// ── orchestrator ───────────────────────────────────────────────────────────


const SOURCES = discoverSources();
// spec-16: the crawler moved to the `testo` package (testo/src/crawler), so
// auto-discovery under content-extractor/ no longer finds it. Register it
// explicitly at its new location until the orchestration is fully split
// (testo crawls on the device, this orchestrator runs the extractors).
const TESTO_CRAWLER = path.resolve(__dirname, '..', '..', 'testo', 'src', 'crawler', 'extract.mjs');
if (!SOURCES.some(s => s.id === 'crawler') && fs.existsSync(TESTO_CRAWLER)) {
  SOURCES.push({ id: 'crawler', kind: 'primary', entrypoint: TESTO_CRAWLER, runtime: 'node' });
}
if (SOURCES.length === 0) {
  console.warn('[content-extractor] no extractors discovered under', __dirname);
  process.exit(0);
}
const SOURCES_BY_ID = new Map(SOURCES.map(s => [s.id, s]));
const RUNS = [];   // result records, populated by runSource

// ── wipe stale extractor outputs ────────────────────────────────────────
//
// Each run is a fresh session: outputs from extractors that DON'T run
// this time must not linger on disk, or the downstream indexer will
// merge them with the current session's data (e.g. yesterday's logtrim
// graphify bundle bleeding into today's console-preview crawl).
//
// Wipe rules:
//   - DELETE the bundle dirs of every primary + code-extractor BEFORE
//     deciding what runs. Extractors that DO run write fresh data.
//     Extractors that get skipped leave the dir empty/absent → indexer
//     correctly sees them as "not in this session."
//   - DO NOT wipe `output/crawler/` — the crawler self-manages its own
//     wipe with auth-state.json preservation. Wiping it here would lose
//     the saved SSO session.
//   - DO NOT wipe `output/indexed_output/` — the indexer overwrites all
//     its topic files each run; leftover files are harmless.
//   - DO NOT wipe `output/content-extraction-index.json` — overwritten
//     at the end of this run.
//   - SKIP_WIPE=1 opts out (for debugging cross-run diffs).
const WIPE_DIRS = [
  'output/mock-data',
  'output/openapi-probe',
  'output/graphify',
  'output/graphify_graph',
  'output/db-schema',
  'output/code-extractors',
  'output/framework-detector',
];
const WIPE_FILES = [];
if ((process.env.SKIP_WIPE ?? '0') !== '1') {
  let wiped = 0;
  for (const rel of WIPE_DIRS) {
    const abs = path.join(REPO_ROOT, rel);
    if (fs.existsSync(abs)) { fs.rmSync(abs, { recursive: true, force: true }); wiped++; }
  }
  for (const rel of WIPE_FILES) {
    const abs = path.join(REPO_ROOT, rel);
    if (fs.existsSync(abs)) { fs.rmSync(abs, { force: true }); wiped++; }
  }
  if (wiped) console.log(`[content-extractor] cleared ${wiped} stale output path(s) — fresh session`);
}

const t0 = Date.now();
console.log(`[content-extractor] mode=${PARALLEL ? `parallel (max ${MAX_PARALLEL})` : 'serial'}`);


for (const stage of STAGES) {
  let sources;
  if (stage.codeExtractors) {
    sources = _decideCodeExtractors();
  } else {
    sources = (stage.primary || []).map(id => SOURCES_BY_ID.get(id)).filter(Boolean);
  }
  if (sources.length === 0) continue;

  console.log(`\n[content-extractor] ━━━━ ${stage.name} ━━━━`);
  console.log(`[content-extractor] sources: ${sources.map(s => s.id).join(', ')}`);

  const stageT0 = Date.now();
  await _runStage(sources);
  console.log(`[content-extractor] ↳ stage done in ${Date.now() - stageT0}ms`);
}


// ── stage runner ───────────────────────────────────────────────────────────


async function _runStage(sources) {
  if (!PARALLEL) {
    for (const src of sources) await runSource(src);
    return;
  }
  // Throttled fan-out so MAX_PARALLEL is respected.
  const pending = [...sources];
  const running = new Set();
  while (pending.length || running.size) {
    while (pending.length && running.size < MAX_PARALLEL) {
      const src = pending.shift();
      const p = runSource(src).finally(() => running.delete(p));
      running.add(p);
    }
    if (running.size) await Promise.race(running);
  }
}


function _decideCodeExtractors() {
  const all = SOURCES.filter(s => s.kind === 'code-extractor');

  // Code-extractors parse a *codebase*. With no TARGET_CODEBASE there is
  // nothing for them to read, so skip the entire stage. This also makes a
  // stale output/framework-detector/framework-detection.json (left behind by a
  // prior, codebase-backed run) harmless: without this guard it would
  // "recommend" extractors for a target that has no code, which then run
  // against nothing (empty output) or error outright (e.g. python-ast exit 2).
  if (!process.env.TARGET_CODEBASE) {
    for (const src of all) {
      RUNS.push({ id: src.id, kind: src.kind, skipped: 'TARGET_CODEBASE env var not set' });
    }
    if (all.length) {
      console.log(`[content-extractor] ○ code-extractors  (skipped ${all.length}: TARGET_CODEBASE not set)`);
    }
    return [];
  }

  let recommended = ONLY.length ? new Set(ONLY) : null;
  if (!recommended && !SKIP_FRAMEWORK_DETECTION) {
    recommended = readRecommendedExtractors();
    if (recommended) {
      console.log(
        `\n[content-extractor] framework-detector recommended ` +
        `${recommended.size}/${all.length} code-extractors: ${[...recommended].join(', ')}`
      );
    }
  }
  const out = [];
  for (const src of all) {
    if (ONLY.length && !ONLY.includes(src.id)) {
      RUNS.push({ id: src.id, kind: src.kind, skipped: 'not in ONLY env' });
      continue;
    }
    if (recommended && !ONLY.length && !recommended.has(src.id)) {
      RUNS.push({ id: src.id, kind: src.kind, skipped: 'not recommended by framework detection' });
      continue;
    }
    out.push(src);
  }
  return out;
}


// ── per-source runner (async, line-prefixed output) ────────────────────────


async function runSource(src) {
  if (SKIP.includes(src.id)) {
    RUNS.push({ id: src.id, kind: src.kind, skipped: 'SKIP env' });
    console.log(`[content-extractor] ○ ${src.id}  (skipped: SKIP env)`);
    return;
  }
  if (ONLY.length && src.kind === 'code-extractor' && !ONLY.includes(src.id)) {
    RUNS.push({ id: src.id, kind: src.kind, skipped: 'not in ONLY env' });
    return;
  }
  const gate = GATES[src.id];
  if (gate && !process.env[gate]) {
    RUNS.push({ id: src.id, kind: src.kind, skipped: `${gate} env var not set` });
    console.log(`[content-extractor] ○ ${src.id}  (skipped: ${gate} not set)`);
    return;
  }

  const startedAt = Date.now();
  console.log(`[content-extractor] → ${src.id}  (start)`);
  const cmd = src.runtime === 'node'
    ? { exe: 'node', args: [src.entrypoint] }
    : { exe: fs.existsSync(VENV_PY) ? VENV_PY : 'python3', args: [src.entrypoint] };

  return new Promise((resolve) => {
    const proc = spawn(cmd.exe, cmd.args, { stdio: ['ignore', 'pipe', 'pipe'] });

    // Stream stdout + stderr line-by-line, prefixed with the source id when
    // running in parallel (so interleaved lines are still attributable).
    // In serial mode the existing extractors' own `[crawler]/[graphify]/…`
    // prefixes are enough — skip our extra prefix to keep output identical.
    const tag = PARALLEL ? `[${src.id}] ` : '';
    _pipeWithPrefix(proc.stdout, process.stdout, tag);
    _pipeWithPrefix(proc.stderr, process.stderr, tag);

    proc.on('error', err => {
      console.warn(`[content-extractor] ✗ ${src.id} spawn error: ${err.message}`);
      RUNS.push({ id: src.id, kind: src.kind, ok: false, error: err.message, durationMs: Date.now() - startedAt });
      resolve();
    });
    proc.on('exit', code => {
      const durationMs = Date.now() - startedAt;
      if (code === 0) {
        console.log(`[content-extractor] ✓ ${src.id}  (${durationMs}ms)`);
        RUNS.push({ id: src.id, kind: src.kind, ok: true, durationMs });
      } else {
        console.warn(`[content-extractor] ✗ ${src.id} exited ${code} after ${durationMs}ms`);
        RUNS.push({ id: src.id, kind: src.kind, ok: false, error: `exit ${code}`, durationMs });
      }
      resolve();
    });
  });
}


function _pipeWithPrefix(srcStream, destStream, prefix) {
  if (!prefix) { srcStream.pipe(destStream); return; }
  const rl = readline.createInterface({ input: srcStream, terminal: false });
  rl.on('line', line => destStream.write(prefix + line + '\n'));
}


// ── write index summary ────────────────────────────────────────────────────


const totalMs = Date.now() - t0;
const indexPath = path.join(REPO_ROOT, 'output', 'content-extraction-index.json');
fs.mkdirSync(path.dirname(indexPath), { recursive: true });
fs.writeFileSync(indexPath, JSON.stringify({
  generatedAt: new Date().toISOString(),
  mode: PARALLEL ? 'parallel' : 'serial',
  maxParallel: PARALLEL ? MAX_PARALLEL : 1,
  durationMs: totalMs,
  target: process.env.TARGET_CODEBASE ?? null,
  discovered: SOURCES.map(s => ({ id: s.id, kind: s.kind })),
  sources: RUNS,
  stages: STAGES.map(s => ({ name: s.name, sources: s.primary || (s.codeExtractors ? '<code-extractors>' : []) })),
  outputDir: 'output/sources/',
}, null, 2));

console.log('\n[content-extractor] ━━━━━━━━━━━ summary ━━━━━━━━━━━');
for (const r of RUNS) {
  const status = r.ok ? '✓' : (r.skipped ? '○' : '✗');
  const tag = r.kind === 'code-extractor' ? '(code-extractor)' : '(primary)';
  const detail = r.ok ? `${r.durationMs}ms` : (r.skipped || r.error);
  console.log(`  ${status}  ${r.id.padEnd(22)} ${tag.padEnd(18)} ${detail}`);
}
console.log(`\n[content-extractor] wrote ${path.relative(REPO_ROOT, indexPath)}`);
console.log(`[content-extractor] total time: ${totalMs}ms (${(totalMs/1000).toFixed(1)}s)`);
