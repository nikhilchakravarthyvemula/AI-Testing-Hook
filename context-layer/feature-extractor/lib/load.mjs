// I/O for the Feature-Extractor: the synthesizer's facts.json (required) and
// the gap-analyzer's gaps.json (optional, read-only for coverage rollup).

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
 * Read the optional gaps envelope for per-feature coverage rollup. Missing or
 * malformed input is non-fatal — coverage is simply reported as not-provided.
 *
 * @param {string|null} explicitPath  from --gaps or FEAT_GAPS_FILE
 * @param {string} defaultPath        conventional output/gaps/gaps.json
 * @returns {{list: Object[], provided: boolean}}
 */
export function loadGaps(explicitPath, defaultPath) {
  const target = explicitPath || (fs.existsSync(defaultPath) ? defaultPath : null);
  if (!target) return { list: [], provided: false };

  if (!fs.existsSync(target)) {
    console.warn(`[feature-extractor] gaps file not found at ${target} — skipping coverage rollup`);
    return { list: [], provided: false };
  }
  try {
    const envelope = JSON.parse(fs.readFileSync(target, 'utf8'));
    const list = Array.isArray(envelope.gaps) ? envelope.gaps : [];
    return { list, provided: true };
  } catch (e) {
    console.warn(`[feature-extractor] gaps file ${target} unreadable (${e.message}) — skipping coverage rollup`);
    return { list: [], provided: false };
  }
}

/** Conventional gaps path under a repo root. */
export function defaultGapsPath(repoRoot) {
  return path.join(repoRoot, 'output', 'gaps', 'gaps.json');
}

/** Optional synonym/display-label map override (FEAT_SYNONYMS). */
export function loadSynonyms(synonymsPath) {
  if (!synonymsPath || !fs.existsSync(synonymsPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(synonymsPath, 'utf8'));
  } catch (e) {
    console.warn(`[feature-extractor] synonyms file ${synonymsPath} unreadable (${e.message}) — using built-in map`);
    return null;
  }
}
