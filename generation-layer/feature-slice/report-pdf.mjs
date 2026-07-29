#!/usr/bin/env node
// Feature-grouped PDF report.
//
// Consumes the feature-tagged unified report (output/generation/report.json,
// produced by ctx execute with a featureId on every row + a features[] rollup)
// and the feature manifest (output/features/feature-manifest.json, for each
// feature's concrete gaps + endpoints). Emits one section PER FEATURE — ordered
// by gap priority — showing coverage, the specific gaps to close, and the
// feature's API + UI tests. Renders print HTML and prints it with the installed
// playwright chromium `page.pdf()` (headless, no display, no new dependency) —
// the same mechanism as generation-layer/pdf-reporter/build-pdf.mjs.
//
// Output: output/generation/report-features.pdf (+ .html intermediate)
// Usage: node generation-layer/feature-slice/report-pdf.mjs [--output <path>]
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const GEN = path.join(REPO_ROOT, 'output', 'generation');

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

export async function buildFeaturePdf({ output } = {}) {
  const report = readJson(path.join(GEN, 'report.json'));
  if (!report) { throw new Error('no output/generation/report.json — run `ctx execute` first'); }
  const manifest = readJson(path.join(REPO_ROOT, 'output', 'features', 'feature-manifest.json'));
  const gapsByFeature = new Map((manifest?.features || []).map((f) => [f.featureId, f.gaps || []]));

  const pdfPath = path.resolve(REPO_ROOT, output || 'output/generation/report-features.pdf');
  const htmlPath = pdfPath.replace(/\.pdf$/i, '.html');
  const html = renderHtml(report, gapsByFeature);
  fs.mkdirSync(path.dirname(pdfPath), { recursive: true });
  fs.writeFileSync(htmlPath, html);
  await printPdf(htmlPath, pdfPath);
  return { pdf: path.relative(REPO_ROOT, pdfPath), features: (report.features || []).length, bytes: fs.statSync(pdfPath).size };
}

