// Whole-product E2E — the downstream pipeline through the REAL spine.
//
// plan → checkpoint → generate → execute → report, driven exactly as `testo run`
// drives them, against a local http.Server, with the MOCK engine and no fixtures
// (the fully-degraded path). This is the committed proof of P0 acceptance 2: even
// when the engine never answers, the run completes and a report ALWAYS comes out,
// with every fallback disclosed. PDF is skipped here (REPORT_SKIP_PDF) for speed
// and determinism — the real chromium PDF is exercised separately.
//
// The upstream stages (acquire/understand/store) need a live crawl + codebase, so
// the store is injected; everything from `plan` on is the real thing.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { createWorkspace, readRun, updateRun } from '../../interfaces/cli/_lib/spine/workspace.mjs';
import { runStages } from '../../interfaces/cli/_lib/spine/stages.mjs';

function injectedStore(runId, baseUrl) {
  return {
    runId, builtAt: '2026-07-20T00:00:00Z', target: { url: baseUrl, profile: 'url-only' },
    facts: [
      { factId: 'e:get-cart', kind: 'endpoint', key: { method: 'GET', pathTemplate: '/api/v2/cart' }, confidence: 0.9, provenance: { families: [{ class: 'runtime' }], corroborationCount: 1 }, attributes: {} },
      { factId: 'e:post-orders', kind: 'endpoint', key: { method: 'POST', pathTemplate: '/api/v2/orders' }, confidence: 0.6, provenance: { families: [{ class: 'runtime' }], corroborationCount: 1 }, attributes: {} },
      { factId: 'p:cart', kind: 'page', key: { pathTemplate: '/cart' }, confidence: 0.9, provenance: {}, attributes: {} },
    ],
    features: [{ featureId: 'feat:checkout', name: 'Checkout', summary: 'buy things' }],
    gaps: [{ gapId: 'g:untested-orders', type: 'untested-endpoint', severity: 'medium', priority: 0.5, subject: { factId: 'e:post-orders', kind: 'endpoint', key: { method: 'POST', pathTemplate: '/api/v2/orders' } }, title: 'Untested endpoint: POST /api/v2/orders', detail: 'no test hits it', recommendation: 'add an api test' }],
    indexes: {
      factsByKey: { 'GET /api/v2/cart': 'e:get-cart', 'POST /api/v2/orders': 'e:post-orders', '/cart': 'p:cart' },
      factsByFeature: { 'feat:checkout': ['e:get-cart', 'e:post-orders', 'p:cart'] },
      gapsByFeature: { 'feat:checkout': ['g:untested-orders'] }, pagesByFeature: { 'feat:checkout': ['/cart'] },
    },
    stats: { facts: 3, features: 1, gaps: 1, s2Merges: 0, s2Skipped: 0 },
  };
}

test('mock-degraded run completes and a report always comes out (P0 acceptance 2)', async (t) => {
  process.env.REPORT_SKIP_PDF = '1';
  t.after(() => { delete process.env.REPORT_SKIP_PDF; });

  const server = http.createServer((req, res) => { res.writeHead(200); res.end('ok'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-'));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const ws = createWorkspace({ repoRoot, url: baseUrl, codebasePath: null, mode: 'safe', budget: 200, engine: 'mock' });
  fs.writeFileSync(ws.paths.storeJson, JSON.stringify(injectedStore(ws.run.runId, baseUrl)));
  // The upstream stages need a live crawl + codebase; mark them done so the REAL
  // runner (below) skips them and picks up at `plan` — exactly the `--resume`
  // mechanism, driving the genuine spine loop from there.
  updateRun(ws.dir, (run) => { for (const s of ['acquire', 'understand', 'store']) run.stages[s].status = 'done'; });

  const io = { out: () => {}, checkpointIo: { out: () => {}, prompt: async () => 'n', openEditor: () => ({ ok: true }) } };
  const ctx = { repoRoot, dir: ws.dir, paths: ws.paths, run: readRun(ws.dir), opts: { yes: true }, io };

  // The real spine loop — stamps stage status, records degradations, the works.
  const outcome = await runStages(ctx);
  assert.equal(outcome.outcome, 'completed', `run did not complete: ${JSON.stringify(outcome)}`);

  // ── the deliverable ────────────────────────────────────────────────────────
  const htmlPath = path.join(ws.dir, 'report', 'index.html');
  assert.ok(fs.existsSync(htmlPath), 'report/index.html must exist — a report always comes out');
  const html = fs.readFileSync(htmlPath, 'utf8');
  for (const id of ['id="results"', 'id="coverage"', 'id="appmap"', 'id="transparency"']) {
    assert.ok(html.includes(id), `report missing section ${id}`);
  }
  assert.equal(/(?:src|href)\s*=\s*["']https?:/i.test(html), false, 'report must be self-contained');

  // ── the degraded path really degraded, and it's disclosed ──────────────────
  const run = readRun(ws.dir);
  const kinds = run.degraded.map((d) => `${d.useCase}/${d.stage}`);
  assert.ok(kinds.includes('S1/plan'), 'plan should have degraded to templates');
  assert.ok(kinds.includes('A1/generate'), 'generate should have degraded to templates');

  // ── enforcement really ran: the mutation was withheld, the smoke passed ────
  const results = JSON.parse(fs.readFileSync(ws.paths.resultsJson, 'utf8'));
  assert.equal(results.summary.skippedMutation, 1, 'the POST mutation is skipped in safe mode');
  assert.equal(results.summary.passed, 1, 'the smoke test ran against the live local server');

  // every stage ended done.
  for (const [name, s] of Object.entries(run.stages)) {
    if (['plan', 'checkpoint', 'generate', 'execute', 'report'].includes(name)) {
      assert.equal(s.status, 'done', `stage ${name} not done`);
    }
  }
});
