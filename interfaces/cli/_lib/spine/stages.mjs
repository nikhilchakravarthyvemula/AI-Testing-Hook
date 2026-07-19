// The stage registry — this array IS the pipeline.
//
//   acquire → understand → store → plan → CHECKPOINT → generate → execute → report
//
// The spine holds no intelligence: each stage either shells out to a component
// that already exists, or (for C3–C8) fails honestly as "not implemented yet".
// Components replace their placeholder as they land; nothing else changes.
//
// ── on where the context layer writes ──────────────────────────────────────
//
// The existing context-layer components resolve their own paths from __dirname
// and write to <repo>/output/ — they predate the workspace and don't take a
// --workspace flag. Rather than thread a path through ~20 working files
// (including scripts/, which README.md marks UNCHANGED), the spine lets them
// write to output/ as they always have, then SNAPSHOTS the artifacts into
// <workspace>/context/ once understand completes. Everything downstream (C3–C8)
// reads only the workspace, so the blank-slate guarantee holds where it counts.
//
// The risk that buys back: output/ is shared, so a component that fails could
// leave a PREVIOUS run's artifacts in place and we'd index them as if fresh —
// the exact failure this project already hit once ("read a stale graph.json and
// reported it as fresh", infrastructure/agentic-harness/README.md). So acquire
// asserts freshness rather than assuming it: every bundle must carry a
// generatedAt from THIS run, or the run aborts. Verified beats prevented.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { stageStart, stageEnd, markDegraded, readRun, updateRun } from './workspace.mjs';
import { runCheckpoint } from './checkpoint.mjs';

// ── the registry ───────────────────────────────────────────────────────────

export const STAGES = [
  {
    name: 'acquire',
    failMode: 'abort',            // nothing to test without observations
    description: 'crawl the live app + extract the codebase',
    run: acquire,
  },
  {
    name: 'understand',
    failMode: 'abort',
    description: 'index → synthesize → gaps → features',
    run: understand,
  },
  {
    name: 'store',
    failMode: 'abort',
    description: 'merge facts + features + gaps into the run store',
    run: notImplemented('p0-03', 'context-layer/knowledge-store/build.mjs'),
  },
  {
    name: 'plan',
    failMode: 'degrade',          // template plan on failure (once C5 exists)
    description: 'propose scenarios per feature (S1)',
    run: notImplemented('p0-05', 'generation-layer/test-plan-creator/'),
  },
  {
    name: 'checkpoint',
    failMode: 'abort',            // a declined plan ends the run, cleanly
    description: 'the human gate',
    run: checkpoint,
  },
  {
    name: 'generate',
    failMode: 'degrade',
    description: 'write tests per feature (A1)',
    run: notImplemented('p0-06', 'the agent session + template fallback'),
  },
  {
    name: 'execute',
    failMode: 'abort',
    description: 'run the tests against the target',
    run: notImplemented('p0-07', 'execution-layer/test-executor/'),
  },
  {
    name: 'report',
    failMode: 'abort',
    description: 'render the final report',
    run: notImplemented('p0-08', 'execution-layer/report-generator/'),
  },
];

// ── the runner ─────────────────────────────────────────────────────────────

/**
 * Walk the stages in order, stamping status as it goes.
 *
 * @param {object} ctx { repoRoot, dir, paths, run, opts, io }
 * @returns {Promise<{outcome: 'completed'|'aborted'|'declined', stage?: string, reason?: string}>}
 */
