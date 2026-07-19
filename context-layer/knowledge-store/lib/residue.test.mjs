import test from 'node:test';
import assert from 'node:assert/strict';

import { isInstanceOf, candidatePairs } from './residue.mjs';

// ── isInstanceOf — the precision-critical predicate ──────────────────────────

test('a concrete path is an instance of its template', () => {
  // The real logtrim case: the crawl hit a concrete value, the spec declares {id}.
  assert.equal(isInstanceOf('/agent/get-agent-by-name/Resume%20Analysis', '/agent/get-agent-by-name/{id}'), true);
  assert.equal(isInstanceOf('/users/Alice', '/users/{id}'), true);
  assert.equal(isInstanceOf('/a/1/b/2', '/a/{x}/b/{y}'), true);
});

test('a template is NOT an instance of a concrete path (direction matters)', () => {
  assert.equal(isInstanceOf('/users/{id}', '/users/Alice'), false);
});

test('identical templates are not "instances" (nothing differs)', () => {
  assert.equal(isInstanceOf('/users/{id}', '/users/{id}'), false);
});

test('param-rename counts only when something concrete also differs', () => {
  // Same shape, only the param NAME differs → no concrete difference → not flagged
  // here (canonicalization should already have merged these; if not, harmless).
  assert.equal(isInstanceOf('/users/{id}', '/users/{userId}'), false);
});

test('different literals never match — the false-positive guard', () => {
  assert.equal(isInstanceOf('/users/1', '/accounts/{id}'), false);
  assert.equal(isInstanceOf('/a/1', '/b/{id}'), false);
});

test('the classic cross-shape trap does not match either direction', () => {
  // /a/{id} vs /{x}/b — a naive "one side is a param" rule pairs these; ours must not.
  assert.equal(isInstanceOf('/a/x', '/{x}/b'), false);
  assert.equal(isInstanceOf('/x/b', '/a/{id}'), false);
});

test('different lengths never match', () => {
  assert.equal(isInstanceOf('/a/b', '/a/{id}/c'), false);
});

test('supports :param syntax too', () => {
  assert.equal(isInstanceOf('/users/Alice', '/users/:id'), true);
});

// ── candidatePairs — bucketing + orientation ─────────────────────────────────

const ep = (method, pathTemplate, extra = {}) => ({
  factId: `endpoint::${method}::same-origin::${pathTemplate}`,
  kind: 'endpoint',
  key: { method, originKey: 'same-origin', pathTemplate },
  ...extra,
});

test('pairs a concrete endpoint with its template, oriented correctly', () => {
  const facts = [
    ep('GET', '/agent/get-agent-by-name/Resume%20Analysis'),
    ep('GET', '/agent/get-agent-by-name/{id}'),
  ];
  const pairs = candidatePairs(facts);
  assert.equal(pairs.length, 1);
  assert.match(pairs[0].concrete.key.pathTemplate, /Resume%20Analysis/);
  assert.match(pairs[0].template.key.pathTemplate, /\{id\}/);
});

test('does not pair across methods or origins', () => {
  assert.equal(candidatePairs([
    ep('GET', '/users/Alice'),
    ep('POST', '/users/{id}'),
  ]).length, 0);

  assert.equal(candidatePairs([
    { ...ep('GET', '/users/Alice'), key: { method: 'GET', originKey: 'a', pathTemplate: '/users/Alice' } },
    { ...ep('GET', '/users/{id}'), key: { method: 'GET', originKey: 'b', pathTemplate: '/users/{id}' } },
  ]).length, 0);
});

test('does not pair genuinely different endpoints of the same shape', () => {
  assert.equal(candidatePairs([
    ep('GET', '/agent/{id}/field'),
    ep('GET', '/agent/{id}/runs'),
  ]).length, 0);
});

test('skips facts with no usable key, does not throw', () => {
  const pairs = candidatePairs([
    ep('GET', '/users/Alice'),
    { factId: 'weird', kind: 'endpoint' },          // no key
    ep('GET', '/users/{id}'),
  ]);
  assert.equal(pairs.length, 1);
});
