// Run workspace — the spine's filesystem contract.
//
// Every `testo run` gets one disposable directory under output/runs/<runId>/
// holding everything the run produces. Nothing outside it is written, and
// nothing from a *previous* run is ever read (the blank-slate rule): a run's
// report can only ever describe what that run itself observed.
//
// Layout (docs/specs/p0-00-overview.md §3):
//
//   output/runs/<runId>/
//   ├── run.json             the run record — config, stage status, degradation
//   ├── ledger.jsonl         every engine call, append-only  (written by C2)
//   ├── cache/               content-hash cache for single-shot calls (C2)
//   ├── context/            snapshot of the context-layer artifacts
//   ├── store/               knowledge.json                  (C3)
//   ├── plan/                test-plan.json — the checkpoint's subject (C5)
//   ├── tests/               generated tests + manifest.json (C6)
//   ├── results/             executor output                 (C7)
//   └── report/              index.html + report.pdf         (C8)
//
// This module owns run.json exclusively. Other components read it; only the
// spine writes it — which is why `markDegraded` lives here rather than being
// re-implemented per stage.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// ── the stage sequence ─────────────────────────────────────────────────────
// Order matters: this array IS the pipeline. `checkpoint` sits between plan
// and generate because nothing may touch the target app before a human says so.

export const STAGE_NAMES = [
  'acquire',
  'understand',
  'store',
  'plan',
  'checkpoint',
  'generate',
  'execute',
  'report',
];

export const RUNS_DIR_NAME = path.join('output', 'runs');

// ── ids ────────────────────────────────────────────────────────────────────

/**
 * runId = <yyyymmdd-HHmmss>-<slug(target host)>.
 * Sortable by time, greppable by target, safe as a directory name.
 */
