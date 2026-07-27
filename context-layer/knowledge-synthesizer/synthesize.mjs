#!/usr/bin/env node
// Knowledge-Synthesizer — Component 2 of the context layer.
//
//   output/indexed_output/*.json  ──▶  [ synthesize ]  ──▶  output/synthesized/facts.json
//     N noisy, exact-key duplicates      resolve + fuse       one trustworthy fact per entity
//
// Pipeline: load topics → canonicalize each item to a factId → group items that
// share a factId → fuse confidence across independent source families → fuse
// attributes and surface conflicts → assemble CanonicalFacts → write.
//
// Deterministic with SYNTH_LLM=0 (the default): identical input ⇒ byte-identical
// output. See context-layer/specs/02-knowledge-synthesizer.spec.md.
//
// Env:
//   SYNTH_LLM=0        fuzzy-residue LLM matcher (1 would enable — not implemented)
//   SYNTH_BLOCK_MAX=200 warn when a blocking bucket exceeds this (perf guard)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadIndexed } from './lib/load-indexed.mjs';
import { canonicalize, kindForTopic, hostOf } from './lib/canonicalize.mjs';
import { fuse, isKnownTier } from './lib/fusion.mjs';
import { fuseAttributes } from './lib/conflicts.mjs';
import { toCanonicalFact, buildEnvelope } from './lib/models.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const INDEXED_DIR = path.join(REPO_ROOT, 'output', 'indexed_output');
const OUT_DIR = path.join(REPO_ROOT, 'output', 'synthesized');
const OUT_FILE = path.join(OUT_DIR, 'facts.json');

const SYNTH_LLM = (process.env.SYNTH_LLM ?? '0') === '1';
const SYNTH_BLOCK_MAX = Math.max(1, parseInt(process.env.SYNTH_BLOCK_MAX ?? '200', 10) || 200);

/**
 * Resolve, fuse, and assemble CanonicalFacts from loaded topics.
 * Exported so tests and downstream tooling can synthesize in-process.
 *
 * @param {import('./lib/load-indexed.mjs').LoadedIndex} loaded
 * @returns {{facts: Object[], stats: Object, sourceTopics: string[], target: string|null, generatedAt: string|null}}
 */
export function synthesize(loaded) {
  const targetHost = hostOf(loaded.target);
  const ctx = { targetHost };

  // ── resolve: group items by canonical factId (kind is baked into factId, so
  //    cross-kind items never collide) ──────────────────────────────────────
  /** @type {Map<string, {factId: string, kind: string, key: Object, observations: Object[], equivalenceGroup: string[], blockKey: string}>} */
  const groups = new Map();
  const sourceTopics = [];
  let unknownTierObservations = 0;

  for (const { topic, items } of loaded.topics) {
    if (items.length) sourceTopics.push(topic);
    const kind = kindForTopic(topic);
    for (const item of items) {
      const { factId, key, blockKey } = canonicalize(kind, item, ctx);
      let g = groups.get(factId);
      if (!g) {
        g = { factId, kind, key, observations: [], equivalenceGroup: [], blockKey };
        groups.set(factId, g);
      }
      g.equivalenceGroup.push(item.id);
      for (const obs of item.observations ?? []) g.observations.push(obs);
    }
  }

  // ── blocking (perf guard, spec §4.4) + LLM residue pass (stub, §4.5) ──────
  // Merging happens by exact factId above; blocking only bounds where a future
  // LLM pass could merge non-identical keys. With SYNTH_LLM=0 it is a no-op.
  const llmMatchCalls = resolveResidue(groups);

  // ── fuse each group into a CanonicalFact ─────────────────────────────────
  const facts = [];
  let conflictEntries = 0;

  for (const g of groups.values()) {
    const validObs = g.observations.filter(o => {
      const known = isKnownTier(o.discoveryTier);
      if (!known) unknownTierObservations += 1;
      return known;
    });

    // A group with only unknown-tier observations still yields a fact (its raw
    // observations are retained for explainability) but fuses to zero families.
    const fuseResult = fuse(validObs);
    const attrResult = fuseAttributes(validObs);
    conflictEntries += attrResult.conflicts.length;

    facts.push(toCanonicalFact(g, fuseResult, attrResult));
  }

  // Stable order: sort by factId (spec §8 determinism).
  facts.sort((a, b) => (a.factId < b.factId ? -1 : a.factId > b.factId ? 1 : 0));

  const stats = {
    inputItems: loaded.inputItems,
    canonicalFacts: facts.length,
    mergedByCanonicalization: loaded.inputItems - facts.length,
    conflicts: conflictEntries,
    llmMatchCalls,
  };
  if (unknownTierObservations) stats.unknownTierObservations = unknownTierObservations;

  return { facts, stats, sourceTopics, target: loaded.target, generatedAt: loaded.generatedAt };
}

/**
 * Blocking + fuzzy-residue merge. Deterministic path (SYNTH_LLM=0) performs no
 * merges — non-identical canonical keys stay separate (conservative). Returns
 * the number of LLM match calls made (always 0 while the pass is stubbed).
 */
function resolveResidue(groups) {
  if (!SYNTH_LLM) {
    // Still compute blocks so oversized buckets are visible as a perf warning.
    const blocks = new Map();
    for (const g of groups.values()) {
      const arr = blocks.get(g.blockKey) ?? [];
      arr.push(g.factId);
      blocks.set(g.blockKey, arr);
    }
    for (const [blockKey, factIds] of blocks) {
      if (factIds.length > SYNTH_BLOCK_MAX) {
        console.warn(`[synthesizer] block "${blockKey}" has ${factIds.length} keys (> SYNTH_BLOCK_MAX=${SYNTH_BLOCK_MAX})`);
      }
    }
    return 0;
  }
  // SYNTH_LLM=1 would batch one LLM call per block over the fuzzy residue and
  // merge confirmed matches, failing safe (no merge) on error. Not implemented.
  console.warn('[synthesizer] SYNTH_LLM=1 requested but the LLM residue pass is not implemented — running deterministic-only');
  return 0;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function main() {
  let loaded;
  try {
    loaded = loadIndexed(INDEXED_DIR);
  } catch (e) {
    console.error(`[synthesizer] ${e.message}`);
    process.exit(1);
  }

  const t0 = Date.now();
  const { facts, stats, sourceTopics, target, generatedAt } = synthesize(loaded);
  const envelope = buildEnvelope({ target, sourceTopics, facts, stats, generatedAt });

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(envelope, null, 2));

  console.log(
    `[synthesizer] ${stats.inputItems} items → ${stats.canonicalFacts} facts ` +
    `(${stats.mergedByCanonicalization} merged, ${stats.conflicts} conflicts) in ${Date.now() - t0}ms`,
  );
  console.log(`[synthesizer] wrote ${path.relative(REPO_ROOT, OUT_FILE)}`);
}

// Run as CLI, but stay importable (synthesize) without side effects.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
