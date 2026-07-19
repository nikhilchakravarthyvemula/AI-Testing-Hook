// Live `claude` provider check — OPT-IN.
//
// Skipped unless ENGINE_LIVE_TEST=1, because it spawns the real `claude` CLI and
// costs a subscription request. CI stays credential-free; a human runs this to
// confirm the provider still speaks the CLI's actual dialect after a CLI upgrade.
//
//   ENGINE_LIVE_TEST=1 node --test infrastructure/model-api-connector/claude-provider.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { complete } from './complete.mjs';

const LIVE = process.env.ENGINE_LIVE_TEST === '1';
const MODEL = process.env.ENGINE_LIVE_MODEL || 'claude-haiku-4-5';

function ws(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c2-live-'));
  fs.writeFileSync(path.join(dir, 'ledger.jsonl'), '');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('claude text completion returns real content + token usage', { skip: !LIVE }, async (t) => {
  const r = await complete({
    useCase: 'S4', provider: 'claude', model: MODEL, workspace: ws(t),
    system: 'Reply with exactly one word and nothing else.',
    prompt: 'Reply with the single word: pong',
  });
  assert.equal(r.ok, true, r.detail);
  assert.match(r.text.toLowerCase(), /pong/);
  assert.ok(r.usage.inputTokens > 0 && r.usage.outputTokens > 0, 'usage should be populated');
  assert.equal(r.usage.requests, 1);
  assert.match(r.model, /claude/);
});

test('claude schema completion returns conforming json', { skip: !LIVE }, async (t) => {
  const r = await complete({
    useCase: 'S2', provider: 'claude', model: MODEL, workspace: ws(t),
    prompt: 'Are "GET /users/{id}" and "GET /users/:id" the same REST endpoint?',
    schema: {
      type: 'object',
      properties: { same: { type: 'boolean' }, confidence: { type: 'number' } },
      required: ['same', 'confidence'],
      additionalProperties: false,
    },
  });
  assert.equal(r.ok, true, r.detail);
  assert.equal(typeof r.json.same, 'boolean');
  assert.equal(r.json.same, true, 'these two ARE the same endpoint');
  assert.equal(typeof r.json.confidence, 'number');
});
