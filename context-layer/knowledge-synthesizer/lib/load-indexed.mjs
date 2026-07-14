// Reads the indexer's per-topic output under output/indexed_output/.
//
// The synthesizer consumes ONLY these files — never the raw source bundles.
// Every topic file except index.json (the summary) and any graphs/ subdir
// contributes its IndexedItem[] to entity resolution downstream.

import fs from 'node:fs';
import path from 'node:path';

/**
 * @typedef {Object} LoadedTopic
 * @property {string} topic
 * @property {string|null} target
 * @property {import('../../indexer/lib/models.mjs').IndexedItem[]} items
 */

/**
 * @typedef {Object} LoadedIndex
 * @property {LoadedTopic[]} topics
 * @property {string|null} target        - resolved from the first topic that carries one
 * @property {number} inputItems         - total IndexedItems across all topics
 * @property {string|null} generatedAt   - the indexer's run timestamp (data vintage)
 */

const SKIP_FILES = new Set(['index.json']);

/**
 * Load every topic file from output/indexed_output/.
 *
 * @param {string} indexedDir  absolute path to output/indexed_output
 * @returns {LoadedIndex}
 * @throws if the directory is missing (the indexer must run first)
 */
export function loadIndexed(indexedDir) {
  if (!fs.existsSync(indexedDir) || !fs.statSync(indexedDir).isDirectory()) {
    throw new Error(
      `indexed output not found at ${indexedDir} — run the indexer first ` +
      `(node context-layer/indexer/index.mjs)`,
    );
  }

  // Sort filenames so iteration order — and therefore output — is deterministic.
  const files = fs.readdirSync(indexedDir)
    .filter(f => f.endsWith('.json') && !SKIP_FILES.has(f))
    .sort();

  const topics = [];
  let target = null;
  let generatedAt = null;
  let inputItems = 0;

  for (const file of files) {
    const full = path.join(indexedDir, file);
    if (fs.statSync(full).isDirectory()) continue;   // e.g. graphs/
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch (e) {
      console.warn(`[synthesizer] skipping unreadable topic file ${file}: ${e.message}`);
      continue;
    }
    const items = Array.isArray(parsed.items) ? parsed.items : [];
    target ??= parsed.target ?? null;
    generatedAt ??= parsed.generatedAt ?? null;
    inputItems += items.length;
    topics.push({ topic: parsed.topic ?? file.replace(/\.json$/, ''), target: parsed.target ?? null, items });
  }

  return { topics, target, generatedAt, inputItems };
}
