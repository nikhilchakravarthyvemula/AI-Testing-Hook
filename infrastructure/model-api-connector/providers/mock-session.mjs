// The `mock` agent-session provider — scripted file replay.
//
// What makes the whole GENERATE stage (C6) testable without an engine: a mock
// session "runs" by copying predefined test files into the workspace, exactly
// where a real session would have written them. A slice with no fixture returns
// engine-unavailable — so C6's per-slice template fallback gets exercised on
// purpose, every CI run (p0-02 §3.2).
//
// Fixture layout: <fixturesRoot>/sessions/<featureId>/…
//   files/<relpath>   — each becomes tests/<featureId>/<relpath> in the workspace
//   session.json      — optional { model, turns, inputTokens, outputTokens }
// A featureId directory with no files/ is a valid "engine produced nothing"
// fixture (drives the honesty-failure path).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

function sessionsRoot() {
  const base = process.env.MOCK_FIXTURES_DIR || path.join(REPO_ROOT, 'fixtures', 'engine');
  return path.join(base, 'sessions');
}

/**
 * @returns {import('../session.mjs').SessionProvider}
 */
export function createMockSessionProvider() {
  return {
    id: 'mock',

    runSession({ workspace, slice }) {
      const featureId = slice?.featureId;
      const fxDir = path.join(sessionsRoot(), featureId ?? '');
      if (!featureId || !fs.existsSync(fxDir)) {
        return {
          ok: false, error: 'engine-unavailable',
          detail: `no session fixture for feature "${featureId}" ` +
                  `(expected ${path.relative(REPO_ROOT, fxDir)}/)`,
        };
      }

      // Copy fixture files into tests/<featureId>/… — the same place a real
      // session writes, so the honesty check + manifest derivation behave
      // identically for mock and live.
      const filesDir = path.join(fxDir, 'files');
      const destBase = path.join(workspace, 'tests', featureId);
      if (fs.existsSync(filesDir)) {
        fs.mkdirSync(destBase, { recursive: true });
        fs.cpSync(filesDir, destBase, { recursive: true });
      }

      const meta = readJson(path.join(fxDir, 'session.json')) ?? {};
      return {
        ok: true,
        model: meta.model ?? 'mock',
        finalText: meta.finalText ?? 'mock session complete',
        usage: {
          turns: meta.turns ?? 1,
          inputTokens: meta.inputTokens ?? 0,
          outputTokens: meta.outputTokens ?? 0,
        },
      };
    },
  };
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
