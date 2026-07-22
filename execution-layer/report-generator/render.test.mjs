import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { gather } from './lib/gather.mjs';
import { renderReportHtml, runReport } from './render.mjs';

// a 1x1 transparent PNG — proves screenshots are inlined as data URIs.
const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

function storeFixture(runId) {
  return {
    runId, builtAt: '2026-07-20T00:00:00Z', target: { url: 'https://app.example.com', profile: 'url+code' },
    facts: [
      { factId: 'e:get-cart', kind: 'endpoint', key: { method: 'GET', pathTemplate: '/api/v2/cart' },
        confidence: 0.95, provenance: { families: [{ class: 'runtime' }, { class: 'spec' }], corroborationCount: 2 }, attributes: {} },
      { factId: 'e:post-orders', kind: 'endpoint', key: { method: 'POST', pathTemplate: '/api/v2/orders' },
        confidence: 0.6, provenance: { families: [{ class: 'runtime' }], corroborationCount: 1 }, attributes: {} },
      { factId: 'p:cart', kind: 'page', key: { pathTemplate: '/cart' }, confidence: 0.9, provenance: {}, attributes: {} },
    ],
    features: [{ featureId: 'feat:checkout', name: 'Checkout', summary: 'buy things' }],
    gaps: [
      { gapId: 'g:shadow-cart', type: 'shadow-endpoint', severity: 'high', priority: 0.9,
        subject: { factId: 'e:get-cart', kind: 'endpoint', key: { method: 'GET', pathTemplate: '/api/v2/cart' } },
        title: 'Undocumented endpoint: GET /api/v2/cart', detail: 'seen live, absent from spec', recommendation: 'add a contract test' },
      { gapId: 'g:untested-orders', type: 'untested-endpoint', severity: 'medium', priority: 0.5,
        subject: { factId: 'e:post-orders', kind: 'endpoint', key: { method: 'POST', pathTemplate: '/api/v2/orders' } },
        title: 'Untested endpoint: POST /api/v2/orders', detail: 'no test hits it', recommendation: 'generate an api test' },
    ],
    indexes: {
      factsByKey: { 'GET /api/v2/cart': 'e:get-cart', 'POST /api/v2/orders': 'e:post-orders', '/cart': 'p:cart' },
      factsByFeature: { 'feat:checkout': ['e:get-cart', 'e:post-orders', 'p:cart'] },
      gapsByFeature: { 'feat:checkout': ['g:shadow-cart', 'g:untested-orders'] },
      pagesByFeature: { 'feat:checkout': ['/cart'] },
    },
    stats: { facts: 3, features: 1, gaps: 2, s2Merges: 0, s2Skipped: 0 },
  };
}

function fullWorkspace(t, { profile = 'url+code', codebasePath = '/repo' } = {}) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'c8-report-'));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  const runId = 'r1';
  const W = (rel, obj) => { const p = path.join(ws, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj)); };

  W('run.json', {
    runId, target: { url: 'https://app.example.com', codebasePath }, profile, mode: 'safe',
    budget: { maxRequests: 200 }, engine: { provider: 'claude' }, outcome: 'completed', endedAt: '2026-07-20T01:00:00Z',
    stages: { plan: { status: 'done', startedAt: '2026-07-20T00:00:00Z', endedAt: '2026-07-20T00:00:02Z' } },
    checkpoint: { approvedAt: '2026-07-20T00:30:00Z', planHash: 'sha256:abcdef0123456789abcdef', approvedBy: 'operator' },
    degraded: [{ useCase: 'S1', stage: 'plan', reason: 'engine unavailable', fallback: 'template scenarios', at: '2026-07-20T00:00:01Z' }],
  });
  W('ledger.jsonl',
    JSON.stringify({ useCase: 'S1', requests: 1, inputTokens: 100, outputTokens: 50, cacheHit: false, degraded: false }) + '\n' +
    JSON.stringify({ useCase: 'A1', requests: 2, inputTokens: 200, outputTokens: 80, cacheHit: false, degraded: false }) + '\n' +
    JSON.stringify({ useCase: 'S1', requests: 0, inputTokens: 0, outputTokens: 0, cacheHit: true, degraded: false }) + '\n');
  W('store/knowledge.json', storeFixture(runId));
  W('plan/test-plan.json', { runId, createdAt: '2026-07-20T00:00:00Z', source: 'llm', features: [{
    featureId: 'feat:checkout', name: 'Checkout', source: 'llm', scenarios: [
      { scenarioId: 'sc-0001', title: 'cart loads', kind: 'api', intent: 'GET cart', mutation: false, targets: { endpoints: ['GET /api/v2/cart'] }, priority: 0.9, gapRefs: ['g:shadow-cart'] },
      { scenarioId: 'sc-0002', title: 'place order', kind: 'api', intent: 'POST order', mutation: true, targets: { endpoints: ['POST /api/v2/orders'] }, priority: 0.5, gapRefs: ['g:untested-orders'] },
    ] }], estimates: { scenarios: 2, llmRequests: 6 } });
  W('tests/manifest.json', { runId, entries: [
    { scenarioId: 'sc-0001', featureId: 'feat:checkout', file: 'tests/feat:checkout/sc-0001.spec.mjs', kind: 'api', mutation: false, generator: 'agent', status: 'generated' },
    { scenarioId: 'sc-0002', featureId: 'feat:checkout', file: 'tests/feat:checkout/sc-0002.spec.mjs', kind: 'api', mutation: true, generator: 'template', status: 'generated' },
  ] });
  fs.mkdirSync(path.join(ws, 'results', 'shots'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'results', 'shots', 'sc-0001-1.png'), PNG_1x1);
  W('results/results.json', { runId, summary: { passed: 0, failed: 1, skippedMutation: 1, error: 0 }, entries: [
    { scenarioId: 'sc-0001', featureId: 'feat:checkout', file: 'tests/feat:checkout/sc-0001.spec.mjs', status: 'failed', durationMs: 120, reason: 'exit 1', artifacts: { screenshots: ['results/shots/sc-0001-1.png'], log: 'results/raw/sc-0001.log' } },
    { scenarioId: 'sc-0002', featureId: 'feat:checkout', file: 'tests/feat:checkout/sc-0002.spec.mjs', status: 'skipped-mutation', durationMs: 0, reason: 'safe-mode', artifacts: { screenshots: [], log: null } },
  ] });
  return ws;
}

