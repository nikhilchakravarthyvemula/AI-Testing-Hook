// Within-run content-hash cache for single-shot engine calls.
//
// The same question asked twice in one run costs the engine once. This is both
// hygiene and a cost control: it's the first line of defence before the budget
// (p0-02 §2.3 — cache is checked BEFORE budget, before the engine), so a cached
// answer is returned even when the budget is already spent.
//
// Scope is deliberately one run: the cache lives under <workspace>/cache/ and
// dies with the workspace. Blank-slate runs (docs/harness-use-cases.md) do not
// share knowledge across runs, and that includes cached completions.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** The cache dir for a run workspace. Contract: <workspace>/cache/. */
export function cacheDir(workspace) {
  return path.join(workspace, 'cache');
}

/**
 * Deterministic key for a completion request.
 *
 * Any input that changes the answer must change the key: the useCase, the
 * system prompt, the user prompt, and the schema all participate. The model is
 * intentionally NOT part of the key — see the note in complete.mjs.
 */
export function cacheKeyFor({ useCase, system, prompt, schema }) {
  const material = JSON.stringify({ useCase, system: system ?? '', prompt, schema: schema ?? null });
  return 'sha256:' + crypto.createHash('sha256').update(material).digest('hex');
}

function cacheFile(workspace, cacheKey) {
  // The "sha256:" prefix is not filesystem-friendly; the digest alone is unique.
  const digest = cacheKey.replace(/^sha256:/, '');
  return path.join(cacheDir(workspace), `${digest}.json`);
}

/** Return the cached result payload, or null on a miss / unreadable entry. */
export function readCache(workspace, cacheKey) {
  const p = cacheFile(workspace, cacheKey);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;   // a corrupt cache entry is a miss, not a crash
  }
}

/** Persist a result payload under its key. */
export function writeCache(workspace, cacheKey, payload) {
  fs.mkdirSync(cacheDir(workspace), { recursive: true });
  fs.writeFileSync(cacheFile(workspace, cacheKey), JSON.stringify(payload, null, 2));
}
