// Live agent-session check — OPT-IN (ENGINE_LIVE_TEST=1).
//
// Proves the whole C2b path end to end through runSession(): the real `claude`
// CLI, a real stdio MCP server, a real slice → real test files in the workspace,
// honesty rule satisfied. This is the evidence behind "OQ-4: C2b is Node".
//
//   ENGINE_LIVE_TEST=1 node --test infrastructure/model-api-connector/session-live.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runSession } from './session.mjs';
import { readLedger } from './ledger.mjs';

const LIVE = process.env.ENGINE_LIVE_TEST === '1';
const MODEL = process.env.ENGINE_LIVE_MODEL || 'claude-haiku-4-5';

// A minimal stdio MCP server exposing get_feature_context with canned data —
// the same shape the real context-server (C4) will serve.
const MCP_SERVER = `
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const TOOL = { name: 'get_feature_context', description: 'Feature context.',
  inputSchema: { type: 'object', properties: { feature: { type: 'string' } }, required: ['feature'] } };
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg; try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (method === 'initialize') send({ jsonrpc: '2.0', id, result: {
    protocolVersion: params?.protocolVersion || '2024-11-05',
    capabilities: { tools: {} }, serverInfo: { name: 'ctx', version: '0.0.1' } } });
  else if (method === 'tools/list') send({ jsonrpc: '2.0', id, result: { tools: [TOOL] } });
  else if (method === 'tools/call') send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text',
    text: JSON.stringify({ feature: params?.arguments?.feature, endpoints: ['GET /api/v2/cart'], pages: ['/cart'], gaps: [] }) }] } });
  else if (method && method.startsWith('notifications/')) { /* no response */ }
  else if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'not found' } });
});
`;

function liveEnv(t) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'c2b-live-'));
  fs.writeFileSync(path.join(ws, 'ledger.jsonl'), '');
  const serverPath = path.join(ws, 'ctx-server.mjs');
  fs.writeFileSync(serverPath, MCP_SERVER);
  const mcpConfigPath = path.join(ws, 'mcp-config.json');
  fs.writeFileSync(mcpConfigPath, JSON.stringify({
    mcpServers: { 'context-server': { command: 'node', args: [serverPath] } },
  }));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  return { ws, mcpConfigPath };
}

test('a real claude session reads MCP context and writes a test file', { skip: !LIVE }, async (t) => {
  const { ws, mcpConfigPath } = liveEnv(t);
  const slice = {
    featureId: 'feat-checkout', name: 'Checkout',
    scenarios: [{
      scenarioId: 'sc-cart-loads', title: 'the cart page loads', kind: 'ui',
      intent: 'the cart page renders without error', mutation: false,
      targets: { pages: ['/cart'] },
    }],
  };

  const r = await runSession({
    workspace: ws, slice, mcpConfigPath, runId: 'live-1',
    provider: 'claude', model: MODEL, maxRequests: 200,
  });

  assert.equal(r.ok, true, r.detail);
  assert.ok(r.filesWritten.length >= 1, 'the session must produce at least one file');

  // The file really exists in the workspace, under the feature dir.
  const produced = path.join(ws, r.filesWritten[0]);
  assert.ok(fs.existsSync(produced), `expected ${produced} to exist`);
  assert.match(r.filesWritten[0], /^tests\/feat-checkout\//);

  // It was ledgered as real A1 work.
  const a1 = readLedger(ws).find((e) => e.useCase === 'A1');
  assert.ok(a1 && a1.requests >= 1);
  assert.match(r.model, /claude/);
});
