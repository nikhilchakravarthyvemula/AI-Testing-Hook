// C4 context-server tests. We build a REAL store with C3's buildStore (so this
// also exercises the C3→C4 seam), stand the server up over an in-memory
// transport, and drive it with a real MCP Client — the same mechanism a live
// `claude` session uses over stdio.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { buildStore } from '../knowledge-store/build.mjs';
import { openStore } from '../knowledge-store/store.mjs';
import { createContextServer, mcpServerConfig, writeMcpConfig } from './server.mjs';

// ── fixture: a small run workspace with a built store ────────────────────────

function writeContext(ws, { facts, gaps, features }) {
  const c = path.join(ws, 'context');
  for (const [sub, name, arrKey, arr] of [
    ['synthesized', 'facts.json', 'facts', facts],
    ['gaps', 'gaps.json', 'gaps', gaps],
    ['features', 'features.json', 'features', features],
  ]) {
    fs.mkdirSync(path.join(c, sub), { recursive: true });
    fs.writeFileSync(path.join(c, sub, name),
      JSON.stringify({ generatedAt: '2026-07-19T00:00:00Z', target: { baseUrl: 'https://app.example.com' }, [arrKey]: arr }));
  }
}

const ep = (method, p, extra = {}) => ({
  factId: `endpoint::${method}::same-origin::${p}`, kind: 'endpoint',
  key: { method, originKey: 'same-origin', pathTemplate: p },
  confidence: extra.confidence ?? 0.9, observations: [],
  provenance: { families: [{ class: 'runtime' }], corroborationCount: 1 }, ...extra,
});
const page = (p) => ({ factId: `page::${p}`, kind: 'page', key: { pathTemplate: p }, confidence: 0.9, provenance: {} });

// Two features so filtering is meaningful. Checkout has 2 endpoints + 1 page + 1 gap.
async function buildFixture(t) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-'));
  fs.writeFileSync(path.join(ws, 'ledger.jsonl'), '');
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));

  const cart = ep('GET', '/api/v2/cart');
  const orders = ep('POST', '/api/v2/orders', { confidence: 0.75 });
  const cartPage = page('/cart');
  const login = ep('POST', '/api/v2/login');

  writeContext(ws, {
    facts: [cart, orders, cartPage, login],
    gaps: [
      { gapId: 'g1', type: 'untested-endpoint', severity: 'high', priority: 0.9, subject: { factId: orders.factId } },
      { gapId: 'g2', type: 'untested-endpoint', severity: 'low', priority: 0.2, subject: { factId: login.factId } },
    ],
    features: [
      { featureId: 'feat:checkout', name: 'Checkout', members: { endpoints: [cart.factId, orders.factId], pages: [cartPage.factId] } },
      { featureId: 'feat:auth', name: 'Auth', members: { endpoints: [login.factId] } },
    ],
  });

  const r = await buildStore({ workspace: ws, runId: 'run-c4', target: { url: 'https://app.example.com', profile: 'url+code' },
    engine: { provider: 'mock', maxRequests: 200 } });
  assert.equal(r.ok, true);
  return ws;
}

/** Stand the server up over an in-memory transport and return a connected client. */
async function connect(t, ws) {
  const api = openStore(ws);
  const server = createContextServer(api);
  const [sT, cT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(sT), client.connect(cT)]);
  t.after(() => client.close());
  return { client, api };
}

/** The JSON payload inside a (non-error) tool result. */
function payload(res) {
  assert.ok(!res.isError, `expected ok result, got isError: ${res.content?.[0]?.text}`);
  return JSON.parse(res.content[0].text);
}

// ── tools present ────────────────────────────────────────────────────────────

test('lists exactly the four spec tools', async (t) => {
  const ws = await buildFixture(t);
  const { client } = await connect(t, ws);
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((x) => x.name).sort(),
    ['get_feature_context', 'list_features', 'list_gaps', 'query_endpoints'],
  );
  // Each advertises a JSON-Schema object input.
  for (const x of tools) assert.equal(x.inputSchema.type, 'object');
});

// ── acceptance 1: byte-for-byte parity with store.mjs ────────────────────────

