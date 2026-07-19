// test-plan.json validation (docs/specs/p0-00-overview.md §6).
//
// The plan is the one artifact a human reviews before anything touches the
// target app, and the checkpoint lets them EDIT it in $EDITOR. So this
// validator has two jobs, and the second is the important one:
//
//   1. catch a malformed plan from the plan-creator (C5), and
//   2. catch a hand-edit that broke something, and say exactly what — with a
//      path the operator can find in the file.
//
// Hand-rolled rather than a JSON Schema dependency: the repo is deliberately
// dependency-light, the shape is small, and error messages we author ourselves
// read better than a generic validator's at 11pm.

const KINDS = new Set(['api', 'ui', 'perf']);
const SOURCES = new Set(['llm', 'template']);

/**
 * @param {unknown} plan
 * @param {{ runId?: string }} [expect]
 * @returns {{ valid: boolean, errors: Array<{path: string, message: string}> }}
 */
export function validatePlan(plan, expect = {}) {
  const errors = [];
  const err = (path, message) => errors.push({ path, message });

  if (!isObject(plan)) {
    return { valid: false, errors: [{ path: '/', message: 'plan must be a JSON object' }] };
  }

  // ── envelope ─────────────────────────────────────────────────────────────
  if (!isNonEmptyString(plan.runId)) err('/runId', 'must be a non-empty string');
  else if (expect.runId && plan.runId !== expect.runId) {
    // Guards against approving a plan that belongs to a different run — an easy
    // mistake once there are several run dirs and one $EDITOR window.
    err('/runId', `belongs to run "${plan.runId}" but this run is "${expect.runId}"`);
  }

  if (!isIsoDate(plan.createdAt)) err('/createdAt', 'must be an ISO 8601 timestamp');
  if (!SOURCES.has(plan.source)) err('/source', `must be one of: ${[...SOURCES].join(' | ')}`);

  // ── features ─────────────────────────────────────────────────────────────
  if (!Array.isArray(plan.features)) {
    err('/features', 'must be an array');
  } else {
    const seenScenarioIds = new Set();
    const seenFeatureIds = new Set();

    plan.features.forEach((feature, fi) => {
      const fPath = `/features/${fi}`;
      if (!isObject(feature)) { err(fPath, 'must be an object'); return; }

      if (!isNonEmptyString(feature.featureId)) err(`${fPath}/featureId`, 'must be a non-empty string');
      else if (seenFeatureIds.has(feature.featureId)) err(`${fPath}/featureId`, `duplicate featureId "${feature.featureId}"`);
      else seenFeatureIds.add(feature.featureId);

      if (!isNonEmptyString(feature.name)) err(`${fPath}/name`, 'must be a non-empty string');

      if (!Array.isArray(feature.scenarios)) {
        err(`${fPath}/scenarios`, 'must be an array');
        return;
      }

      feature.scenarios.forEach((sc, si) => {
        const sPath = `${fPath}/scenarios/${si}`;
        if (!isObject(sc)) { err(sPath, 'must be an object'); return; }

        if (!isNonEmptyString(sc.scenarioId)) err(`${sPath}/scenarioId`, 'must be a non-empty string');
        else if (seenScenarioIds.has(sc.scenarioId)) {
          // scenarioId keys the manifest and results — duplicates would make
          // two different tests indistinguishable in the report.
          err(`${sPath}/scenarioId`, `duplicate scenarioId "${sc.scenarioId}"`);
        } else seenScenarioIds.add(sc.scenarioId);

        if (!isNonEmptyString(sc.title)) err(`${sPath}/title`, 'must be a non-empty string');
        if (!isNonEmptyString(sc.intent)) err(`${sPath}/intent`, 'must be a non-empty string');
        if (!KINDS.has(sc.kind)) err(`${sPath}/kind`, `must be one of: ${[...KINDS].join(' | ')}`);

        // Not defaulted on purpose. `mutation` decides whether this scenario is
        // allowed to write to the target app; a missing flag is a question, and
        // the operator should answer it rather than have us guess. (countMutations
        // below still fails safe for anything that slips past validation.)
        if (typeof sc.mutation !== 'boolean') {
          err(`${sPath}/mutation`, 'must be a boolean — it decides whether this scenario may write to the target');
        }

        if (!Number.isFinite(sc.priority)) err(`${sPath}/priority`, 'must be a number');

        if (!isObject(sc.targets)) {
          err(`${sPath}/targets`, 'must be an object with endpoints[] and/or pages[]');
        } else {
          for (const key of ['endpoints', 'pages']) {
            if (sc.targets[key] === undefined) continue;
            if (!Array.isArray(sc.targets[key]) || !sc.targets[key].every(isNonEmptyString)) {
              err(`${sPath}/targets/${key}`, 'must be an array of non-empty strings');
            }
          }
          const endpoints = sc.targets.endpoints ?? [];
          const pages = sc.targets.pages ?? [];
          if (endpoints.length === 0 && pages.length === 0) {
            err(`${sPath}/targets`, 'needs at least one endpoint or page — a scenario with no target cannot be generated or run');
          }
        }

        if (sc.gapRefs !== undefined &&
            (!Array.isArray(sc.gapRefs) || !sc.gapRefs.every(isNonEmptyString))) {
          err(`${sPath}/gapRefs`, 'must be an array of non-empty strings');
        }
      });
    });
  }

  // ── estimates ────────────────────────────────────────────────────────────
  if (!isObject(plan.estimates)) {
    err('/estimates', 'must be an object with scenarios and llmRequests');
  } else {
    if (!Number.isFinite(plan.estimates.scenarios)) err('/estimates/scenarios', 'must be a number');
    if (!Number.isFinite(plan.estimates.llmRequests)) err('/estimates/llmRequests', 'must be a number');
  }

  return { valid: errors.length === 0, errors };
}

// ── derived counts (used by the checkpoint summary) ────────────────────────

export function allScenarios(plan) {
  return (plan.features ?? []).flatMap((f) => f.scenarios ?? []);
}

/**
 * Count mutating scenarios, failing SAFE.
 *
 * Anything that isn't explicitly `false` counts as a mutation. Validation
 * already rejects a missing flag, but this is the number the operator sees
 * before approving a run against a live app — if the two rules ever disagree,
 * the summary should over-report risk, never under-report it.
 */
export function countMutations(plan) {
  return allScenarios(plan).filter((sc) => sc?.mutation !== false).length;
}

export function formatErrors(errors) {
  return errors.map((e) => `  ${e.path}\n      ${e.message}`).join('\n');
}

// ── tiny predicates ────────────────────────────────────────────────────────

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function isIsoDate(v) {
  return isNonEmptyString(v) && !Number.isNaN(Date.parse(v));
}
