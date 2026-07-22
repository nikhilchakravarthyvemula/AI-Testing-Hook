// The in-child test harness — run ONE test file, report via exit code.
//
//   node harness.mjs <absolute-test-file>
//
// Every generated test file (agent or template) shares one execution contract:
// it exports `async function run(ctx)`, where ctx = { baseUrl, shotDir, env }.
// It resolves on success and throws on failure. The harness is what the executor
// spawns as a child process (its own process group), so a test's own timeout /
// teardown is bounded from the outside — the harness itself stays tiny and dumb.
//
// Exit codes the executor reads:
//   0 → passed        (run() resolved)
//   1 → failed        (run() threw — a real assertion/behaviour failure)
//   2 → error         (the file has no run() export — a contract/generation bug)

import { pathToFileURL } from 'node:url';

const [file] = process.argv.slice(2);

if (!file) {
  console.error('[harness] usage: node harness.mjs <test-file>');
  process.exit(2);
}

// The contract a generated test is written against (session.mjs teaches it, and
// template-gen.mjs honours it): baseUrl to target, shotDir for failure evidence,
// and the run's credentials — storageState for a browser context, authToken for
// an Authorization: Bearer header. Both are null when the run has no saved login.
const ctx = {
  baseUrl: process.env.BASE_URL || null,
  shotDir: process.env.SHOT_DIR || null,
  storageState: process.env.STORAGE_STATE || null,
  authToken: process.env.AUTH_TOKEN || null,
  // For an app whose token lives only in memory, a UI test must sign in itself —
  // restoring a saved session cannot work. Null when the run has no credentials.
  login: process.env.LOGIN_EMAIL && process.env.LOGIN_PASSWORD
    ? { email: process.env.LOGIN_EMAIL, password: process.env.LOGIN_PASSWORD }
    : null,
  env: process.env,
};

try {
  const mod = await import(pathToFileURL(file).href);
  if (typeof mod.run !== 'function') {
    console.error(`[harness] ${file} exports no run() — cannot execute`);
    process.exit(2);
  }
  const result = await mod.run(ctx);
  console.log('[harness] PASS ' + JSON.stringify(result ?? {}));
  process.exit(0);
} catch (e) {
  console.error('[harness] FAIL ' + (e?.stack || e?.message || String(e)));
  process.exit(1);
}
