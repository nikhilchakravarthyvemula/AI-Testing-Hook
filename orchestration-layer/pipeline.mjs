// Orchestration Layer — the end-to-end pipeline.
//
// This is the orchestrator that wraps the three working layers into a single
// run. It mirrors context-layer/scan.mjs's STAGES pattern, but one level up —
// instead of sequencing sub-components inside one layer, it sequences the
// layers themselves:
//
//   inputs (--url / --codebase / creds)
//     ↓
//   scan      → context-layer/scan.mjs            (crawl + extract + index)
//     ↓
//   generate  → generation-layer/api-test-generator  (execute=false: write the suite)
//     ↓
//   execute   → execution-layer/test-executor/run.mjs (run the suite, normalize results)
//
// Each stage runs in its own child process. A stage failure stops the pipeline
// unless ORCH_CONTINUE=1. Per-stage timing + a machine-readable run artifact
// (output/orchestration/run-<ts>.json) are written so the report-generator and
// the web UI can show pipeline history.
//
// Config (env, set by the CLI front door interfaces/cli/commands/pipeline.mjs):
//   BASE_URL          live target to crawl + test
//   TARGET_CODEBASE   local repo to analyse
//   LOGIN_EMAIL/_PASSWORD   forwarded to scan (crawler login) + execute (token)
//   ORCH_STAGES       csv subset of scan,generate,execute (default: all three)
//   ORCH_EXECUTE      '0' to skip the execute stage (alias for dropping it)
//   ORCH_MAX_TESTS    cap APIs the generator turns into tests
//   ORCH_CONTINUE     '1' to keep going after a stage fails

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const GRAPHIFY_PYTHON = path.join(REPO_ROOT, 'scripts', 'graphify', '.venv', 'bin', 'python');
const CALL_SKILL_PY = path.join(REPO_ROOT, 'infrastructure', 'skill-register', 'bin', 'call_skill.py');

// ── config ─────────────────────────────────────────────────────────────────

const cfg = {
  url: process.env.BASE_URL || '',
  codebase: process.env.TARGET_CODEBASE || '',
  maxTests: process.env.ORCH_MAX_TESTS || '',
  execute: process.env.ORCH_EXECUTE !== '0',
  continueOnError: process.env.ORCH_CONTINUE === '1',
  stages: (process.env.ORCH_STAGES || 'scan,generate,execute')
    .split(',').map(s => s.trim()).filter(Boolean),
};

// ── stage registry ─────────────────────────────────────────────────────────

const STAGES = {
  scan: {
    label: 'scan · context-layer',
    cmd: 'node',
    args: [path.join(REPO_ROOT, 'context-layer', 'scan.mjs')],
    // The crawler/extractors gate themselves on BASE_URL / TARGET_CODEBASE,
    // so there's nothing to scan if neither is set.
    skip: () => (!cfg.url && !cfg.codebase) && 'no --url or --codebase given',
  },
  generate: {
    label: 'generate · generation-layer (api-tests)',
    cmd: GRAPHIFY_PYTHON,
    args: () => {
      const a = [CALL_SKILL_PY, 'api-test-generator', '--mode', 'direct', '--execute', 'false'];
      if (cfg.url) a.push('--base_url', cfg.url);
      if (cfg.maxTests) a.push('--max_tests', cfg.maxTests);
      return a;
    },
    preflight: () =>
      (!fs.existsSync(GRAPHIFY_PYTHON) && `graphify venv missing at ${rel(GRAPHIFY_PYTHON)}`) ||
      (!fs.existsSync(CALL_SKILL_PY) && `skill-register CLI missing at ${rel(CALL_SKILL_PY)}`),
  },
  execute: {
    label: 'execute · execution-layer (test-executor)',
    cmd: 'node',
    args: [path.join(REPO_ROOT, 'execution-layer', 'test-executor', 'run.mjs')],
    skip: () => !cfg.execute && 'execute stage disabled (--no-execute)',
  },
};

// ── run ────────────────────────────────────────────────────────────────────

