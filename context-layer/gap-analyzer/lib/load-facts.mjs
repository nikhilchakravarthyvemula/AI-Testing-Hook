// I/O for the Gap-Analyzer: the synthesizer's facts.json + the optional
// coverage input. Nothing else here reaches disk.

import fs from 'node:fs';
import path from 'node:path';

/**
 * Read and lightly validate the Component 2 facts envelope.
 *
 * @param {string} factsPath  absolute path to output/synthesized/facts.json
 * @returns {{facts: Object[], target: unknown, generatedAt: string|null}}
 * @throws if the file is missing (the synthesizer must run first)
 */
export function loadFacts(factsPath) {
  if (!fs.existsSync(factsPath)) {
    throw new Error(
      `facts not found at ${factsPath} — run the knowledge-synthesizer first ` +
      `(node context-layer/knowledge-synthesizer/synthesize.mjs)`,
    );
  }
  const envelope = JSON.parse(fs.readFileSync(factsPath, 'utf8'));
  return {
    facts: Array.isArray(envelope.facts) ? envelope.facts : [],
    target: envelope.target ?? null,          // copied through verbatim (string or object)
    generatedAt: envelope.generatedAt ?? null,
  };
}

/**
 * Resolve and read the optional coverage set — a JSON array of endpoint
 * identity strings (`"<METHOD> <pathTemplate>"`) that already have tests.
 *
 * Precedence: explicit path (`--coverage` / GAP_COVERAGE_FILE) wins; otherwise
 * the conventional default file is used only if it happens to exist. A missing
 * or malformed file is non-fatal — the analyzer degrades to "no coverage"
 * (every endpoint untested), the truthful pre-generation state (spec §5.6).
 *
 * @param {string|null} explicitPath  from --coverage or GAP_COVERAGE_FILE
 * @param {string} defaultPath        conventional output/coverage/covered-endpoints.json
 * @returns {{set: Set<string>, provided: boolean}}
 */
export function loadCoverage(explicitPath, defaultPath) {
  const target = explicitPath || (fs.existsSync(defaultPath) ? defaultPath : null);
  if (!target) return { set: new Set(), provided: false };

  if (!fs.existsSync(target)) {
    console.warn(`[gap-analyzer] coverage file not found at ${target} — treating every endpoint as untested`);
    return { set: new Set(), provided: false };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('expected a JSON array of "<METHOD> <pathTemplate>" strings');
    return { set: new Set(parsed.map(String)), provided: true };
  } catch (e) {
    console.warn(`[gap-analyzer] coverage file ${target} unreadable (${e.message}) — treating every endpoint as untested`);
    return { set: new Set(), provided: false };
  }
}

/** Convenience: the conventional coverage path under a repo root. */
export function defaultCoveragePath(repoRoot) {
  return path.join(repoRoot, 'output', 'coverage', 'covered-endpoints.json');
}
