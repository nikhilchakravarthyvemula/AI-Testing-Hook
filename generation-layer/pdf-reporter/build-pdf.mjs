#!/usr/bin/env node
// pdf-reporter — one shareable PDF consolidating API + UI + Perf results.
//
// Allure (open-source) has no PDF export, so we build a clean, purpose-built
// one from the SAME data the allure-reporter consumes. Deterministic, no LLM,
// no new dependency: renders a print-optimised HTML and prints it with the
// installed `playwright` library's chromium `page.pdf()` (headless — needs no
// display, works on a terminal-only VM).
//
// Sources (whatever exists):
//   API  ← output/generation/api-tests/results.json (or openapi-tests/results.json)
//   UI   ← output/generation/ui-tests/run-result.json + screenshots/   (embedded as base64)
//   Perf ← output/generation/ui-tests/perf-timing.json (routes / APIs / objects)
//
// Output: output/generation/report.pdf  (+ report.html intermediate)
//
// Usage:
//   node generation-layer/pdf-reporter/build-pdf.mjs
//   node generation-layer/pdf-reporter/build-pdf.mjs --output output/generation/report.pdf

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const GEN = path.join(REPO_ROOT, 'output', 'generation');

const opts = parseArgs(process.argv.slice(2));
if (opts.help) { printHelp(); process.exit(0); }

const pdfPath = path.resolve(REPO_ROOT, opts.output || 'output/generation/report.pdf');
const htmlPath = pdfPath.replace(/\.pdf$/i, '.html');

const api = loadApi();
const ui = loadUi();
const perf = loadPerf();

if (!api && !ui && !perf) {
  console.error('pdf-reporter: no inputs found. Run the UI/API generators first.');
  process.exit(2);
}

const html = renderHtml({ api, ui, perf });
fs.mkdirSync(path.dirname(pdfPath), { recursive: true });
fs.writeFileSync(htmlPath, html);

console.log('━━━━━━━━━━ pdf-reporter ━━━━━━━━━━');
if (api) console.log(`  API   ${api.passed}/${api.tests.length} passed  (source: ${api.source})`);
if (ui) console.log(`  UI    ${ui.passed}/${ui.steps.length} steps passed, ${ui.steps.filter((s) => s.screenshotData).length} screenshots`);
if (perf) console.log(`  Perf  ${perf.routes.length} routes, ${perf.apis.length} APIs, ${perf.objects.length} objects`);

await printPdf(htmlPath, pdfPath);

