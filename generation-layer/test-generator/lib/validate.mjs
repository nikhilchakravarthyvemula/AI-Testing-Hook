// Post-generation validation (p0-06 §4) — the minimal form of the generation-
// layer's "validator" slot.
//
// A generated file that doesn't parse is worse than a missing one: it fails at
// execution time with a confusing error and pollutes the report. So every new
// file — session-written OR template — gets a `node --check` parse gate before
// it earns a `generated` manifest entry. Failures are moved out of the way (to
// tests/_rejected/) and recorded as `failed-generation`, and the scenario falls
// back to a template (which is parse-checked in turn).
//
// `node --check` and not ESLint: it's already on the machine, needs no config,
// and catches the one thing we actually must catch here — a file Node can't load.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * Parse-check a workspace-relative file.
 * @returns {{ ok: true } | { ok: false, detail: string }}
 */
export function parseCheck(workspace, relPath) {
  const abs = path.join(workspace, relPath);
  if (!fs.existsSync(abs)) return { ok: false, detail: `file missing: ${relPath}` };
  const r = spawnSync(process.execPath, ['--check', abs], { encoding: 'utf8' });
  if (r.status === 0) return { ok: true };
  const detail = (r.stderr || r.stdout || `node --check exited ${r.status}`).trim().split('\n')[0];
  return { ok: false, detail };
}

/**
 * Move a rejected file to tests/_rejected/<featureId>/<name>, out of the path
 * the executor scans, keeping it for the operator to inspect.
 * @returns {string} the new workspace-relative path
 */
export function rejectFile(workspace, relPath) {
  const rejectedRel = path.join('tests', '_rejected', path.relative('tests', relPath));
  const abs = path.join(workspace, relPath);
  const dest = path.join(workspace, rejectedRel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(abs)) fs.renameSync(abs, dest);
  return rejectedRel;
}