const t0 = Date.now();
const results = [];

console.log('━━━━━━━━━━ testo pipeline (orchestration-layer) ━━━━━━━━━━');
console.log(`  url        ${cfg.url || '(none)'}`);
console.log(`  codebase   ${cfg.codebase || '(none)'}`);
console.log(`  stages     ${cfg.stages.join(' → ')}`);
console.log(`  execute    ${cfg.execute ? 'yes' : 'no'}`);
console.log(`  on-error   ${cfg.continueOnError ? 'continue' : 'stop'}`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

let aborted = false;

for (const id of cfg.stages) {
  const stage = STAGES[id];
  if (!stage) {
    console.warn(`[orchestrator] unknown stage "${id}" — skipping`);
    results.push({ id, ok: false, skipped: true, reason: 'unknown stage', durationMs: 0 });
    continue;
  }

  const skipReason = stage.skip?.();
  if (skipReason) {
    console.log(`\n┌─ orchestration-layer ─ ${id} ─ SKIPPED (${skipReason})`);
    results.push({ id, ok: true, skipped: true, reason: skipReason, durationMs: 0 });
    continue;
  }

  const preflightErr = stage.preflight?.();
  if (preflightErr) {
    console.error(`\n┌─ orchestration-layer ─ ${id} ─ BLOCKED: ${preflightErr}`);
    results.push({ id, ok: false, skipped: false, error: preflightErr, durationMs: 0 });
    if (!cfg.continueOnError) { aborted = true; break; }
    continue;
  }

  console.log(`\n┌─ orchestration-layer ─ ${id} ────────────────────`);
  const startedAt = Date.now();
  const code = await runChild(stage.cmd, resolveArgs(stage.args));
  const durationMs = Date.now() - startedAt;
  const ok = code === 0;
  results.push({ id, ok, skipped: false, exitCode: code, durationMs });
  console.log(`└─ ${ok ? '✓' : '✗'} ${id} (exit ${code}, ${durationMs}ms)`);

  if (!ok && !cfg.continueOnError) { aborted = true; break; }
}

// ── summary + artifact ───────────────────────────────────────────────────────

const totalMs = Date.now() - t0;
console.log('\n━━━━━━━━━━ pipeline summary ━━━━━━━━━━');
for (const r of results) {
  const status = r.skipped ? '–' : (r.ok ? '✓' : '✗');
  const detail = r.skipped ? `skipped (${r.reason})` : (r.ok ? `${r.durationMs}ms` : (r.error || `exit ${r.exitCode}`));
  console.log(`  ${status}  ${r.id.padEnd(10)} ${detail}`);
}
if (aborted) console.log('  (pipeline stopped early — a stage failed; pass --continue-on-error to push through)');
console.log(`\n[orchestrator] total time: ${totalMs}ms`);

const ranStages = results.filter(r => !r.skipped);
const allOk = ranStages.every(r => r.ok);

const artifactDir = path.join(REPO_ROOT, 'output', 'orchestration');
fs.mkdirSync(artifactDir, { recursive: true });
const ranAt = new Date().toISOString();
const artifactPath = path.join(artifactDir, `run-${ranAt.replace(/[:.]/g, '-')}.json`);
fs.writeFileSync(artifactPath, JSON.stringify({
  ranAt, totalMs, ok: allOk, aborted,
  config: { url: cfg.url || null, codebase: cfg.codebase || null, stages: cfg.stages, execute: cfg.execute },
  stages: results,
}, null, 2));
console.log(`[orchestrator] run artifact → ${rel(artifactPath)}`);

process.exit(allOk ? 0 : 1);

// ── helpers ──────────────────────────────────────────────────────────────────

function resolveArgs(args) { return typeof args === 'function' ? args() : args; }
function rel(p) { return path.relative(REPO_ROOT, p); }

function runChild(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: process.env, stdio: 'inherit' });
    child.on('error', (e) => { console.error(`[orchestrator] spawn error: ${e.message}`); resolve(1); });
    child.on('exit', (code) => resolve(code ?? 0));
  });
}
