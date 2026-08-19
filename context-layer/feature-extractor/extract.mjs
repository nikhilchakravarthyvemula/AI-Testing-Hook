#!/usr/bin/env node
// Feature-Extractor — Component 4 of the context layer.
//
//   output/synthesized/facts.json  ──▶  [ extract ]  ──▶  output/features/features.json
//     700 loose canonical facts        cluster + name     functional areas (the right altitude)
//   (+ optional output/gaps/gaps.json for per-feature coverage rollup)
//
// Clusters reconciled facts into features by deterministic structural signals
// (API path segment, SPA route fragment, redirect destination, co-occurrence),
// folds well-known segments through a synonym map, names each cluster, and rolls
// up gaps per feature. Pure and deterministic with FEAT_LLM=0 (the default).
// See docs/components/feature-extractor.spec.md.
//
// Env: FEAT_MIN_SIZE=2  FEAT_API_SEGMENT_DEPTH=1  FEAT_SYNONYMS=<path>
//      FEAT_GAPS_FILE=<path>  FEAT_LLM=0

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadFacts, loadGaps, defaultGapsPath, loadSynonyms } from './lib/load.mjs';
import { featureKey, BUILTIN_SYNONYMS } from './lib/feature-key.mjs';
import { clusterByKey, UNASSIGNED } from './lib/cluster.mjs';
import { nameFeature } from './lib/naming.mjs';
import { rollupCoverage, emptyCoverage } from './lib/coverage.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FACTS_FILE = path.join(REPO_ROOT, 'output', 'synthesized', 'facts.json');
const OUT_DIR = path.join(REPO_ROOT, 'output', 'features');
const OUT_FILE = path.join(OUT_DIR, 'features.json');

const MEMBER_BUCKETS = { endpoint: 'endpoints', page: 'pages', interaction: 'interactions', redirect: 'redirects' };

function resolveConfig(opts = {}) {
  return {
    minFeatureSize: Math.max(1, parseInt(process.env.FEAT_MIN_SIZE ?? '2', 10) || 2),
    apiSegmentDepth: Math.max(1, parseInt(process.env.FEAT_API_SEGMENT_DEPTH ?? '1', 10) || 1),
    llmRequested: (process.env.FEAT_LLM ?? '0') === '1',
    synonyms: loadSynonyms(process.env.FEAT_SYNONYMS) ?? BUILTIN_SYNONYMS,
    gapsPath: opts.gapsPath ?? process.env.FEAT_GAPS_FILE ?? null,
  };
}

/**
 * Top-level: load → key → cluster → name → rollup → assemble the envelope.
 *
 * @param {string} factsPath
 * @param {{gapsPath?: string|null}} [opts]
 * @returns {Object} the features.json envelope
 */
export function extract(factsPath, opts = {}) {
  const cfg = resolveConfig(opts);
  if (cfg.llmRequested) {
    console.warn('[feature-extractor] FEAT_LLM=1 requested but LLM naming is not implemented — using deterministic names');
  }
  const { facts, target, generatedAt } = loadFacts(factsPath);
  const gaps = loadGaps(cfg.gapsPath, defaultGapsPath(REPO_ROOT));

  // Skip malformed facts (missing kind/key) — counted, warned once, never fatal.
  const valid = facts.filter(f => f && f.kind && f.key);
  const skipped = facts.length - valid.length;
  if (skipped > 0) console.warn(`[feature-extractor] skipped ${skipped} malformed fact(s) missing kind/key`);

  // The interaction-graph fact (if any) drives co-occurrence placement.
  const graphFact = valid.find(f => f.kind === 'interaction-graph') ?? null;

  const entries = valid.map(fact => ({ fact, ...featureKey(fact, cfg) }));
  const clusters = clusterByKey(entries, { minFeatureSize: cfg.minFeatureSize, graphFact });

  const features = [...clusters.entries()].map(([featureId, members]) => buildFeature(featureId, members, cfg));
  // Coverage is a gap rollup: only populated when gaps.json is present. Absent ⇒
  // every feature keeps its zeroed emptyCoverage() (spec §4 "zeroed counts").
  if (gaps.provided) rollupCoverage(features, gaps.list);

  // Sort: featureId asc, `_unassigned` always last.
  features.sort((a, b) => {
    if (a.featureId === UNASSIGNED) return 1;
    if (b.featureId === UNASSIGNED) return -1;
    return a.featureId < b.featureId ? -1 : a.featureId > b.featureId ? 1 : 0;
  });

  return {
    generatedAt: generatedAt ?? null,
    target,
    source: 'output/synthesized/facts.json',
    config: {
      minFeatureSize: cfg.minFeatureSize,
      apiSegmentDepth: cfg.apiSegmentDepth,
      llmNaming: false,                 // deterministic path only (LLM pass not implemented)
      gapsProvided: gaps.provided,
    },
    stats: buildStats(features, skipped),
    features,
  };
}

/** Assemble one Feature record from a cluster's members. */
function buildFeature(featureId, members, cfg) {
  const buckets = { endpoints: [], pages: [], interactions: [], redirects: [], other: [] };
  for (const m of members) {
    const bucket = MEMBER_BUCKETS[m.fact.kind] ?? 'other';
    buckets[bucket].push(m.fact.factId);
  }
  for (const arr of Object.values(buckets)) arr.sort();

  const { name, summary, confidence } = nameFeature({ featureId, members }, cfg);
  const signals = [...new Set(members.map(m => m.signal).filter(s => s && s !== 'unassigned' && s !== 'size-merge'))].sort();

  return {
    featureId,
    name,
    signal: featureId === UNASSIGNED ? 'none' : (signals.join('+') || 'none'),
    summary,
    members: buckets,
    memberCount: members.length,
    confidence,
    entrypoints: entrypointsFor(members),
    coverage: emptyCoverage(),
  };
}

/** Representative pages/routes to start exploring a feature from. */
function entrypointsFor(members) {
  const paths = new Set();
  for (const m of members) {
    if (m.fact.kind === 'page' || m.fact.kind === 'route') {
      const p = m.fact.key?.pathTemplate;
      if (p) paths.add(p);
    }
  }
  return [...paths].sort().slice(0, 5);
}

function buildStats(features, skipped) {
  const real = features.filter(f => f.featureId !== UNASSIGNED);
  const unassigned = features.find(f => f.featureId === UNASSIGNED);
  const assignedFacts = real.reduce((n, f) => n + f.memberCount, 0);
  const unassignedFacts = unassigned?.memberCount ?? 0;

  const byKind = {};
  for (const f of real) {
    for (const [bucket, ids] of Object.entries(f.members)) {
      if (!ids.length) continue;
      byKind[bucket] = (byKind[bucket] ?? 0) + ids.length;
    }
  }

  return {
    factsAnalyzed: assignedFacts + unassignedFacts,
    featureCount: real.length,
    assignedFacts,
    unassignedFacts,
    skipped,
    byKind,
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--gaps') opts.gapsPath = argv[++i];
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  let envelope;
  try {
    envelope = extract(FACTS_FILE, opts);
  } catch (e) {
    console.error(`[feature-extractor] ${e.message}`);
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(envelope, null, 2));

  const { featureCount, assignedFacts, unassignedFacts } = envelope.stats;
  console.log(
    `[feature-extractor] ${envelope.stats.factsAnalyzed} facts → ${featureCount} features ` +
    `(${assignedFacts} assigned, ${unassignedFacts} unassigned)`,
  );
  console.log(`[feature-extractor] wrote ${path.relative(REPO_ROOT, OUT_FILE)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
