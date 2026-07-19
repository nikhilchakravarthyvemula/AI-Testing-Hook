// testo run — the product entrypoint.
//
// One command takes a target from nothing to a final report:
//
//   acquire → understand → store → plan → CHECKPOINT → generate → execute → report
//
// `testo scan` and run-pipeline.sh remain the dev tools for driving individual
// stages. `testo run` is the thing you point at an app when you want the
// deliverable — an auditable report of what was tested, what wasn't, and why.
//
// The spine holds no intelligence: no LLM calls, no test logic, no report
// rendering. It owns the workspace, the stage sequence, the run record, and the
// one human gate. See docs/specs/p0-01-run-spine.spec.md.
//
// Today store/plan/generate/execute/report fail as "not implemented" — each
// lands with its own spec (p0-03 … p0-08) and replaces its placeholder. A run
// today gets you a real crawl, a real understanding, and an honest stop.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createWorkspace, openWorkspace, workspacePaths, finalizeRun, readRun,
} from '../_lib/spine/workspace.mjs';
import { runStages } from '../_lib/spine/stages.mjs';
import { defaultIo } from '../_lib/spine/checkpoint.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const MODES = new Set(['safe', 'full']);
const ENGINES = new Set(['claude', 'mock']);

// ── args ───────────────────────────────────────────────────────────────────

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  printHelp();
  process.exit(0);
}

// ── resolve the run ────────────────────────────────────────────────────────

let ws;
try {
  ws = opts.resume ? resumeRun(opts) : startRun(opts);
} catch (e) {
  console.error(`testo run: ${e.message}`);
  process.exit(2);
}

const io = {
  out: (msg) => console.log(msg),
  checkpointIo: defaultIo(),
};

printBanner(ws.run, opts);

// ── go ─────────────────────────────────────────────────────────────────────

const ctx = {
  repoRoot: REPO_ROOT,
  dir: ws.dir,
  paths: ws.paths,
  run: ws.run,
  opts,
  io,
};

const result = await runStages(ctx);
finalizeRun(ws.dir, result.outcome);
printOutcome(result, ws);

// Exit codes: 0 = the run did what it was asked (finished, or the operator
// declined). 1 = a stage failed. 2 = bad usage (handled above).
process.exit(result.outcome === 'aborted' ? 1 : 0);

// ── start / resume ─────────────────────────────────────────────────────────

function startRun(opts) {
  if (!opts.url) {
    throw new Error('need a target URL\n\n  testo run <url> [--codebase PATH]\n\nTry `testo run --help`.');
  }
  try {
    new URL(opts.url);
  } catch {
    throw new Error(`"${opts.url}" is not a valid URL`);
  }

  let codebasePath = null;
  if (opts.codebase) {
    codebasePath = path.resolve(opts.codebase);
    if (!fs.existsSync(codebasePath) || !fs.statSync(codebasePath).isDirectory()) {
      throw new Error(`--codebase ${codebasePath} is not a directory`);
    }
  }

  const mode = opts.mode ?? 'safe';
  if (!MODES.has(mode)) throw new Error(`--mode must be one of: ${[...MODES].join(' | ')}`);

  const budget = opts.budget ?? Number(process.env.RUN_BUDGET ?? 200);
  if (!Number.isInteger(budget) || budget <= 0) throw new Error('--budget must be a positive integer');

  const engine = opts.engine ?? process.env.ENGINE_PROVIDER ?? 'claude';
  if (!ENGINES.has(engine)) {
    const hint = engine === 'copilot'
      ? '\n  The Copilot adapter lands in P1 (docs/specs/p0-02-engine-layer.spec.md).'
      : '';
    throw new Error(`--engine must be one of: ${[...ENGINES].join(' | ')}${hint}`);
  }

  return createWorkspace({ repoRoot: REPO_ROOT, url: opts.url, codebasePath, mode, budget, engine });
}

/**
 * Re-enter an aborted run at its first unfinished stage.
 *
 * Config is re-derived from run.json and may NOT be changed — a run whose terms
 * shifted halfway would produce a report describing something that never
 * happened. Flags that would change it are a usage error, not a silent override.
 */
function resumeRun(opts) {
  const conflicting = ['url', 'codebase', 'mode', 'budget', 'engine']
    .filter((k) => opts[k] !== undefined);
  if (conflicting.length) {
    throw new Error(
      `--resume re-uses the original run's config; drop ${conflicting.map((c) => `--${c}`).join(', ')}\n` +
      '  (a resumed run may not change its own terms — start a new run instead)'
    );
  }

  const ws = openWorkspace(REPO_ROOT, opts.resume);
  if (ws.run.outcome === 'completed') {
    throw new Error(`run ${opts.resume} already completed — nothing to resume`);
  }
  if (ws.run.outcome === 'declined') {
    throw new Error(`run ${opts.resume} was declined at the checkpoint — start a new run instead`);
  }
  return ws;
}

