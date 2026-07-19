import test from 'node:test';
import assert from 'node:assert/strict';

import { validate, parseAndValidate, renderSchemaInstruction } from './schema.mjs';

test('validates the object subset P0 uses', () => {
  const schema = {
    type: 'object',
    properties: {
      same: { type: 'boolean' },
      confidence: { type: 'number' },
      kind: { type: 'string', enum: ['api', 'ui', 'perf'] },
    },
    required: ['same', 'confidence'],
    additionalProperties: false,
  };
  assert.deepEqual(validate({ same: true, confidence: 0.9 }, schema), []);
  assert.deepEqual(validate({ same: true, confidence: 0.5, kind: 'ui' }, schema), []);
});

test('flags a missing required property, with a path', () => {
  const schema = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] };
  const errs = validate({}, schema);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /\$\.a: required/);
});

test('flags a wrong type', () => {
  const schema = { type: 'object', properties: { n: { type: 'number' } } };
  assert.match(validate({ n: 'seven' }, schema)[0], /expected number, got string/);
});

test('enforces enum and const', () => {
  assert.match(validate('chaos', { enum: ['api', 'ui'] })[0], /must be one of/);
  assert.deepEqual(validate('api', { enum: ['api', 'ui'] }), []);
  assert.match(validate(2, { const: 1 })[0], /must equal 1/);
});

test('additionalProperties:false rejects extras', () => {
  const schema = { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false };
  assert.match(validate({ a: 'x', b: 'y' }, schema)[0], /\$\.b: unexpected/);
});

test('validates arrays item-wise', () => {
  const schema = { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } };
  assert.deepEqual(validate([{ id: 'a' }, { id: 'b' }], schema), []);
  assert.match(validate([{ id: 'a' }, {}], schema)[0], /\$\[1\]\.id: required/);
});

test('integer vs number is enforced', () => {
  assert.match(validate(1.5, { type: 'integer' })[0], /expected integer/);
  assert.deepEqual(validate(2, { type: 'integer' }), []);
});

test('parseAndValidate strips fences and reports non-JSON', () => {
  const schema = { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] };
  assert.deepEqual(parseAndValidate('```json\n{"x":1}\n```', schema), { ok: true, value: { x: 1 } });

  const bad = parseAndValidate('not json at all', schema);
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0], /not valid JSON/);
});

test('renderSchemaInstruction embeds the schema and forbids prose', () => {
  const s = renderSchemaInstruction({ type: 'object', properties: { a: { type: 'string' } } });
  assert.match(s, /ONLY a single JSON value/);
  assert.match(s, /"properties"/);
});
