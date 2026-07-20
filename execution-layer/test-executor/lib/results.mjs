// results/results.json assembly (p0-00 §8).
//
// One entry per manifest entry, exactly once; four terminal statuses. The
// summary is what the spine prints and what the report's headline counts come
// from — so it's derived here, from the entries, never tracked separately (they
// can't drift if there's one source).

import fs from 'node:fs';
import path from 'node:path';

export const STATUSES = ['passed', 'failed', 'skipped-mutation', 'error'];

/**
 * A single results entry (p0-00 §8 shape). `reason` is an extra, honest field —
 * why a skip/error happened (safety-floor | safe-mode | failed-generation |
 * timeout | stage-timeout | exit N) — that the report surfaces.
 */
export function resultEntry(entry, status, { durationMs = 0, artifacts = null, reason = null } = {}) {
  return {
    scenarioId: entry.scenarioId,
    featureId: entry.featureId,
    file: entry.file,
    status,
    durationMs,
    reason,
    artifacts: artifacts ?? { screenshots: [], log: null },
  };
}

export function summarize(entries) {
  const summary = { passed: 0, failed: 0, skippedMutation: 0, error: 0 };
  for (const e of entries) {
    if (e.status === 'passed') summary.passed += 1;
    else if (e.status === 'failed') summary.failed += 1;
    else if (e.status === 'skipped-mutation') summary.skippedMutation += 1;
    else summary.error += 1;                    // 'error' and anything unexpected
  }
  return summary;
}

export function writeResults(workspace, results) {
  const p = path.join(workspace, 'results', 'results.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(results, null, 2) + '\n');
  return p;
}
