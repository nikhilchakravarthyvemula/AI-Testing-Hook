import test from 'node:test';
import assert from 'node:assert/strict';

import { validatePlan, countMutations, allScenarios } from './plan-schema.mjs';

function validPlan(runId = 'run-1') {
  return {
    runId,
    createdAt: '2026-07-17T09:15:00.000Z',
    source: 'llm',
    features: [{
      featureId: 'feat:checkout',
      name: 'Checkout',
      scenarios: [
        {
          scenarioId: 'sc-1', title: 'cart survives login redirect', kind: 'ui',
          intent: 'the cart contents persist across the login round-trip',
          mutation: false, priority: 1,
          targets: { endpoints: ['GET /api/v2/cart'], pages: ['/cart'] },
          gapRefs: ['gap:untested:GET /api/v2/cart'],
        },
        {
          scenarioId: 'sc-2', title: 'create an order', kind: 'api',
          intent: 'posting a valid cart creates an order',
          mutation: true, priority: 2,
          targets: { endpoints: ['POST /api/v2/orders'] },
        },
      ],
    }],
    estimates: { scenarios: 2, llmRequests: 4 },
  };
}

const pathsOf = (errors) => errors.map((e) => e.path);

test('a well-formed plan validates', () => {
  const { valid, errors } = validatePlan(validPlan(), { runId: 'run-1' });
  assert.deepEqual(errors, []);
  assert.equal(valid, true);
});

test('rejects a plan belonging to a different run', () => {
  const { valid, errors } = validatePlan(validPlan('someone-elses-run'), { runId: 'run-1' });
  assert.equal(valid, false);
  assert.ok(pathsOf(errors).includes('/runId'));
  assert.match(errors[0].message, /this run is "run-1"/);
});

test('a missing mutation flag is an error, not a default', () => {
  // The flag decides whether a scenario may write to a live app. Guessing it is
  // exactly the thing the checkpoint exists to prevent.
  const plan = validPlan();
  delete plan.features[0].scenarios[1].mutation;
  const { valid, errors } = validatePlan(plan, { runId: 'run-1' });
  assert.equal(valid, false);
  assert.ok(pathsOf(errors).includes('/features/0/scenarios/1/mutation'));
});

test('rejects duplicate scenarioIds', () => {
  const plan = validPlan();
  plan.features[0].scenarios[1].scenarioId = 'sc-1';
  const { valid, errors } = validatePlan(plan, { runId: 'run-1' });
  assert.equal(valid, false);
  assert.match(errors.find((e) => e.path.endsWith('/scenarioId')).message, /duplicate/);
});

test('rejects a scenario with no target', () => {
  const plan = validPlan();
  plan.features[0].scenarios[0].targets = { endpoints: [], pages: [] };
  const { valid, errors } = validatePlan(plan, { runId: 'run-1' });
  assert.equal(valid, false);
  assert.ok(pathsOf(errors).includes('/features/0/scenarios/0/targets'));
});

test('rejects an unknown kind', () => {
  const plan = validPlan();
  plan.features[0].scenarios[0].kind = 'chaos';
  const { valid } = validatePlan(plan, { runId: 'run-1' });
  assert.equal(valid, false);
});

test('reports every error at once, with findable paths', () => {
  // The operator is in $EDITOR — one error per round-trip would be miserable.
  const plan = validPlan();
  delete plan.features[0].scenarios[0].title;
  plan.features[0].scenarios[1].kind = 'nope';
  plan.estimates = {};
  const { errors } = validatePlan(plan, { runId: 'run-1' });
  assert.ok(errors.length >= 4);
  assert.ok(pathsOf(errors).includes('/features/0/scenarios/0/title'));
  assert.ok(pathsOf(errors).includes('/features/0/scenarios/1/kind'));
});

test('non-object plans fail cleanly rather than throwing', () => {
  for (const junk of [null, 42, 'a string', []]) {
    const { valid, errors } = validatePlan(junk);
    assert.equal(valid, false);
    assert.equal(errors.length, 1);
  }
});

test('countMutations fails safe on a malformed flag', () => {
  // Validation rejects this, but if it ever slips through, the number the
  // operator approves must over-report risk, never under-report it.
  const plan = validPlan();
  delete plan.features[0].scenarios[0].mutation;   // unknown → counts as mutation
  assert.equal(countMutations(plan), 2);
  assert.equal(allScenarios(plan).length, 2);
});

test('countMutations counts only explicit false as safe', () => {
  assert.equal(countMutations(validPlan()), 1);
});
