// The safety floor (p0-00 §9) — the one rule that outranks everything.
//
// Regardless of mode, a scenario whose text or targets describe a destructive
// action is never auto-executed unless the operator has named its exact
// scenarioId in SAFETY_ALLOWLIST. This is deliberately BROADER than the mutation
// flag and BLIND to it: "sign out" is a GET, not a mutation, but running it
// mid-suite would end the session the rest of the tests depend on. The floor
// pre-dates and outranks S7 button classification (P1).
//
// Enforced in code, never by an LLM. Kept in its own module so the executor and
// (later) the report both cite one definition.

// p0-00 §9, verbatim. \b anchors keep "cancelled" from matching inside e.g.
// "uncancellable"? — no: \bcancel\b won't match "uncancellable" (no boundary),
// which is the intended precision. Destructive verbs only.
export const SAFETY_FLOOR =
  /\b(delete|remove|destroy|revoke|disable|deactivate|sign[ -]?out|log[ -]?out|cancel)\b/i;

/**
 * Does this scenario trip the floor? Tested over the scenario's title, intent,
 * and every target (endpoint "METHOD path" strings + page paths) — the same
 * surface p0-00 §9 names.
 *
 * @param {object} scenario  the plan scenario ({ title, intent, targets }) or {}
 * @returns {boolean}
 */
export function matchesSafetyFloor(scenario) {
  const parts = [
    scenario?.title ?? '',
    scenario?.intent ?? '',
    ...(scenario?.targets?.endpoints ?? []),
    ...(scenario?.targets?.pages ?? []),
  ];
  return SAFETY_FLOOR.test(parts.join('\n'));
}

/**
 * Parse SAFETY_ALLOWLIST (comma- and/or whitespace-separated scenarioIds) into
 * a Set. An operator opts a specific scenario past the floor by listing its id.
 */
export function parseAllowlist(raw) {
  return new Set(
    String(raw ?? '')
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
}
