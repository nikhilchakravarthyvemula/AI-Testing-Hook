// Real-stdio smoke test — OPT-IN (MCP_STDIO_TEST=1).
//
// The in-process server.test.mjs proves the tool logic over an InMemoryTransport.
// THIS one is the acceptance #2/#4 evidence: it spawns server.mjs as a real
// subprocess (exactly the mcpServerConfig() launch line the generate stage will
// write) and talks to it over real stdio pipes — proving the CLI bootstrap,
// --workspace parsing, boot-time store load, and stdio framing, and that boot +
// handshake land well under the 1s budget.
//
//   MCP_STDIO_TEST=1 node --test context-layer/context-server/server-stdio.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { buildStore } from '../knowledge-store/build.mjs';
import { mcpServerConfig } from './server.mjs';

const RUN = process.env.MCP_STDIO_TEST === '1';

test('server.mjs boots as a subprocess and serves over real stdio (acceptance 2 & 4)', { skip: !RUN }, async (t) => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-stdio-'));
  fs.writeFileSync(path.join(ws, 'ledger.jsonl'), '');
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));

  const c = path.join(ws, 'context');
  const cart = { factId: 'endpoint::GET::same-origin::/api/v2/cart', kind: 'endpoint',
    key: { method: 'GET', originKey: 'same-origin', pathTemplate: '/api/v2/cart' },
    confidence: 0.9, observations: [], provenance: { families: [{ class: 'runtime' }], corroborationCount: 1 } };
  for (const [sub, name, key, arr] of [
    ['synthesized', 'facts.json', 'facts', [cart]],
    ['gaps', 'gaps.json', 'gaps', []],
    ['features', 'features.json', 'features', [{ featureId: 'feat:checkout', name: 'Checkout', members: { endpoints: [cart.factId] } }]],
  ]) {
    fs.mkdirSync(path.join(c, sub), { recursive: true });
    fs.writeFileSync(path.join(c, sub, name),
      JSON.stringify({ generatedAt: '2026-07-19T00:00:00Z', target: { baseUrl: 'https://app.example.com' }, [key]: arr }));
  }
  await buildStore({ workspace: ws, runId: 'stdio-run', target: { url: 'https://app.example.com', profile: 'url+code' },
    engine: { provider: 'mock', maxRequests: 200 } });

  const cfg = mcpServerConfig(ws);
  const t0 = Date.now();
  const transport = new StdioClientTransport({ command: cfg.command, args: cfg.args });
  const client = new Client({ name: 'stdio-test', version: '0' });
  await client.connect(transport);
  t.after(() => client.close());
  assert.ok(Date.now() - t0 < 1000, 'boot + handshake within the 1s budget');

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((x) => x.name).sort(),
    ['get_feature_context', 'list_features', 'list_gaps', 'query_endpoints']);

  const res = await client.callTool({ name: 'get_feature_context', arguments: { feature: 'Checkout' } });
  const p = JSON.parse(res.content[0].text);
  assert.equal(p.runId, 'stdio-run');
  assert.deepEqual(p.context.endpoints.map((e) => e.path), ['/api/v2/cart']);
});
