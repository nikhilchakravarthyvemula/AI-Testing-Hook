// tests/manifest.json — the bridge between generation and execution (p0-00 §7).
//
// A test file that isn't in the manifest does not run. So the manifest, not the
// filesystem, is the record of what was generated and how it went: one entry per
// scenario in the plan, always — `generated` or `failed-generation`, agent or
// template, nothing silently dropped (p0-06 §1). The entry also carries the
// slice hash that produced it, so resume can tell a still-current file from a
// stale one (slices.mjs).

import fs from 'node:fs';
import path from 'node:path';

export function manifestPath(workspace) {
  return path.join(workspace, 'tests', 'manifest.json');
}

/** Read the manifest, or a fresh empty one. */
export function readManifest(workspace, runId = null) {
  const p = manifestPath(workspace);
  if (!fs.existsSync(p)) return { runId, entries: [] };
  try {
    const m = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { runId: m.runId ?? runId, entries: Array.isArray(m.entries) ? m.entries : [] };
  } catch {
    return { runId, entries: [] };
  }
}

export function writeManifest(workspace, manifest) {
  const p = manifestPath(workspace);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(manifest, null, 2) + '\n');
  return p;
}

/** scenarioId → entry, for resume checks and idempotent rebuilds. */
export function entriesById(manifest) {
  return new Map((manifest.entries ?? []).map((e) => [e.scenarioId, e]));
}

/**
 * @param {object} f
 * @param {'generated'|'failed-generation'} f.status
 * @param {'agent'|'template'} f.generator
 * @returns a manifest entry (p0-00 §7 shape + sliceHash for resume)
 */
export function makeEntry({ scenarioId, featureId, file, kind, mutation, generator, status, sliceHash }) {
  return { scenarioId, featureId, file, kind, mutation: Boolean(mutation), generator, status, sliceHash };
}
