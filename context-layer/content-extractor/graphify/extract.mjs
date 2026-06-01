// Graphify source extractor — thin wrapper around scripts/graphify/.
//
// Shells out to the existing graphify tool (LLM-enriched code knowledge
// graph) against TARGET_CODEBASE, then emits a normalized source-bundle
// JSON at output/sources/graphify.json that points at the produced
// graph.json + carries provenance (DiscoveryTier=graph_extracted).
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

import { provenance, DiscoveryTier } from '../../../knowledge-base/schema.mjs';

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
const GRAPHIFY_DIR = path.join(REPO_ROOT, 'scripts', 'graphify');
const AGENTIC_HARNESS_BIN = path.join(REPO_ROOT, 'infrastructure', 'agentic-harness', 'bin', 'call_tool.py');
const GRAPHIFY_OUT = process.env.GRAPHIFY_OUT_DIR
  || path.join(REPO_ROOT, 'output', 'graphify');

// Honour AGENTIC_MODE env var: "direct" (default, fast + reliable) or
// "agent" (LLM picks the tool — useful for testing the agent loop).
const AGENTIC_MODE = (process.env.AGENTIC_MODE ?? 'direct').toLowerCase();
if (!['direct', 'agent'].includes(AGENTIC_MODE)) {
  console.error(`[graphify] AGENTIC_MODE must be "direct" or "agent", got: ${AGENTIC_MODE}`);
  process.exit(2);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const graphPath = path.join(GRAPHIFY_OUT, 'graph.json');
// Snapshot the run's start time so we can later check whether graph.json
// was actually re-written during THIS run. We had a real bug where the
// LLM-agent layer hallucinated a tool call, the tool was never invoked,
// but the wrapper still found a stale graph.json on disk and reported
// "ok=true, 658 nodes" — that 658 was from 24 minutes earlier.
const runStartMs = Date.now();

console.log(`[graphify] invoking via agentic-harness (mode=${AGENTIC_MODE})…`);
let ok = false;
let error = null;
try {
  // Route through the agentic-harness service rather than calling
  // scripts/graphify/tool.py directly. The service owns LLM backend
  // selection + the direct-vs-agent split.
  const argv = [
    AGENTIC_HARNESS_BIN,
    'graphify',
    '--mode', AGENTIC_MODE,
  ];
  if (AGENTIC_MODE === 'direct') {
    argv.push('--path', TARGET_CODEBASE);
  } else {
    // agent mode needs a free-text prompt; the LLM extracts the path.
    argv.push('--prompt', `Run graphify on ${TARGET_CODEBASE}`);
  }
  execFileSync(
    path.join(GRAPHIFY_DIR, '.venv', 'bin', 'python'),
    argv,
    {
      cwd: REPO_ROOT,
      env: { ...process.env, GRAPHIFY_OUT_DIR: GRAPHIFY_OUT },
      stdio: 'inherit',
    },
  );
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
  discoveryTier: DiscoveryTier.GRAPH_EXTRACTED,
  confidence: 0.65,
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
  provenance: provenance({
    sourceId: 'graphify',
    tier: DiscoveryTier.GRAPH_EXTRACTED,
    extractedBy: 'graphify',
  }),
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
