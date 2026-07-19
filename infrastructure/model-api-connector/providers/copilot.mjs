// The `copilot` single-shot provider — a deliberate stub.
//
// The GitHub Copilot SDK is the target engine at work, but this machine has no
// Copilot seat, so we cannot build or verify a real adapter here. It exists as a
// stub so the provider CONTRACT is already exercised by the shared contract
// tests (p0-02 §4) against its expected-failure shape — when a seat exists in
// P1, filling this in is a drop-in that the tests already describe.
//
// It fails the same way a real outage does (engine-unavailable), so selecting it
// today degrades cleanly rather than crashing.

/**
 * @returns {import('../complete.mjs').SingleShotProvider}
 */
export function createCopilotProvider() {
  return {
    id: 'copilot',
    singleShot() {
      return {
        ok: false,
        error: 'engine-unavailable',
        detail: 'copilot adapter is P1 — no seat on this machine ' +
                '(docs/specs/p0-02-engine-layer.spec.md §2.2)',
      };
    },
  };
}