// ── output ─────────────────────────────────────────────────────────────────

function printBanner(run, opts) {
  console.log('━━━━━━━━━━ testo run ━━━━━━━━━━');
  console.log(`  run id    ${run.runId}${opts.resume ? '  (resumed)' : ''}`);
  console.log(`  target    ${run.target.url}`);
  console.log(`  codebase  ${run.target.codebasePath ?? '(none — url-only profile)'}`);
  console.log(`  mode      ${run.mode}${run.mode === 'safe' ? '  (no writes to the target)' : '  ⚠ MUTATIONS ENABLED'}`);
  console.log(`  engine    ${run.engine.provider}`);
  console.log(`  budget    ${run.budget.maxRequests} requests`);
  console.log(`  workspace ${path.relative(REPO_ROOT, runWorkspaceDir(run.runId))}`);
  if (opts.dryRun) console.log('  dry-run   no stage will actually execute');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

function printOutcome(result, ws) {
  const run = readRun(ws.dir);
  console.log('\n━━━━━━━━━━ run summary ━━━━━━━━━━');
  for (const [name, s] of Object.entries(run.stages)) {
    const mark = { done: '✓', failed: '✗', running: '…', skipped: '○', pending: ' ' }[s.status] ?? '?';
    const detail = s.degraded ? 'done (degraded)' : s.status;
    console.log(`  ${mark}  ${name.padEnd(11)} ${detail}`);
  }
  if (run.degraded.length) {
    console.log(`\n  ⚠ ${run.degraded.length} degradation(s) recorded — the report will disclose them:`);
    for (const d of run.degraded) console.log(`      ${d.useCase} (${d.stage}): ${d.reason}`);
  }
  console.log(`\n  workspace  ${path.relative(REPO_ROOT, ws.dir)}`);

  if (result.outcome === 'completed') {
    console.log(`  report     ${path.relative(REPO_ROOT, path.join(ws.dir, 'report', 'index.html'))}`);
    console.log('\n✓ run complete');
    return;
  }
  if (result.outcome === 'declined') {
    console.log('\n○ declined at the checkpoint — nothing was executed against the target.');
    console.log(`  Re-run the plan with:  testo run --resume ${run.runId}`);
    return;
  }
  console.error(`\n✗ run aborted at "${result.stage}": ${result.reason}`);
  console.error(`  Resume once fixed:  testo run --resume ${run.runId}`);
}

function runWorkspaceDir(runId) {
  return workspacePaths(path.join(REPO_ROOT, 'output', 'runs', runId)).dir;
}

// ── helpers ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { help: false, yes: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '-h':
      case '--help':      out.help = true; break;
      case '--codebase':
      case '--code':      out.codebase = next(); break;
      case '--mode':      out.mode = next(); break;
      case '--budget':    out.budget = Number(next()); break;
      case '--engine':    out.engine = next(); break;
      case '--yes':
      case '-y':          out.yes = true; break;
      case '--resume':    out.resume = next(); break;
      case '--dry-run':   out.dryRun = true; break;
      default:
        if (a.startsWith('-')) {
          console.error(`testo run: unknown option "${a}"`);
          process.exit(2);
        }
        if (out.url) {
          console.error(`testo run: unexpected argument "${a}" (target URL already set to "${out.url}")`);
          process.exit(2);
        }
        out.url = a;
    }
  }
  return out;
}

function printHelp() {
  console.log(`testo run — audit an application end to end, and report

Usage:
  testo run <url> [--codebase PATH] [--mode safe|full]

One run: crawl the live app (and read the codebase, if given), work out what it
is, propose a test plan, WAIT for you to approve it, generate and run the tests,
then write one report of what was tested, what wasn't, and why.

Options:
  --codebase <PATH>   local repo for the same app — unlocks declared-vs-observed
                      gap analysis and shadow-endpoint detection
  --mode <safe|full>  safe (default): GETs and navigation only; mutation
                      scenarios are generated but skipped, and reported as gaps.
                      full: mutations run for real — only point this at a
                      disposable environment you control.
  --budget <n>        engine request cap for the run (default 200)
  --engine <name>     claude (default) | mock
  -y, --yes           auto-approve the checkpoint. CI/dev only — the report
                      discloses that no human reviewed the plan.
  --resume <runId>    re-enter an aborted run at its first unfinished stage
  --dry-run           print the stage plan, run nothing
  -h, --help          show this help

Safety:
  Destructive actions (sign-out, delete, revoke, …) are never auto-exercised in
  either mode. Nothing is executed against the target until you approve the plan.

Examples:
  # Safe audit of a live app, with its source
  testo run https://app.example.com --codebase /Users/me/app

  # No source available — crawl only
  testo run https://app.example.com

  # Disposable preview environment: let it write
  testo run https://preview.example.com --mode full

  # Pick up where an aborted run left off
  testo run --resume 20260717-091500-app-example-com
`);
}