function renderHtml(report, gapsByFeature) {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const t = report.totals || {};
  const features = report.features || [];
  const rowsByFeature = new Map();
  for (const row of report.tests || []) {
    const k = row.featureId || '_untagged';
    if (!rowsByFeature.has(k)) rowsByFeature.set(k, []);
    rowsByFeature.get(k).push(row);
  }
  const totalGaps = features.reduce((n, f) => n + (f.priority?.openGaps ?? f.gapCount ?? 0), 0);
  const icon = (s) => (s === 'passed' ? '✓' : s === 'failed' ? '✗' : '⊘');
  const cls = (s) => (s === 'passed' ? 'pass' : s === 'failed' ? 'fail' : 'skip');

  const tiles = [
    tile('Passed', String(t.passed ?? 0), 'tests', 'ok'),
    tile('Failed', String(t.failed ?? 0), 'tests', (t.failed ?? 0) ? 'bad' : 'ok'),
    tile('Skipped', String(t.skipped ?? 0), 'safe-mode', ''),
    tile('Features', String(features.length), 'covered', ''),
    tile('Open gaps', String(totalGaps), 'to close', totalGaps ? 'warn' : 'ok'),
  ].join('');

  // Per-feature sections, in report (priority) order.
  const sections = features.map((f) => {
    const rows = rowsByFeature.get(f.featureId) || [];
    const gaps = (gapsByFeature.get(f.featureId) || []).slice(0, 12);
    const p = f.priority || {};
    const covLine = [
      `${f.passed}/${f.total} passed`,
      f.failed ? `<span class="fail">${f.failed} failed</span>` : null,
      f.skipped ? `${f.skipped} skipped` : null,
      `${p.testableEndpoints ?? f.testableEndpoints ?? 0} testable endpoints`,
      `${p.openGaps ?? f.gapCount ?? 0} open gaps`,
      (p.highSeverityGaps ?? 0) ? `<span class="fail">${p.highSeverityGaps} high-severity</span>` : null,
    ].filter(Boolean).join(' · ');

    const gapRows = gaps.length ? `
      <h3>Gaps to close (${gaps.length}${(p.openGaps ?? gaps.length) > gaps.length ? ' of ' + (p.openGaps) : ''})</h3>
      <table><thead><tr><th>Type</th><th>Severity</th><th>What</th></tr></thead><tbody>
      ${gaps.map((g) => `<tr><td class="mono">${esc(g.type)}</td><td><span class="badge ${sev(g.severity)}">${esc(g.severity)}</span></td><td>${esc(g.title)}</td></tr>`).join('')}
      </tbody></table>` : '<p class="small">No open gaps recorded for this feature.</p>';

    const testRows = rows.length ? `
      <h3>Tests (${rows.length})</h3>
      <table><thead><tr><th></th><th>Test</th><th>Status</th><th>Detail / reason</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td class="${cls(r.status)}">${icon(r.status)}</td><td class="mono">${esc(r.name)}</td><td class="${cls(r.status)}">${esc(r.status)}</td><td class="reason">${esc(r.reason || r.detail || '')}</td></tr>`).join('')}
      </tbody></table>` : '<p class="small">No tests were generated for this feature.</p>';

    const name = f.featureId === '_untagged' ? 'Untagged (third-party / unmapped)' : `${esc(f.name)} <span class="small">(${esc(f.featureId)})</span>`;
    return `<section class="section"><h2>${name}</h2><p class="sub">${covLine}</p>${gapRows}${testRows}</section>`;
  }).join('');

  return `<!doctype html><html><head><meta charset="utf-8"><style>
  @page { size: A4; margin: 16mm 14mm; }
  * { box-sizing: border-box; }
  body { font: 12px/1.5 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #1a1a2e; margin: 0; }
  h1 { font-size: 24px; margin: 0 0 4px; }
  h2 { font-size: 16px; margin: 22px 0 8px; padding-bottom: 5px; border-bottom: 2px solid #2d3a8c; color: #2d3a8c; page-break-after: avoid; }
  h3 { font-size: 13px; margin: 14px 0 6px; color: #444; }
  .sub { color: #666; font-size: 11px; margin: 2px 0 8px; }
  .cover { padding: 6px 0 12px; border-bottom: 3px solid #2d3a8c; margin-bottom: 8px; }
  .meta td { padding: 2px 10px 2px 0; font-size: 11px; color: #333; }
  .meta td:first-child { color: #888; }
  .tiles { display: flex; gap: 10px; margin: 16px 0 4px; }
  .tile { flex: 1; border: 1px solid #ddd; border-radius: 8px; padding: 12px; text-align: center; }
  .tile .k { font-size: 11px; letter-spacing: .5px; text-transform: uppercase; color: #888; }
  .tile .v { font-size: 26px; font-weight: 700; margin: 4px 0; }
  .tile .d { font-size: 10px; color: #777; }
  .tile.ok .v { color: #1a7f37; } .tile.bad .v { color: #b3261e; } .tile.warn .v { color: #b7791f; }
  table { width: 100%; border-collapse: collapse; margin: 4px 0 10px; }
  th, td { text-align: left; padding: 5px 7px; border-bottom: 1px solid #eee; font-size: 11px; vertical-align: top; }
  th { background: #f4f5fb; color: #333; font-weight: 600; border-bottom: 1.5px solid #ccd; }
  td.mono, th.mono { font-family: "SF Mono", Menlo, Consolas, monospace; font-size: 10px; word-break: break-all; }
  .pass { color: #1a7f37; font-weight: 600; } .fail { color: #b3261e; font-weight: 600; } .skip { color: #888; }
  .reason { color: #b3261e; font-size: 10px; }
  .small { color: #888; font-size: 10px; }
  .section { page-break-before: always; }
  .summary-tbl td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .badge { display: inline-block; padding: 1px 6px; border-radius: 4px; font-size: 10px; font-weight: 600; }
  .badge.high { background: #fce8e6; color: #b3261e; } .badge.medium { background: #fef3c7; color: #92400e; } .badge.low { background: #eef; color: #3730a3; }
  </style></head><body>
  <div class="cover">
    <h1>Feature Coverage Report</h1>
    <table class="meta">
      <tr><td>Target</td><td>${esc(report.target?.baseUrl || report.target || '—')}</td></tr>
      <tr><td>Mode</td><td>${esc(report.mode || '—')}</td></tr>
      <tr><td>Run</td><td>${esc(report.runId || '—')}</td></tr>
      <tr><td>Generated</td><td>${now}</td></tr>
    </table>
    <div class="tiles">${tiles}</div>
  </div>
  <h2>Coverage by feature</h2>
  <table class="summary-tbl"><thead><tr><th>Feature</th><th class="num">Passed</th><th class="num">Failed</th><th class="num">Skipped</th><th class="num">Open gaps</th><th class="num">High-sev</th></tr></thead><tbody>
  ${features.map((f) => `<tr><td>${esc(f.name)} <span class="small">${esc(f.featureId)}</span></td><td class="num pass">${f.passed}</td><td class="num ${f.failed ? 'fail' : ''}">${f.failed}</td><td class="num">${f.skipped}</td><td class="num">${f.priority?.openGaps ?? f.gapCount ?? 0}</td><td class="num ${(f.priority?.highSeverityGaps ?? 0) ? 'fail' : ''}">${f.priority?.highSeverityGaps ?? 0}</td></tr>`).join('')}
  </tbody></table>
  ${sections}
  </body></html>`;
}

function tile(k, v, d, mod) { return `<div class="tile ${mod}"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div><div class="d">${esc(d)}</div></div>`; }
function sev(s) { return s === 'high' ? 'high' : s === 'medium' ? 'medium' : 'low'; }

async function printPdf(htmlFile, outPdf) {
  const noSandbox = process.env.PW_NO_SANDBOX === '1' || (typeof process.getuid === 'function' && process.getuid() === 0);
  const browser = await chromium.launch({ headless: true, args: noSandbox ? ['--no-sandbox', '--disable-dev-shm-usage'] : [] });
  try {
    const page = await browser.newPage();
    await page.goto('file://' + htmlFile, { waitUntil: 'load' });
    await page.pdf({
      path: outPdf, format: 'A4', printBackground: true, displayHeaderFooter: true,
      margin: { top: '16mm', bottom: '14mm', left: '14mm', right: '14mm' },
      headerTemplate: '<div></div>',
      footerTemplate: '<div style="width:100%;font-size:8px;color:#999;padding:0 14mm;display:flex;justify-content:space-between;"><span>Feature coverage report</span><span>Page <span class="pageNumber"></span> / <span class="totalPages"></span></span></div>',
    });
  } finally {
    await browser.close();
  }
}

// CLI
function main() {
  const argv = process.argv.slice(2);
  const oi = argv.indexOf('--output');
  const output = oi >= 0 ? argv[oi + 1] : null;
  buildFeaturePdf({ output })
    .then((r) => { process.stderr.write(`[feature-pdf] ${r.features} features → ${r.pdf} (${(r.bytes / 1024).toFixed(0)} KB)\n`); process.stdout.write(JSON.stringify({ ok: true, ...r }) + '\n'); })
    .catch((e) => { process.stderr.write(`[feature-pdf] ${e.message}\n`); process.exit(1); });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
