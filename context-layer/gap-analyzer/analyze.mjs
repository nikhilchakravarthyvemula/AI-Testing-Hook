#!/usr/bin/env node
// Gap-Analyzer — Component 3 of the context layer.
//
//   output/synthesized/facts.json  ──▶  [ analyze ]  ──▶  output/gaps/gaps.json
//     trustworthy canonical facts       detect + rank      prioritized coverage holes
//
// Diffs reconciled facts to surface what is undocumented (shadow), untested,
// contradictory (conflict), or unverified (low-trust), and ranks them so the
// generators and humans work the highest-risk holes first. Pure and
// deterministic: identical facts + coverage + env ⇒ byte-identical gaps.json.
// See context-layer/specs/03-gap-analyzer.spec.md.
//
// Env:
//   GAP_LOW_TRUST_CONF=0.9                       confidence floor for low-trust
//   GAP_MIN_CORROBORATION=2                      min families before a critical fact is trusted
//   GAP_LOW_TRUST_KINDS=endpoint,route,model,db-table   kinds low-trust scopes to
//   GAP_COVERAGE_FILE=<path>                     coverage input (--coverage overrides)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadFacts, loadCoverage, defaultCoveragePath } from './lib/load-facts.mjs';
import {
  detectShadowEndpoints, detectUntestedEndpoints, detectConflicts, detectLowTrust,
} from './lib/detectors.mjs';
import { prioritize } from './lib/prioritize.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FACTS_FILE = path.join(REPO_ROOT, 'output', 'synthesized', 'facts.json');
const OUT_DIR = path.join(REPO_ROOT, 'output', 'gaps');
const OUT_FILE = path.join(OUT_DIR, 'gaps.json');

const GAP_TYPES = ['shadow-endpoint', 'untested-endpoint', 'conflict', 'low-trust'];

/** Effective config from env + explicit overrides. */
function resolveConfig(opts = {}) {
  const kinds = (process.env.GAP_LOW_TRUST_KINDS ?? 'endpoint,route,model,db-table')
    .split(',').map(s => s.trim()).filter(Boolean);
  return {
    lowTrustConfidence: Number(process.env.GAP_LOW_TRUST_CONF ?? 0.9),
    minCorroboration: parseInt(process.env.GAP_MIN_CORROBORATION ?? '2', 10) || 2,
    lowTrustKinds: opts.lowTrustKinds ?? kinds,
    coveragePath: opts.coveragePath ?? process.env.GAP_COVERAGE_FILE ?? null,
  };
}

/**
 * Top-level: load → detect → prioritize → assemble the gaps envelope.
 * Pure w.r.t. its inputs (only reads the given files); returns the envelope.
 *
 * @param {string} factsPath
 * @param {{coveragePath?: string|null, lowTrustKinds?: string[]}} [opts]
 * @returns {Object} the gaps.json envelope
 */
export function analyze(factsPath, opts = {}) {
  const cfg = resolveConfig(opts);
  const { facts, target, generatedAt } = loadFacts(factsPath);
  const coverage = loadCoverage(cfg.coveragePath, defaultCoveragePath(REPO_ROOT));

  // Skip malformed facts (missing kind/provenance) — counted, warned once, never fatal.
  const validFacts = facts.filter(f => f && f.kind && f.provenance);
  const skipped = facts.length - validFacts.length;
  if (skipped > 0) console.warn(`[gap-analyzer] skipped ${skipped} malformed fact(s) missing kind/provenance`);

  const gaps = prioritize([
    ...detectShadowEndpoints(validFacts),
    ...detectUntestedEndpoints(validFacts, coverage.set),
    ...detectConflicts(validFacts),
    ...detectLowTrust(validFacts, cfg),
  ]);

  return {
    generatedAt: generatedAt ?? null,
    target,
    source: 'output/synthesized/facts.json',
    config: {
      lowTrustConfidence: cfg.lowTrustConfidence,
      minCorroboration: cfg.minCorroboration,
      lowTrustKinds: cfg.lowTrustKinds,
      coverageProvided: coverage.provided,
    },
    stats: buildStats(validFacts, gaps, skipped),
    gaps,
  };
}

function buildStats(validFacts, gaps, skipped) {
  const byType = Object.fromEntries(GAP_TYPES.map(t => [t, 0]));
  const bySeverity = { high: 0, medium: 0, low: 0 };
  for (const g of gaps) {
    byType[g.type] = (byType[g.type] ?? 0) + 1;
    bySeverity[g.severity] += 1;
  }
  return {
    factsAnalyzed: validFacts.length,
    endpointsAnalyzed: validFacts.filter(f => f.kind === 'endpoint').length,
    totalGaps: gaps.length,
    skipped,
    byType,
    bySeverity,
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--coverage') opts.coveragePath = argv[++i];
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  let envelope;
  try {
    envelope = analyze(FACTS_FILE, opts);
  } catch (e) {
    console.error(`[gap-analyzer] ${e.message}`);
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(envelope, null, 2));

  const { totalGaps, byType } = envelope.stats;
  console.log(
    `[gap-analyzer] ${envelope.stats.factsAnalyzed} facts → ${totalGaps} gaps ` +
    `(${GAP_TYPES.map(t => `${t}:${byType[t]}`).join(', ')})`,
  );
  console.log(`[gap-analyzer] wrote ${path.relative(REPO_ROOT, OUT_FILE)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
