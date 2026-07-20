// End-to-end execution against a REAL (local) HTTP server.
//
// Proves the whole runtime contract without any external target: a C6 template
// file (the exact generator the fallback uses) is executed by the real
// child-process runner against a live http.Server, and the pass/fail verdict
// reflects what the server actually returned. This is acceptance §4's mechanism
// (real results, real process) made deterministic; the logtrim UI+screenshots
// variant stays a manual/opt-in run since it needs a live app + login.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { runExecute } from './execute.mjs';
import { writeTemplateFile } from '../../generation-layer/test-generator/lib/template-gen.mjs';

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function workspaceFor(t, scenario) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'c7-e2e-'));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  // a real C6 template file for this scenario — the generate↔execute contract.
  writeTemplateFile(ws, scenario.featureId ?? 'feat:f', scenario, 'r1');
  const manifest = { runId: 'r1', entries: [{
    scenarioId: scenario.scenarioId, featureId: scenario.featureId ?? 'feat:f',
    file: `tests/${scenario.featureId ?? 'feat:f'}/${scenario.scenarioId}.spec.mjs`,
    kind: scenario.kind, mutation: scenario.mutation ?? false, generator: 'template', status: 'generated',
  } ] };
  const plan = { runId: 'r1', features: [{ featureId: scenario.featureId ?? 'feat:f', scenarios: [scenario] }] };
  fs.mkdirSync(path.join(ws, 'tests'), { recursive: true });
  fs.mkdirSync(path.join(ws, 'plan'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'tests', 'manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(ws, 'plan', 'test-plan.json'), JSON.stringify(plan));
  return ws;
}

const readResults = (ws) => JSON.parse(fs.readFileSync(path.join(ws, 'results', 'results.json'), 'utf8'));

test('a C6 template test passes against a healthy live server', async (t) => {
  const { server, baseUrl } = await startServer((req, res) => { res.writeHead(200); res.end('ok'); });
  t.after(() => server.close());

  const scenario = { scenarioId: 'sc-health', featureId: 'feat:f', title: 'health check', kind: 'api',
    intent: 'GET /health returns ok', mutation: false, targets: { endpoints: ['GET /health'] } };
  const ws = workspaceFor(t, scenario);

  const res = await runExecute({ workspace: ws, runId: 'r1', mode: 'safe', allowlist: new Set(),
    target: { url: baseUrl }, timeoutMs: 15_000 });
  assert.equal(res.ok, true);

  const entry = readResults(ws).entries[0];
  assert.equal(entry.status, 'passed', JSON.stringify(entry));
  assert.ok(entry.durationMs >= 0);
  assert.ok(fs.existsSync(path.join(ws, entry.artifacts.log)), 'a log artifact was collected');
});

test('a C6 template test fails when the live server errors (5xx)', async (t) => {
  const { server, baseUrl } = await startServer((req, res) => { res.writeHead(500); res.end('boom'); });
  t.after(() => server.close());

  const scenario = { scenarioId: 'sc-500', featureId: 'feat:f', title: 'health check', kind: 'api',
    intent: 'GET /health', mutation: false, targets: { endpoints: ['GET /health'] } };
  const ws = workspaceFor(t, scenario);

  await runExecute({ workspace: ws, runId: 'r1', mode: 'safe', allowlist: new Set(),
    target: { url: baseUrl }, timeoutMs: 15_000 });

  const entry = readResults(ws).entries[0];
  assert.equal(entry.status, 'failed', JSON.stringify(entry));
  const log = fs.readFileSync(path.join(ws, entry.artifacts.log), 'utf8');
  assert.match(log, /5xx|500/);
});