// ── the full report ──────────────────────────────────────────────────────────

test('renders all four sections with real content', (t) => {
  const html = renderReportHtml(gather(fullWorkspace(t)));

  for (const id of ['id="results"', 'id="coverage"', 'id="appmap"', 'id="transparency"']) {
    assert.ok(html.includes(id), `missing section ${id}`);
  }
  // §A: the failed test + its human title, and template provenance for sc-0002.
  assert.match(html, /cart loads/);
  assert.match(html, /place order/);
  assert.match(html, /pill--bad">failed/);
  // §B: the shadow gap appears and is marked tested (sc-0001 ran → failed = ran).
  assert.match(html, /Undocumented endpoint/);
  assert.match(html, /tested this run/);
  // §C: confidence-shaded endpoint inventory.
  assert.match(html, /GET \/api\/v2\/cart/);
  assert.match(html, /95%/);
  // §D: ledger reconciliation (3 total requests: 1 + 2 + 0 cache) + degradation + checkpoint.
  assert.match(html, /engine unavailable/);            // the degradation reason
  assert.match(html, /operator/);                      // checkpoint approver
});

test('the report is self-contained — no external resource requests', (t) => {
  const html = renderReportHtml(gather(fullWorkspace(t)));
  // no <script src>, <link href>, or any resource url pointing off-box.
  assert.equal(/(?:src|href)\s*=\s*["']https?:/i.test(html), false, 'found an external resource reference');
  assert.ok(html.includes('<style>'), 'CSS should be inline');
  // the screenshot was inlined as a data URI, not linked.
  assert.match(html, /data:image\/png;base64,/);
});

test('--yes auto-approval is disclosed in §D', (t) => {
  const ws = fullWorkspace(t);
  const run = JSON.parse(fs.readFileSync(path.join(ws, 'run.json'), 'utf8'));
  run.checkpoint.approvedBy = '--yes flag';
  fs.writeFileSync(path.join(ws, 'run.json'), JSON.stringify(run));
  const html = renderReportHtml(gather(ws));
  assert.match(html, /Auto-approved \(--yes\): no human reviewed/);
});

// ── honesty on thin / degraded runs ──────────────────────────────────────────

test('a run with no store/results still renders — sections explain themselves', (t) => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'c8-thin-'));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  fs.writeFileSync(path.join(ws, 'run.json'), JSON.stringify({
    runId: 'r2', target: { url: 'https://x.example', codebasePath: null }, profile: 'url-only',
    mode: 'safe', budget: { maxRequests: 200 }, engine: { provider: 'mock' }, outcome: 'completed', degraded: [],
  }));

  const html = renderReportHtml(gather(ws));
  // all four sections present, each with an honest empty explanation — never dropped.
  for (const id of ['id="results"', 'id="coverage"', 'id="appmap"', 'id="transparency"']) assert.ok(html.includes(id));
  assert.match(html, /No results were produced/);
  assert.match(html, /store is unavailable|no understanding to map/i);
});

test('url-only profile: §B and §D state the "no codebase" limitation', (t) => {
  const html = renderReportHtml(gather(fullWorkspace(t, { profile: 'url-only', codebasePath: null })));
  assert.match(html, /no codebase was provided|Codebase: not provided/i);
});

// ── runReport writes the file ────────────────────────────────────────────────

test('runReport writes report/index.html (pdf skipped) and returns ok', async (t) => {
  const ws = fullWorkspace(t);
  const res = await runReport({ workspace: ws, pdf: false });
  assert.equal(res.ok, true);
  assert.equal(res.stats.pdf, false);
  const p = path.join(ws, 'report', 'index.html');
  assert.ok(fs.existsSync(p));
  assert.ok(fs.readFileSync(p, 'utf8').includes('id="transparency"'));
});