const bytes = fs.statSync(pdfPath).size;
console.log(`  PDF   ${path.relative(REPO_ROOT, pdfPath)}  (${(bytes / 1024).toFixed(0)} KB)`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

// ── load + normalise ──────────────────────────────────────────────────────────

function loadApi() {
  const a = readJson(path.join(GEN, 'api-tests', 'results.json'));
  if (a && Array.isArray(a.tests) && a.tests.length) {
    const tests = a.tests.map((t) => ({ method: t.method, url: t.url, ok: t.ok, status: t.http_status, ms: t.timing_ms, error: t.error }));
    return { source: 'api-tests', tests, passed: tests.filter((t) => t.ok).length, login: a.login };
  }
  const o = readJson(path.join(GEN, 'openapi-tests', 'results.json'));
  if (o && Array.isArray(o.results) && o.results.length) {
    const tests = o.results.map((r) => ({
      method: r.method, url: r.url, ok: r.pass, status: r.actual, ms: r.ms,
      error: r.pass ? null : `expected ${r.expected}, got ${r.actual}`,
    }));
    return { source: 'openapi-tests', tests, passed: tests.filter((t) => t.ok).length, login: null };
  }
  return null;
}

function loadUi() {
  const rr = readJson(path.join(GEN, 'ui-tests', 'run-result.json'));
  if (!rr || !Array.isArray(rr.steps)) return null;
  const uiDir = path.join(GEN, 'ui-tests');
  const steps = rr.steps.map((s) => ({ ...s, screenshotData: embedPng(uiDir, s.screenshot) }));
  return {
    name: rr.name, baseUrl: rr.baseUrl, login: rr.login,
    steps, passed: steps.filter((s) => s.ok).length,
    vitals: rr.vitals, loginShot: embedPng(uiDir, rr.login?.screenshot),
  };
}

function loadPerf() {
  const p = readJson(path.join(GEN, 'ui-tests', 'perf-timing.json'));
  if (!p) return null;
  const net = p.network || [];
  const uiApis = net.filter((n) => n.kind === 'api');
  // Supplement API timing from the API suite (an unauth UI run fires few app APIs).
  const apiSrc = loadApi();
  const testApis = (apiSrc?.tests || []).map((t) => ({ method: t.method, url: t.url, status: t.status, durationMs: t.ms }));
  const byKey = new Map();
  for (const a of [...uiApis, ...testApis]) { const k = `${a.method} ${a.url}`; if (!byKey.has(k)) byKey.set(k, a); }
  return {
    routes: p.routes || [],
    apis: [...byKey.values()],
    objects: (net.filter((n) => n.kind === 'object')).sort((x, y) => (y.durationMs || 0) - (x.durationMs || 0)),
  };
}

// ── render ────────────────────────────────────────────────────────────────────

function renderHtml({ api, ui, perf }) {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const target = ui?.baseUrl || '—';
  const scenario = ui?.name || api?.source || 'test run';

  const tiles = [];
  if (api) tiles.push(tile('API', `${api.passed}/${api.tests.length}`, 'endpoints passed', api.passed === api.tests.length));
  if (ui) {
    const vitalsOk = !(ui.vitals?.checks || []).some((c) => !c.ok);
    const allOk = ui.passed === ui.steps.length && vitalsOk;
    tiles.push(tile('UI', `${ui.passed}/${ui.steps.length}`, 'steps passed', allOk));
  }
  if (perf) tiles.push(tile('Performance', String(perf.routes.length + perf.apis.length + perf.objects.length), 'timings captured', true));

  return `<!doctype html><html><head><meta charset="utf-8"><style>
  @page { size: A4; margin: 16mm 14mm; }
  * { box-sizing: border-box; }
  body { font: 12px/1.5 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #1a1a2e; margin: 0; }
  h1 { font-size: 24px; margin: 0 0 4px; }
  h2 { font-size: 16px; margin: 22px 0 8px; padding-bottom: 5px; border-bottom: 2px solid #2d3a8c; color: #2d3a8c; page-break-after: avoid; }
  h3 { font-size: 13px; margin: 14px 0 6px; color: #444; }
  .sub { color: #666; font-size: 11px; }
  .cover { padding: 6px 0 12px; border-bottom: 3px solid #2d3a8c; margin-bottom: 8px; }
  .meta td { padding: 2px 10px 2px 0; font-size: 11px; color: #333; }
  .meta td:first-child { color: #888; }
  .tiles { display: flex; gap: 10px; margin: 16px 0 4px; }
  .tile { flex: 1; border: 1px solid #ddd; border-radius: 8px; padding: 12px; text-align: center; }
  .tile .k { font-size: 11px; letter-spacing: .5px; text-transform: uppercase; color: #888; }
  .tile .v { font-size: 26px; font-weight: 700; margin: 4px 0; }
  .tile .d { font-size: 10px; color: #777; }
  .tile.ok .v { color: #1a7f37; } .tile.bad .v { color: #b3261e; }
  table { width: 100%; border-collapse: collapse; margin: 4px 0 10px; }
  th, td { text-align: left; padding: 5px 7px; border-bottom: 1px solid #eee; font-size: 11px; vertical-align: top; }
  th { background: #f4f5fb; color: #333; font-weight: 600; border-bottom: 1.5px solid #ccd; }
  td.mono, th.mono { font-family: "SF Mono", Menlo, Consolas, monospace; font-size: 10px; }
  .pass { color: #1a7f37; font-weight: 600; } .fail { color: #b3261e; font-weight: 600; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .reason { color: #b3261e; font-size: 10px; }
  .step { page-break-inside: avoid; margin: 8px 0 14px; }
  .step .hd { font-size: 12px; margin-bottom: 4px; }
  .shot { width: 100%; max-height: 360px; object-fit: contain; object-position: top; border: 1px solid #ddd; border-radius: 6px; }
  .small { color: #888; font-size: 10px; }
  .section { page-break-before: always; }
  .badge { display: inline-block; padding: 1px 6px; border-radius: 4px; font-size: 10px; font-weight: 600; }
  .badge.ok { background: #e6f4ea; color: #1a7f37; } .badge.bad { background: #fce8e6; color: #b3261e; }
  </style></head><body>

  <div class="cover">
    <h1>Test Report</h1>
    <div class="sub">API · UI · Performance — consolidated</div>
    <table class="meta" style="margin-top:8px">
      <tr><td>Scenario</td><td>${esc(scenario)}</td></tr>
      <tr><td>Target</td><td class="mono">${esc(target)}</td></tr>
      <tr><td>Generated</td><td>${esc(now)}</td></tr>
    </table>
    <div class="tiles">${tiles.join('')}</div>
  </div>

  ${api ? renderApi(api) : ''}
  ${ui ? renderUi(ui) : ''}
  ${perf ? renderPerf(perf) : ''}

  </body></html>`;
}

function tile(k, v, d, ok) {
  return `<div class="tile ${ok ? 'ok' : 'bad'}"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div><div class="d">${esc(d)}</div></div>`;
}

function renderApi(api) {
  const failed = api.tests.length - api.passed;
  const rows = api.tests.map((t) => `<tr>
    <td class="mono">${esc(t.method)}</td>
    <td class="mono">${esc(shortUrl(t.url))}</td>
    <td class="num">${t.status ?? '—'}</td>
    <td class="num">${t.ms ?? '—'}</td>
    <td class="${t.ok ? 'pass' : 'fail'}">${t.ok ? '✓ pass' : '✗ fail'}${t.error ? `<div class="reason">${esc(t.error)}</div>` : ''}</td>
  </tr>`).join('');
  return `<div class="section"><h2>API — ${api.passed}/${api.tests.length} passed${failed ? `, ${failed} failed` : ''}</h2>
  <div class="small">source: ${esc(api.source)}</div>
  <table><thead><tr><th>Method</th><th>Path</th><th class="num">Status</th><th class="num">ms</th><th>Result / reason</th></tr></thead>
  <tbody>${rows}</tbody></table></div>`;
}

function renderUi(ui) {
  const vrows = (ui.vitals?.checks || []).map((c) => `<tr>
    <td>${esc(c.metric)}</td><td class="num">${c.value}${esc(c.unit || '')}</td>
    <td class="num">≤ ${c.threshold}${esc(c.unit || '')}</td>
    <td class="${c.ok ? 'pass' : 'fail'}">${c.ok ? '✓ within' : '✗ over'}</td></tr>`).join('');
  const steps = ui.steps.map((s, i) => `<div class="step">
    <div class="hd"><span class="badge ${s.ok ? 'ok' : 'bad'}">${s.ok ? 'PASS' : 'FAIL'}</span>
      &nbsp;Step ${i + 1}: <b>${esc(s.label)}</b> <span class="small">${s.ms}ms</span>
      ${s.error ? `<div class="reason">${esc(s.error)}</div>` : ''}</div>
    ${s.screenshotData ? `<img class="shot" src="${s.screenshotData}">` : '<div class="small">(no screenshot)</div>'}
  </div>`).join('');
  return `<div class="section"><h2>UI — ${ui.passed}/${ui.steps.length} steps passed</h2>
  <table class="meta"><tr><td>Login</td><td>${esc(ui.login?.skipped || (ui.login?.ok ? 'ok' : 'n/a'))}</td></tr>
  ${ui.login?.finalUrl ? `<tr><td>Landed</td><td class="mono">${esc(shortUrl(ui.login.finalUrl))}</td></tr>` : ''}</table>
  ${vrows ? `<h3>Web Vitals</h3><table><thead><tr><th>Metric</th><th class="num">Value</th><th class="num">Threshold</th><th>Result</th></tr></thead><tbody>${vrows}</tbody></table>` : ''}
  <h3>Steps &amp; screenshots</h3>${steps}</div>`;
}

function renderPerf(perf) {
  const routeRows = perf.routes.map((r) => `<tr><td class="mono">${esc(r.route)}</td>
    <td class="num">${r.ttfbMs ?? '—'}</td><td class="num">${r.domContentLoadedMs ?? '—'}</td><td class="num">${r.loadMs ?? '—'}</td></tr>`).join('');
  const apiRows = perf.apis.slice(0, 40).map((a) => `<tr><td class="mono">${esc(a.method)}</td>
    <td class="mono">${esc(shortUrl(a.url))}</td><td class="num">${a.status ?? '—'}</td><td class="num">${a.durationMs ?? '—'}</td></tr>`).join('');
  const objRows = perf.objects.slice(0, 20).map((o) => `<tr><td>${esc(o.type)}</td>
    <td class="mono">${esc(shortUrl(o.url))}</td><td class="num">${o.durationMs ?? '—'}</td></tr>`).join('');
  return `<div class="section"><h2>Performance — timing captured during the UI run</h2>
  <div class="small">${perf.routes.length} routes · ${perf.apis.length} API calls · ${perf.objects.length} objects</div>
  <h3>Routes (navigation timing, ms)</h3>
  <table><thead><tr><th>Route</th><th class="num">TTFB</th><th class="num">DOMContentLoaded</th><th class="num">Load</th></tr></thead><tbody>${routeRows}</tbody></table>
  <h3>API calls (slowest shown, ms)</h3>
  <table><thead><tr><th>Method</th><th>Path</th><th class="num">Status</th><th class="num">ms</th></tr></thead><tbody>${apiRows}</tbody></table>
  <h3>Objects / resources (slowest 20, ms)</h3>
  <table><thead><tr><th>Type</th><th>URL</th><th class="num">ms</th></tr></thead><tbody>${objRows}</tbody></table></div>`;
}

// ── print ─────────────────────────────────────────────────────────────────────

async function printPdf(htmlFile, outPdf) {
  // Headless Chromium needs no display — works on terminal-only VMs.
  // --no-sandbox is required when running as root (containers / CI); auto-on.
  const noSandbox = process.env.PW_NO_SANDBOX === '1' || (typeof process.getuid === 'function' && process.getuid() === 0);
  const browser = await chromium.launch({ headless: true, args: noSandbox ? ['--no-sandbox', '--disable-dev-shm-usage'] : [] });
  try {
    const page = await browser.newPage();
    await page.goto('file://' + htmlFile, { waitUntil: 'load' });
    await page.pdf({
      path: outPdf, format: 'A4', printBackground: true,
      displayHeaderFooter: true,
      margin: { top: '16mm', bottom: '14mm', left: '14mm', right: '14mm' },
      headerTemplate: '<div></div>',
      footerTemplate: '<div style="width:100%;font-size:8px;color:#999;padding:0 14mm;display:flex;justify-content:space-between;"><span>Testing Harness — consolidated report</span><span>Page <span class="pageNumber"></span> / <span class="totalPages"></span></span></div>',
    });
  } finally {
    await browser.close();
  }
}

// ── utils ─────────────────────────────────────────────────────────────────────

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function embedPng(dir, rel) {
  if (!rel) return null;
  const f = path.join(dir, rel);
  try { return 'data:image/png;base64,' + fs.readFileSync(f).toString('base64'); } catch { return null; }
}
function esc(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function shortUrl(u) { try { const x = new URL(u); return x.pathname + (x.search ? '?…' : ''); } catch { return String(u || '').slice(0, 90); } }

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-h': case '--help': out.help = true; break;
      case '--output': case '-o': out.output = argv[++i]; break;
      default: console.error(`pdf-reporter: unknown option "${a}"`); process.exit(2);
    }
  }
  return out;
}
function printHelp() {
  console.log(`pdf-reporter — consolidate API + UI + Perf into one PDF

Usage:
  node generation-layer/pdf-reporter/build-pdf.mjs [--output <path>]

Reads api/openapi-tests results.json, ui-tests/run-result.json (+ screenshots),
ui-tests/perf-timing.json. Writes output/generation/report.pdf (+ .html).
Headless — no display needed (works on a terminal-only VM).
`);
}
