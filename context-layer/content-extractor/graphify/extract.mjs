// Graphify source extractor — thin wrapper around the `graphifyy` pip tool.
//
// Invokes graphify DIRECTLY (deterministic AST extraction + clustering +
// report; "no LLM needed") against TARGET_CODEBASE, then emits a normalized
// source-bundle JSON at output/graphify/bundle.json that points at the
// produced graph.json. The LLM-semantic labeling pass is intentionally not
// wired (no Python host-routing yet) — `graphify update` is LLM-free.
//
// The hand-rolled deterministic Python AST extractor (python-ast/) is a
// SEPARATE auto-discovered source now — this wrapper no longer runs it.
//
// Env vars:
//   TARGET_CODEBASE    absolute path of the source repo (required)
//   GRAPHIFY_OUT_DIR   forwarded to graphify (defaults to output/graphify)

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const TARGET_CODEBASE = process.env.TARGET_CODEBASE;
if (!TARGET_CODEBASE) {
  console.error('[graphify] TARGET_CODEBASE env var is required');
  process.exit(2);
}
if (!fs.existsSync(TARGET_CODEBASE)) {
  console.error(`[graphify] target does not exist: ${TARGET_CODEBASE}`);
  process.exit(2);
}

// Bundle lives next to the rest of graphify's artifacts (graph.json,
// GRAPH_TREE.html, etc.) so all graphify-produced output is in one
// folder for the indexer + downstream consumers to read from.
const OUT_DIR = path.join(REPO_ROOT, 'output', 'graphify');
const PY = path.join(REPO_ROOT, 'context-layer', 'content-extractor', '_lib', '.venv', 'bin', 'python');
// GRAPHIFY_OUT (absolute) makes the tool write graph.json/report/html here
// directly — no tmp-shuffle needed.
const GRAPHIFY_OUT = process.env.GRAPHIFY_OUT_DIR
  || path.join(REPO_ROOT, 'output', 'graphify');

fs.mkdirSync(OUT_DIR, { recursive: true });

const graphPath = path.join(GRAPHIFY_OUT, 'graph.json');
// Snapshot the run's start time so we can later check whether graph.json
// was actually re-written during THIS run. A stale file on disk must not
// be reported as a fresh, successful extraction.
const runStartMs = Date.now();

console.log('[graphify] invoking graphify directly (deterministic update + tree)…');
let ok = false;
let error = null;
try {
  const spawnOpts = {
    // cwd=output/ so the tool's cwd-relative strays (graphify-out/manifest.json,
    // .graphify_root) land inside the gitignored output/ folder.
    cwd: path.join(REPO_ROOT, 'output'),
    env: { ...process.env, GRAPHIFY_OUT, GRAPHIFY_NO_TIPS: '1' },
    stdio: 'inherit',
  };
  // `update` = full deterministic pass: AST extract + build + cluster +
  // GRAPH_REPORT.md + graph.json + graph.html. --force bypasses the
  // fewer-nodes regression guard (output/ is wiped each run anyway).
  execFileSync(PY, ['-m', 'graphify', 'update', TARGET_CODEBASE, '--force'], spawnOpts);
  execFileSync(PY, ['-m', 'graphify', 'tree',
    '--graph', graphPath,
    '--output', path.join(GRAPHIFY_OUT, 'GRAPH_TREE.html'),
    '--root', TARGET_CODEBASE,
  ], spawnOpts);
  ok = true;
} catch (e) {
  error = e.message;
  console.warn(`[graphify] failed: ${e.message}`);
}

// Freshness guard: graph.json must exist AND its mtime must be newer
// than the run's start time. A stale file is treated as a failed run.
let graph = null;
let stale = false;
if (fs.existsSync(graphPath)) {
  const mtimeMs = fs.statSync(graphPath).mtimeMs;
  // Allow a small skew (1s) for filesystems that round mtime.
  if (mtimeMs + 1000 < runStartMs) {
    stale = true;
    ok = false;
    error = error
      ?? `graph.json is stale (mtime=${new Date(mtimeMs).toISOString()}, ` +
         `run started ${new Date(runStartMs).toISOString()}). ` +
         `graphify likely did not run; check the log above for tool errors.`;
    console.warn(`[graphify] WARNING: graph.json is stale — ignoring.`);
  } else if (ok) {
    graph = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
  }
}

// Be honest about "0 edges" in the stats. NetworkX node-link JSON keeps
// edges under "links"; older graphify versions used "edges". Check both.
const edgesArr = graph?.links ?? graph?.edges ?? [];
const bundle = {
  sourceId: 'graphify',
  extractedAt: new Date().toISOString(),
  extractedBy: 'context-layer/content-extractor/graphify/extract.mjs',
  target: TARGET_CODEBASE,
  ok,
  stale,
  error,
  graphPath: path.relative(REPO_ROOT, graphPath),
  stats: graph ? {
    nodes: graph.nodes?.length ?? 0,
    edges: edgesArr.length,
    hyperedges: graph.hyperedges?.length ?? 0,
  } : null,
};

const outFile = path.join(OUT_DIR, 'bundle.json');
fs.writeFileSync(outFile, JSON.stringify(bundle, null, 2));
console.log(`[graphify] wrote ${path.relative(REPO_ROOT, outFile)}`);
if (bundle.stats) {
  console.log(`[graphify] stats: ${JSON.stringify(bundle.stats)}`);
}
if (!ok) {
  console.error(`[graphify] FAILED — bundle.error: ${error}`);
  process.exit(1);
}
