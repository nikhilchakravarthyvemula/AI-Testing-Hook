// The per-scenario template generator — C6's deterministic fallback (p0-06 §3).
//
// When a session can't produce a scenario's file (engine down, honesty failure,
// budget spent), we still owe the plan one runnable test per scenario. These are
// the honest floor: self-contained, dependency-free `.mjs` smoke tests that hit
// only the scenario's stored targets. They are mode-BLIND — mutation scenarios
// get a file too; whether it actually runs is the executor's call in safe mode
// (p0-07), never the generator's.
//
// A template file is the same shape a session file is expected to be: a `run()`
// export the executor drives, plus a `scenario` metadata block, under the header
// comment convention every generated file carries. Kept fetch-based (no
// Playwright import) so the floor needs nothing installed and parse-checks clean.

import fs from 'node:fs';
import path from 'node:path';

/**
 * Write one template test file for a scenario.
 *
 * @returns {string} the workspace-relative path written (tests/<featureId>/<scenarioId>.spec.mjs)
 */
export function writeTemplateFile(workspace, featureId, scenario, runId) {
  const dir = path.join(workspace, 'tests', featureId);
  fs.mkdirSync(dir, { recursive: true });
  const rel = path.join('tests', featureId, `${scenario.scenarioId}.spec.mjs`);
  fs.writeFileSync(path.join(workspace, rel), renderTemplate(scenario, { featureId, runId }));
  return rel;
}

/** The file body — deterministic given the scenario. */
export function renderTemplate(scenario, { featureId, runId }) {
  const endpoints = scenario.targets?.endpoints ?? [];
  const pages = scenario.targets?.pages ?? [];
  const meta = {
    id: scenario.scenarioId,
    feature: featureId,
    kind: scenario.kind,
    mutation: Boolean(scenario.mutation),
    targets: { endpoints, pages },
  };

  return `// run: ${runId ?? '(run)'}  scenario: ${scenario.scenarioId}  generator: template
// ${scenario.title}
// intent: ${scenario.intent}
// kind: ${scenario.kind}  mutation: ${Boolean(scenario.mutation)}
//
// Deterministic template scaffold (the S1/A1 fallback, p0-06 §3). Self-contained
// and dependency-free: a smoke check against the scenario's stored targets. The
// executor (p0-07) supplies baseUrl and decides whether a mutation runs.

export const scenario = ${JSON.stringify(meta, null, 2)};

const ENDPOINTS = ${JSON.stringify(endpoints)};
const PAGES = ${JSON.stringify(pages)};

/**
 * Smoke-exercise every stored target. Returns per-target checks; throws on a
 * hard transport error so the runner records a failure.
 */
export async function run({ baseUrl = process.env.BASE_URL } = {}) {
  if (!baseUrl) throw new Error('template test needs a baseUrl (BASE_URL)');
  const base = baseUrl.replace(/\\/+$/, '');
  const checks = [];

  for (const ep of ENDPOINTS) {
    const sp = ep.indexOf(' ');
    const method = sp > 0 ? ep.slice(0, sp) : 'GET';
    const rawPath = sp > 0 ? ep.slice(sp + 1) : ep;
    // A path template may carry {params}; a smoke test can't invent values, so
    // parameterised endpoints are recorded as skipped rather than guessed.
    if (/[{:]/.test(rawPath)) { checks.push({ target: ep, status: 'skipped-parameterised' }); continue; }
    const res = await fetch(base + rawPath, { method, redirect: 'manual' });
    checks.push({ target: ep, httpStatus: res.status, ok: res.status < 500 });
  }

  for (const pg of PAGES) {
    const res = await fetch(base + pg, { method: 'GET', redirect: 'manual' });
    checks.push({ target: pg, httpStatus: res.status, ok: res.status < 500 });
  }

  const failed = checks.filter((c) => c.ok === false);
  if (failed.length) {
    throw new Error(\`\${failed.length} target(s) returned 5xx: \${failed.map((c) => c.target).join(', ')}\`);
  }
  return { scenarioId: scenario.id, checks };
}
`;
}
