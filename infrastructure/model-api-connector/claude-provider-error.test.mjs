// Error-path contract tests for the `claude` provider — p0-02 §4 item 4:
// "engine-down returns engine-unavailable (never throws / never hangs past
// timeout)". Unlike claude-provider.test.mjs (opt-in, needs real credentials,
// only exercises the happy path), these run always, need no credentials, and
// drive the actual failure branches in providers/claude.mjs: a non-zero exit,
// a hang past the timeout, unparseable stdout, an in-band API error, a wrong
// subtype, and a missing binary.
//
// Each test swaps CLAUDE_BIN for a tiny fake script and calls _resetProviders()
// first — the seam complete.mjs already exposes for exactly this ("drop
// memoized providers after changing CLAUDE_BIN"). Going through complete()
// rather than calling createClaudeProvider() directly also proves the failure
// propagates all the way to the shape S1/S2/S4 callers actually depend on,
// ledger line included.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { complete, _resetProviders } from './complete.mjs';
import { readLedger } from './ledger.mjs';

function setup(t) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'c2-claude-err-'));
  fs.writeFileSync(path.join(ws, 'ledger.jsonl'), '');
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c2-claude-bin-'));
  const prevBin = process.env.CLAUDE_BIN;

  t.after(() => {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
    if (prevBin === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = prevBin;
    _resetProviders();
  });

  return { ws, binDir };
}

/** Write a fake `claude` binary that ignores argv/stdin and runs `body`. */
function fakeBin(binDir, body) {
  const p = path.join(binDir, 'fake-claude.mjs');
  fs.writeFileSync(p, `#!/usr/bin/env node\n${body}\n`);
  fs.chmodSync(p, 0o755);
  return p;
}

function useFakeBin(binDir, body) {
  process.env.CLAUDE_BIN = fakeBin(binDir, body);
  _resetProviders();
}

// ── the failure branches ─────────────────────────────────────────────────────

test('a non-zero exit is engine-unavailable, not a throw — and still ledgered', async (t) => {
  const { ws, binDir } = setup(t);
  useFakeBin(binDir, `
    process.stderr.write('simulated crash: model unreachable');
    process.exit(2);
  `);

  const r = await complete({ useCase: 'S4', provider: 'claude', workspace: ws, prompt: 'hi' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'engine-unavailable');
  assert.match(r.detail, /exited 2/);
  assert.match(r.detail, /simulated crash/);

  const lines = readLedger(ws);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].degraded, true);
  assert.equal(lines[0].requests, 1);
});

test('a hung engine is killed and reported engine-unavailable — never hangs past the timeout', async (t) => {
  const { ws, binDir } = setup(t);
  // Never exits on its own; only spawnSync's timeout ends it.
  useFakeBin(binDir, `setTimeout(() => {}, 10_000);`);

  const startedAt = Date.now();
  const r = await complete({
    useCase: 'S4', provider: 'claude', workspace: ws, prompt: 'hi', timeoutMs: 300,
  });
  const elapsed = Date.now() - startedAt;

  assert.equal(r.ok, false);
  assert.equal(r.error, 'engine-unavailable');
  assert.match(r.detail, /timed out after 300ms/);
  assert.ok(elapsed < 5000, `should not wait anywhere near the fake process's 10s sleep (took ${elapsed}ms)`);
});

test('output that is not JSON is engine-unavailable, not a throw', async (t) => {
  const { ws, binDir } = setup(t);
  useFakeBin(binDir, `process.stdout.write('not json at all {{{');`);

  const r = await complete({ useCase: 'S4', provider: 'claude', workspace: ws, prompt: 'hi' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'engine-unavailable');
  assert.match(r.detail, /could not parse/);
});

test('an in-band API error (exit 0, is_error:true) is engine-unavailable', async (t) => {
  const { ws, binDir } = setup(t);
  useFakeBin(binDir, `
    process.stdout.write(JSON.stringify({ is_error: true, subtype: 'error', api_error_status: 529 }));
  `);

  const r = await complete({ useCase: 'S4', provider: 'claude', workspace: ws, prompt: 'hi' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'engine-unavailable');
  assert.match(r.detail, /529/);
});

test('a wrong subtype without is_error is still treated as unavailable', async (t) => {
  const { ws, binDir } = setup(t);
  useFakeBin(binDir, `
    process.stdout.write(JSON.stringify({ is_error: false, subtype: 'error_max_turns' }));
  `);

  const r = await complete({ useCase: 'S4', provider: 'claude', workspace: ws, prompt: 'hi' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'engine-unavailable');
  assert.match(r.detail, /error_max_turns/);
});

test('a missing binary is engine-unavailable, not a throw', async (t) => {
  const { ws } = setup(t);
  process.env.CLAUDE_BIN = '/definitely/not/a/real/path/claude';
  _resetProviders();

  const r = await complete({ useCase: 'S4', provider: 'claude', workspace: ws, prompt: 'hi' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'engine-unavailable');
  // spawnSync does not throw for a bad path — it sets r.error with code ENOENT,
  // which claude.mjs's `if (r.error)` branch reports directly (not the try/catch
  // around spawnSync itself, which is for spawnSync throwing outright).
  assert.match(r.detail, /ENOENT/);
});

// ── sanity check the fake-bin harness itself against the happy path ───────────

test('a well-formed success response is parsed correctly, preferring the alias model id', async (t) => {
  const { ws, binDir } = setup(t);
  useFakeBin(binDir, `
    process.stdout.write(JSON.stringify({
      is_error: false,
      subtype: 'success',
      result: 'pong',
      modelUsage: { 'claude-haiku-4-5': {}, 'claude-haiku-4-5-20251001': {} },
      usage: { input_tokens: 12, output_tokens: 3 },
    }));
  `);

  const r = await complete({ useCase: 'S4', provider: 'claude', workspace: ws, prompt: 'hi' });
  assert.equal(r.ok, true, r.detail);
  assert.equal(r.text, 'pong');
  assert.equal(r.model, 'claude-haiku-4-5');
  assert.equal(r.usage.inputTokens, 12);
  assert.equal(r.usage.outputTokens, 3);
});