test('get_feature_context matches store.featureContext() byte-for-byte (acceptance 1)', async (t) => {
  const ws = await buildFixture(t);
  const { client, api } = await connect(t, ws);

  const res = await client.callTool({ name: 'get_feature_context', arguments: { feature: 'Checkout' } });
  const p = payload(res);

  // The composite the MCP tool serves IS what the pure accessor returns.
  assert.deepEqual(p.context, api.featureContext('Checkout'));
  // …and it's wrapped in the run envelope.
  assert.equal(p.runId, 'run-c4');
  assert.equal(p.truncated, false);
  assert.match(p.servedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('get_feature_context resolves by id as well as name', async (t) => {
  const ws = await buildFixture(t);
  const { client, api } = await connect(t, ws);
  const byId = payload(await client.callTool({ name: 'get_feature_context', arguments: { feature: 'feat:checkout' } }));
  assert.deepEqual(byId.context, api.featureContext('feat:checkout'));
  assert.equal(byId.context.endpoints[0].confidence >= byId.context.endpoints[1].confidence, true, 'endpoints stay confidence-ranked');
});

// ── unknown feature: isError result the agent can read, NOT a thrown error ────

test('unknown feature → isError result listing valid features', async (t) => {
  const ws = await buildFixture(t);
  const { client } = await connect(t, ws);
  const res = await client.callTool({ name: 'get_feature_context', arguments: { feature: 'Nope' } });
  assert.equal(res.isError, true);
  const text = res.content[0].text;
  assert.match(text, /unknown feature "Nope"/);
  assert.match(text, /Checkout/);   // the valid-ids list is surfaced
  assert.match(text, /Auth/);
});

// ── query_endpoints / list_gaps / list_features ──────────────────────────────

test('query_endpoints filters by method and featureId, ranked', async (t) => {
  const ws = await buildFixture(t);
  const { client } = await connect(t, ws);

  const all = payload(await client.callTool({ name: 'query_endpoints', arguments: {} }));
  assert.equal(all.total, 3, 'three endpoint facts across the run (pages excluded)');

  const posts = payload(await client.callTool({ name: 'query_endpoints', arguments: { method: 'POST' } }));
  assert.deepEqual(posts.endpoints.map((e) => e.path).sort(), ['/api/v2/login', '/api/v2/orders']);

  const checkout = payload(await client.callTool({ name: 'query_endpoints', arguments: { featureId: 'feat:checkout' } }));
  assert.deepEqual(checkout.endpoints.map((e) => e.path).sort(), ['/api/v2/cart', '/api/v2/orders']);
});

test('list_gaps returns prioritized gaps, filterable by severity', async (t) => {
  const ws = await buildFixture(t);
  const { client } = await connect(t, ws);
  const all = payload(await client.callTool({ name: 'list_gaps', arguments: {} }));
  assert.deepEqual(all.gaps.map((g) => g.gapId), ['g1', 'g2'], 'sorted by priority desc');
  const high = payload(await client.callTool({ name: 'list_gaps', arguments: { severity: 'high' } }));
  assert.deepEqual(high.gaps.map((g) => g.gapId), ['g1']);
});

test('list_features is the table of contents with counts', async (t) => {
  const ws = await buildFixture(t);
  const { client } = await connect(t, ws);
  const { features } = payload(await client.callTool({ name: 'list_features', arguments: {} }));
  const checkout = features.find((f) => f.featureId === 'feat:checkout');
  assert.equal(checkout.name, 'Checkout');
  assert.equal(checkout.endpointCount, 2);
  assert.equal(checkout.pageCount, 1);
  assert.equal(checkout.gapCount, 1);
});

// ── acceptance 3: malformed input → typed error, server stays up ─────────────

test('malformed input throws a typed McpError and the server keeps serving (acceptance 3)', async (t) => {
  const ws = await buildFixture(t);
  const { client } = await connect(t, ws);

  await assert.rejects(
    client.callTool({ name: 'get_feature_context', arguments: { feature: 42 } }),
    (e) => { assert.equal(e.code, -32602); return true; },  // InvalidParams
  );
  await assert.rejects(
    client.callTool({ name: 'get_feature_context', arguments: {} }),          // missing required
    (e) => { assert.equal(e.code, -32602); return true; },
  );
  await assert.rejects(
    client.callTool({ name: 'query_endpoints', arguments: { bogus: 1 } }),    // unknown arg
    (e) => { assert.equal(e.code, -32602); return true; },
  );

  // Still up: a good call after three bad ones succeeds.
  const good = payload(await client.callTool({ name: 'get_feature_context', arguments: { feature: 'Checkout' } }));
  assert.equal(good.runId, 'run-c4');
});

// ── truncation is explicit, never silent ─────────────────────────────────────

test('maxItems caps lists and sets truncated:true', async (t) => {
  const ws = await buildFixture(t);
  const { client } = await connect(t, ws);

  const capped = payload(await client.callTool({ name: 'get_feature_context', arguments: { feature: 'Checkout', maxItems: 1 } }));
  assert.equal(capped.context.endpoints.length, 1);
  assert.equal(capped.truncated, true);

  const q = payload(await client.callTool({ name: 'query_endpoints', arguments: { maxItems: 1 } }));
  assert.equal(q.endpoints.length, 1);
  assert.equal(q.total, 3, 'total reflects the pre-cap count');
  assert.equal(q.truncated, true);
});

// ── launch descriptor uses an ABSOLUTE server path (session cwd = workspace) ──

test('mcpServerConfig / writeMcpConfig produce an absolute, resolvable launch path', async (t) => {
  const ws = await buildFixture(t);
  const cfg = mcpServerConfig(ws);
  assert.ok(path.isAbsolute(cfg.args[0]), 'server path must be absolute');
  assert.ok(fs.existsSync(cfg.args[0]), 'server path must exist');
  assert.equal(cfg.args[1], '--workspace');
  assert.ok(path.isAbsolute(cfg.args[2]), 'workspace path must be absolute');

  const p = writeMcpConfig(ws);
  const written = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.ok(written.mcpServers['context-server'].args[0].endsWith('server.mjs'));
});