export async function runStages(ctx) {
  for (const stage of STAGES) {
    const state = ctx.run.stages[stage.name];

    // --resume: a stage that already finished is not re-run. This is what makes
    // resume worth having — acquire is the slow one (a full crawl).
    if (state.status === 'done') {
      ctx.io.out(`  ○ ${stage.name.padEnd(11)} already done — skipping`);
      continue;
    }

    ctx.io.out(`\n┌─ ${stage.name} ─ ${stage.description} ${'─'.repeat(Math.max(0, 44 - stage.description.length))}`);
    ctx.run = stageStart(ctx.dir, stage.name);

    let result;
    try {
      result = await stage.run(ctx);
    } catch (e) {
      // An exception is a stage failure like any other — the run record must
      // stay truthful even when a component throws something we didn't model.
      result = { ok: false, reason: `${stage.name} threw: ${e.message}` };
    }

    if (result.ok) {
      ctx.run = stageEnd(ctx.dir, stage.name, 'done');
      continue;
    }

    // The operator said no. The gate ran and returned a decision — that is a
    // completed stage, not a failed one. The refusal is recorded on the
    // checkpoint object, where the report's transparency section looks for it.
    if (result.declined) {
      ctx.run = stageEnd(ctx.dir, stage.name, 'done');
      updateRun(ctx.dir, (run) => {
        run.checkpoint.declinedAt = new Date().toISOString();
        run.checkpoint.reason = result.reason;
      });
      ctx.run = readRun(ctx.dir);
      return { outcome: 'declined', stage: stage.name, reason: result.reason };
    }

    // "Not implemented" is never a degradation: there is no fallback to degrade
    // to. Abort regardless of the stage's declared failMode.
    if (result.notImplemented || stage.failMode === 'abort') {
      ctx.run = stageEnd(ctx.dir, stage.name, 'failed', { reason: result.reason });
      return { outcome: 'aborted', stage: stage.name, reason: result.reason };
    }

    // failMode: degrade — record it and carry on with the documented fallback.
    ctx.run = stageEnd(ctx.dir, stage.name, 'done', { degraded: true, reason: result.reason });
    markDegraded(ctx.dir, {
      useCase: result.useCase ?? stage.name,
      stage: stage.name,
      reason: result.reason,
      fallback: result.fallback ?? 'deterministic fallback',
    });
    ctx.run = readRun(ctx.dir);
    ctx.io.out(`  ⚠ ${stage.name} degraded: ${result.reason}`);
  }

  return { outcome: 'completed' };
}

// ── acquire ────────────────────────────────────────────────────────────────

function acquire(ctx) {
  const startedAt = Date.now();

  const env = { ...process.env, BASE_URL: ctx.run.target.url };
  if (ctx.run.target.codebasePath) {
    env.TARGET_CODEBASE = ctx.run.target.codebasePath;
  } else {
    // No codebase → graphify and the code-extractors have nothing to read. The
    // orchestrator already gates them on TARGET_CODEBASE; make sure a stale
    // value from .env can't sneak a different repo into this run.
    delete env.TARGET_CODEBASE;
  }

  const code = spawnNode(ctx, ['context-layer/content-extractor/run.mjs'], env);
  if (code !== 0) {
    return { ok: false, reason: `content-extractor exited ${code}` };
  }
  if (ctx.opts.dryRun) return { ok: true };
  return assertFreshAcquisition(ctx, startedAt);
}

/**
 * Verify the acquisition we're about to reason over actually happened in THIS
 * run — see the header note. Two checks:
 *
 *   1. the extraction index is newer than this stage's start, and
 *   2. the crawler produced live observations (a run against a URL whose crawl
 *      silently failed would report on a previous run's app).
 *
 * A code-extractor failing is a real but survivable loss: we degrade, disclose
 * it, and the report's gap section is honest about the missing perspective.
 */
export function assertFreshAcquisition(ctx, startedAt) {
  const indexPath = path.join(ctx.repoRoot, 'output', 'content-extraction-index.json');
  if (!fs.existsSync(indexPath)) {
    return { ok: false, reason: 'content-extractor produced no extraction index' };
  }

  let index;
  try {
    index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  } catch (e) {
    return { ok: false, reason: `extraction index unreadable: ${e.message}` };
  }

  const generatedAt = Date.parse(index.generatedAt ?? '');
  if (!Number.isFinite(generatedAt)) {
    return { ok: false, reason: 'extraction index has no usable generatedAt' };
  }
  // 2s of slack: the index is stamped at write time, and we only care about
  // catching artifacts from a PREVIOUS run, not millisecond skew.
  if (generatedAt < startedAt - 2000) {
    return {
      ok: false,
      reason: `extraction index is stale (generated ${index.generatedAt}, before this run's acquire) — ` +
              'refusing to report on a previous run\'s observations',
    };
  }

  const sources = Array.isArray(index.sources) ? index.sources : [];
  const crawler = sources.find((s) => s.id === 'crawler');
  if (!crawler || !crawler.ok) {
    const why = !crawler ? 'crawler did not run' : (crawler.error ?? crawler.skipped ?? 'unknown error');
    return { ok: false, reason: `no live observations of ${ctx.run.target.url} — ${why}` };
  }

  const broken = sources.filter((s) => !s.ok && !s.skipped && s.id !== 'crawler');
  for (const s of broken) {
    markDegraded(ctx.dir, {
      useCase: s.id,
      stage: 'acquire',
      reason: `source failed: ${s.error ?? 'unknown error'}`,
      fallback: 'source omitted from this run',
    });
  }
  if (broken.length) {
    ctx.run = readRun(ctx.dir);
    ctx.io.out(`  ⚠ ${broken.length} source(s) failed — recorded; the report will disclose the gap`);
  }

  return { ok: true };
}

