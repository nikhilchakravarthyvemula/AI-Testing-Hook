// The `copilot` agent-session provider — a deliberate stub (mirrors the
// single-shot copilot stub). No Copilot seat on this machine; the P1 adapter
// drops in here. Fails like a real outage so selecting it degrades cleanly.

/**
 * @returns {import('../session.mjs').SessionProvider}
 */
export function createCopilotSessionProvider() {
  return {
    id: 'copilot',
    runSession() {
      return {
        ok: false, error: 'engine-unavailable',
        detail: 'copilot agent-session adapter is P1 — no seat on this machine',
      };
    },
  };
}
