// The `mock` single-shot provider — recorded-fixture replay.
//
// This is what makes the whole engine layer testable without credentials, and
// how CI exercises the DEGRADED paths on purpose: a call with no fixture returns
// engine-unavailable, exactly as a real outage would, so the caller's
// deterministic fallback gets tested every run (p0-02 §2.2).
//
// Fixtures live at <fixturesRoot>/<useCase>/<digest>.json, keyed by the same
// content hash the cache uses — so a fixture recorded for one prompt replays for
// that exact prompt and no other. Record them by running the real engine with
// MOCK_RECORD=1 (handled in complete.mjs), then replay for free forever after.
//
// Fixture shape (the provider-level result):
//   { "text": "...", "model": "claude-...", "usage": { "inputTokens": N, "outputTokens": N } }

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/** Where fixtures are read from / recorded to. */
export function fixturesRoot() {
  return process.env.MOCK_FIXTURES_DIR || path.join(REPO_ROOT, 'fixtures', 'engine');
}

export function fixtureFile(useCase, cacheKey) {
  const digest = cacheKey.replace(/^sha256:/, '');
  return path.join(fixturesRoot(), useCase, `${digest}.json`);
}

/**
 * @returns {import('../complete.mjs').SingleShotProvider}
 */
export function createMockProvider() {
  return {
    id: 'mock',

    singleShot({ useCase, cacheKey }) {
      const file = fixtureFile(useCase, cacheKey);
      if (!fs.existsSync(file)) {
        // The point of the mock: a missing fixture IS the simulated outage.
        return {
          ok: false,
          error: 'engine-unavailable',
          detail: `no fixture for ${useCase} at ${path.relative(REPO_ROOT, file)} ` +
                  '(record one with MOCK_RECORD=1, or expect the degraded path)',
        };
      }
      let fx;
      try {
        fx = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (e) {
        return { ok: false, error: 'engine-unavailable', detail: `unreadable fixture: ${e.message}` };
      }
      return {
        ok: true,
        text: fx.text ?? '',
        model: fx.model ?? 'mock',
        usage: {
          inputTokens: fx.usage?.inputTokens ?? 0,
          outputTokens: fx.usage?.outputTokens ?? 0,
        },
      };
    },
  };
}

/** Record a live provider result as a replayable fixture (used by MOCK_RECORD). */
export function recordFixture(useCase, cacheKey, providerResult) {
  const file = fixtureFile(useCase, cacheKey);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    text: providerResult.text,
    model: providerResult.model,
    usage: providerResult.usage,
  }, null, 2));
  return file;
}
