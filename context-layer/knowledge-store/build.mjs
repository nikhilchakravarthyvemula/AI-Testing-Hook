// C3 — build the per-run knowledge store.
//
// The `store` stage: take the three understand-stage artifacts, resolve the S2
// residue, index everything, and write ONE queryable file —
// <workspace>/store/knowledge.json — that every downstream component reads
// instead of re-parsing raw stage outputs. Written once, read-only thereafter.
//
// It is a MERGE, not a computation: it does not re-run synthesis, gaps, or
// feature-clustering. The single enrichment it performs is S2 (merging
// concrete-vs-template endpoint duplicates the exact-key synthesizer couldn't).

import fs from 'node:fs';
import path from 'node:path';

import { loadContext } from './lib/load.mjs';
import { candidatePairs } from './lib/residue.mjs';
import { resolveResidue } from './lib/s2.mjs';
import { buildIndexes } from './lib/indexes.mjs';

/**
 * @param {object} ctx
 * @param {string} ctx.workspace     run dir (writes store/knowledge.json here)
 * @param {string} [ctx.contextDir]  where the understand artifacts are (default <workspace>/context)
 * @param {object} [ctx.target]      { url, profile } for the store header
 * @param {string} [ctx.runId]
 * @param {object} [ctx.engine]      { provider, model, maxRequests } for S2
 * @param {(m:string)=>void} [ctx.log]
 * @returns {Promise<{ ok:true, stats, degraded } | { ok:false, reason }>}
 */
export async function buildStore(ctx) {
  const log = ctx.log ?? (() => {});
  const contextDir = ctx.contextDir ?? path.join(ctx.workspace, 'context');

  let loaded;
  try {
    loaded = loadContext(contextDir);
  } catch (e) {
    return { ok: false, reason: e.message };
  }
  const { facts, gaps, features } = loaded;

  // ── S2: resolve the residue (the one enrichment) ──────────────────────────
  const endpointFacts = facts.filter((f) => f.kind === 'endpoint');
  const pairs = candidatePairs(endpointFacts);
  log(`residue: ${pairs.length} candidate near-duplicate endpoint pair(s)`);

  let s2 = { facts, remap: {}, merges: 0, skipped: 0, note: null, degraded: [] };
  if (pairs.length > 0) {
    s2 = await resolveResidue({
      facts,
      pairs,
      engine: {
        workspace: ctx.workspace,
        provider: ctx.engine?.provider,
        model: ctx.engine?.model,
        maxRequests: ctx.engine?.maxRequests,
      },
    });
    log(`S2: ${s2.merges} merged, ${s2.skipped} left unmerged`);
  }

  // ── index + assemble ──────────────────────────────────────────────────────
  const indexes = buildIndexes({ facts: s2.facts, features, gaps, remap: s2.remap });

  const store = {
    runId: ctx.runId ?? null,
    builtAt: new Date().toISOString(),
    target: {
      url: ctx.target?.url ?? loaded.target?.baseUrl ?? loaded.target?.url ?? null,
      profile: ctx.target?.profile ?? null,
    },
    facts: s2.facts,
    features,
    gaps,
    indexes: {
      factsByKey: indexes.factsByKey,
      factsByFeature: indexes.factsByFeature,
      gapsByFeature: indexes.gapsByFeature,
      pagesByFeature: indexes.pagesByFeature,
    },
    stats: {
      facts: s2.facts.length,
      features: features.length,
      gaps: gaps.length,
      s2Candidates: pairs.length,
      s2Merges: s2.merges,
      s2Skipped: s2.skipped,
    },
  };

  const outPath = path.join(ctx.workspace, 'store', 'knowledge.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(store, null, 2) + '\n');

  const degraded = [...s2.degraded];
  if (s2.note) log(s2.note);

  return { ok: true, stats: store.stats, degraded };
}