// ── understand ─────────────────────────────────────────────────────────────

const UNDERSTAND_STEPS = [
  ['indexer', 'context-layer/indexer/index.mjs'],
  ['knowledge-synthesizer', 'context-layer/knowledge-synthesizer/synthesize.mjs'],
  ['gap-analyzer', 'context-layer/gap-analyzer/analyze.mjs'],
  ['feature-extractor', 'context-layer/feature-extractor/extract.mjs'],
];

// What the run's understanding consists of. Copied into the workspace so the
// store, the plan, and the report all read an immutable record of THIS run
// rather than a directory that the next run will overwrite.
const CONTEXT_ARTIFACTS = [
  'content-extraction-index.json',
  'sources',
  'indexed_output',
  'synthesized',
  'gaps',
  'features',
];

function understand(ctx) {
  for (const [name, script] of UNDERSTAND_STEPS) {
    const code = spawnNode(ctx, [script], process.env);
    if (code !== 0) {
      return { ok: false, reason: `${name} exited ${code}` };
    }
  }
  if (ctx.opts.dryRun) return { ok: true };
  return snapshotContext(ctx);
}

export function snapshotContext(ctx) {
  let copied = 0;
  for (const rel of CONTEXT_ARTIFACTS) {
    const src = path.join(ctx.repoRoot, 'output', rel);
    if (!fs.existsSync(src)) continue;
    fs.cpSync(src, path.join(ctx.paths.context, rel), { recursive: true });
    copied++;
  }
  if (copied === 0) {
    return { ok: false, reason: 'understand produced no artifacts to snapshot' };
  }
  ctx.io.out(`  ✓ snapshotted ${copied} context artifact(s) → ${path.relative(ctx.repoRoot, ctx.paths.context)}`);
  return { ok: true };
}

// ── checkpoint ─────────────────────────────────────────────────────────────

async function checkpoint(ctx) {
  if (!fs.existsSync(ctx.paths.planJson)) {
    return { ok: false, reason: `no plan to approve at ${path.relative(ctx.repoRoot, ctx.paths.planJson)}` };
  }

  const result = await runCheckpoint({
    dir: ctx.dir,
    planPath: ctx.paths.planJson,
    run: readRun(ctx.dir),
    autoApprove: ctx.opts.yes,
    io: ctx.io.checkpointIo,
  });

  ctx.run = readRun(ctx.dir);
  if (result.approved) return { ok: true };
  return { ok: false, declined: true, reason: result.reason };
}

// ── placeholders (C3–C8) ───────────────────────────────────────────────────

/**
 * A stage whose component hasn't been built yet.
 *
 * It fails loudly rather than quietly passing: a run that reaches this point
 * has done real work, and the operator should be told exactly where the
 * pipeline currently ends — not handed an empty report.
 */
function notImplemented(spec, what) {
  return () => ({
    ok: false,
    notImplemented: true,
    reason: `not implemented yet — ${what} lands with ${spec} (docs/specs/${spec}-*.spec.md)`,
  });
}

// ── child processes ────────────────────────────────────────────────────────

function spawnNode(ctx, args, env) {
  if (ctx.opts.dryRun) {
    ctx.io.out(`  (dry-run) node ${args.join(' ')}`);
    return 0;
  }
  const r = spawnSync('node', args, { cwd: ctx.repoRoot, env, stdio: 'inherit' });
  if (r.error) throw r.error;
  return r.status ?? 1;
}
