// Shared safe/full mode gate for generated UI specs.
//
// safe (default): read-only. Any spec that would SUBMIT a form or trigger a
//   mutating request is skipped — but still emitted, so it shows up in the
//   report as skipped-with-reason (never silently absent).
// full: everything runs EXCEPT the always-protected catastrophic set (handled
//   at generation time — those specs are never emitted as runnable).
import { test } from '@playwright/test';

export const TEST_MODE = (process.env.TEST_MODE || 'safe').toLowerCase() === 'full' ? 'full' : 'safe';

// Call at the top of a mutating spec. In safe mode it marks the test skipped
// with a visible reason; in full mode it's a no-op and the test runs.
export function skipIfSafe(reason = 'mutating action') {
  test.skip(TEST_MODE === 'safe', `safe-mode: ${reason} not executed (run with TEST_MODE=full)`);
}
