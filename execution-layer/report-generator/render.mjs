// C8 — the final report. The product.
//
// One consolidated, self-contained deliverable per run: report/index.html
// (interactive, inline everything) + report/report.pdf (shareable), four
// mandatory sections. Deterministic — no LLM (p0-08 §1). Reads ONLY the run
// workspace. A thin/degraded run still gets a report: every section renders an
// honest explanation rather than shrinking, so "a report always comes out"
// (p0-00 acceptance 2) holds.
//
// runReport() mirrors the other stages ({ ok, stats, degraded }); the PDF is
// best-effort — a missing chromium degrades to HTML-only, it never fails the
// stage (the HTML is the product; the PDF is a convenience copy).

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { gather } from './lib/gather.mjs';
import { renderPage } from './lib/layout.mjs';
import { join, tile } from './lib/html.mjs';
import { renderResults } from './lib/sections/results.mjs';
import { renderCoverage } from './lib/sections/coverage.mjs';
import { renderAppMap } from './lib/sections/appmap.mjs';
import { renderTransparency } from './lib/sections/transparency.mjs';
import { htmlToPdf } from './lib/pdf.mjs';

const NAV = [
  { id: 'results', label: 'A · Results' },
  { id: 'coverage', label: 'B · Coverage' },
  { id: 'appmap', label: 'C · App map' },
  { id: 'transparency', label: 'D · Transparency' },
];

/**
 * Render the report HTML for a workspace (pure string build — testable, no fs
 * write, no browser).
 * @returns {string} the full self-contained HTML document
 */
export function renderReportHtml(model) {
  const sections = join([
    renderResults(model),
    renderCoverage(model),
    renderAppMap(model),
    renderTransparency(model),
  ]);
  return renderPage({
    title: `Test audit — ${model.run.target?.url ?? model.run.runId ?? 'run'}`,
    subtitle: subtitle(model),
    tiles: headlineTiles(model),
    nav: NAV,
    sections,
  });
}

/**
 * @param {object} ctx
 * @param {string} ctx.workspace
 * @param {(m:string)=>void} [ctx.log]
 * @param {boolean} [ctx.pdf=true]   attempt the PDF (best-effort)
 * @returns {Promise<{ ok:true, stats, degraded } | { ok:false, reason }>}
 */
export async function runReport(ctx) {
  const log = ctx.log ?? (() => {});
  const model = gather(ctx.workspace);

  const html = renderReportHtml(model);
  const reportDir = path.join(ctx.workspace, 'report');
  fs.mkdirSync(reportDir, { recursive: true });
  const htmlPath = path.join(reportDir, 'index.html');
  fs.writeFileSync(htmlPath, html);
  log(`wrote ${path.relative(ctx.workspace, htmlPath)} (${(html.length / 1024).toFixed(0)} KB, self-contained)`);

  const degraded = [];
  let pdf = false;
  // REPORT_SKIP_PDF=1 skips the (chromium, ~1-2s) PDF — for fast/deterministic
  // CI and the committed e2e. The HTML is the product; the PDF is a copy.
  if (ctx.pdf !== false && process.env.REPORT_SKIP_PDF !== '1') {
    try {
      await htmlToPdf(htmlPath, path.join(reportDir, 'report.pdf'));
      pdf = true;
      log('wrote report/report.pdf');
    } catch (e) {
      // The PDF is a convenience; the HTML is the product. Disclose and move on.
      degraded.push({ useCase: 'report-pdf', stage: 'report',
        reason: `PDF render failed (${e.message})`, fallback: 'HTML report only' });
      log(`  ⚠ PDF skipped: ${e.message}`);
    }
  }

  return { ok: true, stats: { htmlPath, htmlBytes: html.length, pdf }, degraded };
}

// ── headline ─────────────────────────────────────────────────────────────────

function headlineTiles(model) {
  const s = model.results?.summary;
  if (!s) return '';
  return join([
    tile('Passed', s.passed ?? 0, 'ok'),
    tile('Failed', s.failed ?? 0, (s.failed ?? 0) > 0 ? 'bad' : 'neutral'),
    tile('Skipped', s.skippedMutation ?? 0, (s.skippedMutation ?? 0) > 0 ? 'warn' : 'neutral'),
    tile('Error', s.error ?? 0, (s.error ?? 0) > 0 ? 'bad' : 'neutral'),
  ]);
}

function subtitle(model) {
  const bits = [model.run.runId, `mode: ${model.run.mode ?? '?'}`, `profile: ${model.profile}`,
    `engine: ${model.run.engine?.provider ?? '?'}`];
  if (model.generatedAt) bits.push(model.generatedAt);
  return bits.filter(Boolean).join('  ·  ');
}

// ── CLI: node render.mjs --workspace <dir> [--no-pdf] ─────────────────────────

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const wsIdx = args.indexOf('--workspace');
  const workspace = wsIdx >= 0 ? args[wsIdx + 1] : process.env.RUN_WORKSPACE;
  if (!workspace) {
    console.error('usage: node render.mjs --workspace <run-dir> [--no-pdf]');
    process.exit(2);
  }
  const pdf = !args.includes('--no-pdf');
  const r = await runReport({ workspace, pdf, log: (m) => console.log(`[report] ${m}`) });
  if (!r.ok) { console.error(`[report] FAILED: ${r.reason}`); process.exit(1); }
  console.log(`[report] done → ${path.join(workspace, 'report', 'index.html')}`);
}
