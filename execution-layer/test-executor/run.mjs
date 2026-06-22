// Execution Layer — test-executor.
//
// Runs the self-contained API test suite the generation layer wrote and
// normalizes the outcome into a single `results.json`.
//
//   generation-layer (api-test-generator, execute=false)
//       → output/generation/api-tests/{curls/*.sh, _login.sh, config.sh, run-all.sh}
//   execution-layer  (this file)
//       → bash run-all.sh   → parse pass/fail   → output/execution/results.json
//
// The generated `run-all.sh` is already a portable runner: it sources
// `_login.sh` (which sources `config.sh` for BASE_URL/LOGIN_URL and hits
// the login endpoint for a fresh token), loops `curls/*.sh`, and prints a
// `[run-all] passed=N failed=N skipped=N` summary plus one `✓/✗ name → status`
// line per test. We drive it, stream its output live, then parse that output
// into structured results so the orchestrator (and later the report-generator)
// has a machine-readable artifact.
//
// Env:
//   SUITE_DIR          suite to run (default: output/generation/api-tests)
//   EXEC_OUTPUT_DIR    where results.json lands (default: output/execution)
//   LOGIN_EMAIL/_PASSWORD, BASE_URL   forwarded to run-all.sh (login + target)
//   EXEC_KEEP_GOING=1  always exit 0 (don't propagate the suite's failure code)

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const suiteDir = path.resolve(REPO_ROOT, process.env.SUITE_DIR || 'output/generation/api-tests');
const outDir = path.resolve(REPO_ROOT, process.env.EXEC_OUTPUT_DIR || 'output/execution');
const runAll = path.join(suiteDir, 'run-all.sh');

if (!fs.existsSync(runAll)) {
  console.error(
    `test-executor: no runnable suite at ${path.relative(REPO_ROOT, runAll)}\n` +
    `  Generate one first:  testo generate api-tests   (or run the full pipeline: testo pipeline)`
  );
  process.exit(2);
}

console.log('━━━━━━━━━━ test-executor ━━━━━━━━━━');
console.log(`  suite     ${path.relative(REPO_ROOT, suiteDir)}`);
console.log(`  base      ${process.env.BASE_URL ?? '(from config.sh)'}`);
console.log(`  login     ${process.env.LOGIN_EMAIL ? '✓ set' : '(none)'}`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

const t0 = Date.now();
const child = spawn('bash', [runAll], { cwd: suiteDir, env: process.env, stdio: ['inherit', 'pipe', 'pipe'] });

let captured = '';
const tee = (chunk, stream) => { const s = chunk.toString(); captured += s; stream.write(s); };
child.stdout.on('data', (c) => tee(c, process.stdout));
child.stderr.on('data', (c) => tee(c, process.stderr));

child.on('error', (e) => {
  console.error(`test-executor: failed to launch run-all.sh: ${e.message}`);
  process.exit(1);
});

child.on('close', (code) => {
  const durationMs = Date.now() - t0;
  const { totals, tests } = parseRunAllOutput(captured);

  fs.mkdirSync(outDir, { recursive: true });
  const resultsPath = path.join(outDir, 'results.json');
  const results = {
    suite: path.relative(REPO_ROOT, suiteDir),
    ranAt: new Date().toISOString(),
    durationMs,
    exitCode: code ?? 0,
    baseUrl: process.env.BASE_URL ?? null,
    totals,
    tests,
  };
  fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));

  console.log('\n━━━━━━━━━━ execution-layer summary ━━━━━━━━━━');
  console.log(`  passed=${totals.passed}  failed=${totals.failed}  skipped=${totals.skipped}  (of ${totals.total})`);
  console.log(`  results → ${path.relative(REPO_ROOT, resultsPath)}`);
  console.log(`  time    → ${durationMs}ms`);

  if (process.env.EXEC_KEEP_GOING === '1') process.exit(0);
  process.exit(code ?? 0);
});

// ── parse run-all.sh stdout into structured results ─────────────────────────

function parseRunAllOutput(text) {
  const tests = [];
  // Per-test lines:  "  ✓ <name padded> → <status>"  /  "  ✗ <name> → <status>"
  const lineRe = /([✓✗])\s+(\S.*?)\s+→\s+(\S+)/gu;
  let m;
  while ((m = lineRe.exec(text)) !== null) {
    tests.push({ name: m[2].trim(), status: m[3], ok: m[1] === '✓' });
  }

  // Authoritative totals from the summary line the runner prints.
  let totals = { total: tests.length, passed: 0, failed: 0, skipped: 0 };
  const sum = text.match(/\[run-all\]\s+passed=(\d+)\s+failed=(\d+)\s+skipped=(\d+)/);
  if (sum) {
    const passed = +sum[1], failed = +sum[2], skipped = +sum[3];
    totals = { total: passed + failed + skipped, passed, failed, skipped };
  } else {
    totals.passed = tests.filter(t => t.ok).length;
    totals.failed = tests.length - totals.passed;
  }
  return { totals, tests };
}
