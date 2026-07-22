// One-off driver: re-run ONLY the execute + report stages of an existing,
// completed run, with the safety floor lifted for its mutation scenarios.
//
// It reuses the tests already generated in the run workspace, so there is ZERO
// engine/LLM cost — only the tests' own HTTP calls against the live target. The
// mutation scenarios these unblock are self-contained (create-own-then-delete,
// with cleanup), verified by inspection before this was written. Still: these
// fire real POST/PUT/PATCH/DELETE at the live app. Run only against a target you
// are willing to have written to.
//
//   SAFETY_ALLOWLIST="<ids>" node run-allowlisted-execute.mjs <runId>
//
// Env it honours: LOGIN_EMAIL / LOGIN_PASSWORD (from .env) for auth,
// SESSION_* / TEST_TIMEOUT_MS as usual.

import fs from 'node:fs';
import path from 'node:path';
import { runExecute } from './execution-layer/test-executor/execute.mjs';
import { runReport } from './execution-layer/report-generator/render.mjs';
import { parseAllowlist } from './execution-layer/test-executor/lib/safety-floor.mjs';

const REPO_ROOT = process.cwd();
const runId = process.argv[2];
if (!runId) {
  console.error('usage: SAFETY_ALLOWLIST="<ids>" node run-allowlisted-execute.mjs <runId>');
  process.exit(2);
}

const runDir = path.join(REPO_ROOT, 'output', 'runs', runId);
const run = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'));

const allowlist = parseAllowlist(process.env.SAFETY_ALLOWLIST);
console.log(`\n━━━ re-execute (floor lifted for ${allowlist.size} scenario id(s)) ━━━`);
console.log(`  run     ${runId}`);
console.log(`  target  ${run.target.url}`);
console.log(`  mode    ${run.mode}${run.mode === 'full' ? '  ⚠ MUTATIONS WILL RUN' : ''}`);
console.log(`  floor   lifted for: ${[...allowlist].join(', ')}`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

const result = await runExecute({
  workspace: runDir,
  repoRoot: REPO_ROOT,
  runId,
  mode: run.mode,
  target: { url: run.target.url },
  allowlist,
  log: (m) => console.log('  ' + m),
});

if (!result.ok) {
  console.error(`\n✗ execute failed: ${result.reason}`);
  process.exit(1);
}
console.log(`\n✓ execute: ${JSON.stringify(result.stats)}`);

await runReport({ workspace: runDir, log: (m) => console.log('  ' + m) });
console.log(`\n✓ report → ${path.relative(REPO_ROOT, path.join(runDir, 'report', 'index.html'))}`);