export function newRunId(url, now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${stamp}-${slugifyHost(url)}`;
}

export function slugifyHost(url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    host = String(url ?? 'target');
  }
  const slug = host
    .replace(/^www\./, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'target';
}

// ── paths ──────────────────────────────────────────────────────────────────

/** Every workspace path in one place, so no component invents its own. */
export function workspacePaths(dir) {
  return {
    dir,
    runJson: path.join(dir, 'run.json'),
    ledger: path.join(dir, 'ledger.jsonl'),
    cache: path.join(dir, 'cache'),
    context: path.join(dir, 'context'),
    store: path.join(dir, 'store'),
    storeJson: path.join(dir, 'store', 'knowledge.json'),
    plan: path.join(dir, 'plan'),
    planJson: path.join(dir, 'plan', 'test-plan.json'),
    planSlices: path.join(dir, 'plan', 'slices'),
    tests: path.join(dir, 'tests'),
    manifest: path.join(dir, 'tests', 'manifest.json'),
    results: path.join(dir, 'results'),
    resultsJson: path.join(dir, 'results', 'results.json'),
    report: path.join(dir, 'report'),
    mcpConfig: path.join(dir, 'mcp-config.json'),
  };
}

export function runDir(repoRoot, runId) {
  return path.join(repoRoot, RUNS_DIR_NAME, runId);
}

// ── create / open ──────────────────────────────────────────────────────────

/**
 * Create a fresh workspace and its run record.
 *
 * @param {object} cfg  { repoRoot, runId, url, codebasePath, mode, budget, engine }
 * @returns {{ runId, dir, paths, run }}
 */
export function createWorkspace(cfg) {
  const runId = cfg.runId ?? newRunId(cfg.url);
  const dir = runDir(cfg.repoRoot, runId);

  if (fs.existsSync(dir)) {
    throw new Error(`workspace already exists: ${dir}`);
  }

  const paths = workspacePaths(dir);
  for (const d of [paths.dir, paths.cache, paths.context, paths.store,
                   paths.plan, paths.tests, paths.results, paths.report]) {
    fs.mkdirSync(d, { recursive: true });
  }
  // The ledger is append-only and read by the budget check + the report's
  // transparency section; create it empty so both can read it unconditionally.
  fs.writeFileSync(paths.ledger, '');

  const run = {
    runId,
    createdAt: new Date().toISOString(),
    target: {
      url: cfg.url,
      codebasePath: cfg.codebasePath ?? null,
    },
    profile: cfg.codebasePath ? 'url+code' : 'url-only',
    mode: cfg.mode ?? 'safe',
    budget: { maxRequests: cfg.budget ?? 200 },
    engine: { provider: cfg.engine ?? 'claude' },
    // How the run ended, once it has. `null` while in flight — a run.json with
    // outcome:null and no running stage is a run that was killed, which is
    // itself worth being able to tell apart from one that failed.
    outcome: null,
    stages: Object.fromEntries(
      STAGE_NAMES.map((name) => [name, { status: 'pending', startedAt: null, endedAt: null }])
    ),
    checkpoint: { approvedAt: null, planHash: null },
    degraded: [],
  };

  writeRun(dir, run);
  return { runId, dir, paths, run };
}

/**
 * Re-open an existing workspace for --resume.
 *
 * The ONLY sanctioned way to touch a prior run's directory: the operator named
 * this runId explicitly. Config is re-derived from run.json — a resumed run may
 * not change its own terms (else the report would describe a run that never
 * happened as configured).
 */
export function openWorkspace(repoRoot, runId) {
  const dir = runDir(repoRoot, runId);
  if (!fs.existsSync(dir)) {
    throw new Error(`no such run: ${runId} (looked in ${dir})`);
  }
  const run = readRun(dir);
  return { runId, dir, paths: workspacePaths(dir), run };
}

// ── run.json I/O ───────────────────────────────────────────────────────────

export function readRun(dir) {
  const p = workspacePaths(dir).runJson;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    throw new Error(`unreadable run record at ${p}: ${e.message}`);
  }
}

/**
 * Write run.json atomically.
 *
 * A run killed mid-write must not leave a truncated record — the whole point of
 * run.json is that it stays truthful about a run that died. tmp + rename gives
 * us that for free.
 */
export function writeRun(dir, run) {
  const p = workspacePaths(dir).runJson;
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(run, null, 2) + '\n');
  fs.renameSync(tmp, p);
  return run;
}

/** Read → mutate → write. Every state change goes through here. */
export function updateRun(dir, mutate) {
  const run = readRun(dir);
  mutate(run);
  return writeRun(dir, run);
}

// ── stage status ───────────────────────────────────────────────────────────

export function stageStart(dir, name) {
  return updateRun(dir, (run) => {
    run.stages[name].status = 'running';
    run.stages[name].startedAt = new Date().toISOString();
    run.stages[name].endedAt = null;
  });
}

/** @param {'done'|'failed'|'skipped'} status */
export function stageEnd(dir, name, status, extra = {}) {
  return updateRun(dir, (run) => {
    Object.assign(run.stages[name], { status, endedAt: new Date().toISOString() }, extra);
  });
}

/**
 * Stamp how the run ended.
 * @param {'completed'|'aborted'|'declined'} outcome
 */
export function finalizeRun(dir, outcome, extra = {}) {
  return updateRun(dir, (run) => {
    run.outcome = outcome;
    run.endedAt = new Date().toISOString();
    Object.assign(run, extra);
  });
}

// ── degradation ────────────────────────────────────────────────────────────

/**
 * Record that a use case took its deterministic fallback.
 *
 * This is the spine's half of the degradation contract: components report
 * `ok: false`, the spine writes it down, and the report's transparency section
 * reads it back. A degraded run still produces a report — it just says so.
 *
 * @param {object} entry { useCase, stage, reason, fallback }
 */
export function markDegraded(dir, entry) {
  if (!entry?.useCase || !entry?.stage || !entry?.reason || !entry?.fallback) {
    throw new Error('markDegraded needs { useCase, stage, reason, fallback }');
  }
  return updateRun(dir, (run) => {
    run.degraded.push({ ...entry, at: new Date().toISOString() });
  });
}

// ── hashing ────────────────────────────────────────────────────────────────

/** sha256 of a file's bytes, prefixed so the algorithm is self-describing. */
export function hashFile(filePath) {
  const buf = fs.readFileSync(filePath);
  return 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex');
}

// ── ledger (read-only here) ────────────────────────────────────────────────
//
// The spine never WRITES the ledger — the engine layer (C2) does. It only reads
// it, to show the operator what the plan will cost against what's left at the
// checkpoint. Read + budget-sum logic lives in the engine layer's ledger.mjs so
// the number the human approves and the number enforcement uses are literally
// the same function. Re-exported here so spine callers keep one import.
export { readLedger, requestsSpent } from '../../../../infrastructure/model-api-connector/ledger.mjs';
