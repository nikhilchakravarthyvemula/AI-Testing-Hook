// Enforcement (p0-07 §2) — decided per entry, BEFORE anything runs, in code.
//
// Three gates, in this order, and the order matters: the safety floor is checked
// before mode, so it applies in full mode too; a failed-generation entry is
// carried through untouched because there is nothing to run. Whatever this
// returns, the entry still appears in results — a skip is a result, not an
// omission (the report's gap section is built from these).

import { matchesSafetyFloor } from './safety-floor.mjs';

/**
 * @param {object} entry     manifest entry ({ scenarioId, mutation, status, ... })
 * @param {object} scenario  the joined plan scenario ({ title, intent, targets }) or {}
 * @param {object} opts      { mode: 'safe'|'full', allowlist: Set<string> }
 * @returns {{ decision: 'run'|'skip'|'carry', status?: string, reason?: string }}
 *   - run   → hand to the runner
 *   - skip  → skipped-mutation, with the reason (safety-floor | safe-mode)
 *   - carry → not runnable (failed-generation) — recorded as error, never run
 */
export function classify(entry, scenario, { mode, allowlist }) {
  // A file generation couldn't produce — it never ran and never will. Carry it
  // into results honestly rather than pretend it passed or drop it.
  if (entry.status === 'failed-generation') {
    return { decision: 'carry', status: 'error', reason: 'failed-generation' };
  }

  // The floor outranks mode. An allowlisted scenarioId is the operator's
  // explicit, per-scenario override — nothing else lets a floor match through.
  if (matchesSafetyFloor(scenario) && !allowlist.has(entry.scenarioId)) {
    return { decision: 'skip', status: 'skipped-mutation', reason: 'safety-floor' };
  }

  // Safe mode skips every mutation; full mode lets them run (the floor above
  // already caught the destructive ones).
  if (mode === 'safe' && entry.mutation === true) {
    return { decision: 'skip', status: 'skipped-mutation', reason: 'safe-mode' };
  }

  return { decision: 'run' };
}
