#!/usr/bin/env node
// allure-reporter — consolidate API + UI + Perf results into one Allure report.
//
// Deterministic, no LLM. Writing the Allure result JSON needs NOTHING installed
// (plain file writes). Rendering the HTML needs the Allure CLI, which is a Java
// app — Java is present, so `--serve` / `--generate` shell out to
// `npx allure-commandline` (or a global `allure` if you have one).
//
// Sources (whatever exists):
//   API  ← output/generation/api-tests/results.json   (or openapi-tests/results.json)
//   UI   ← output/generation/ui-tests/run-result.json  + screenshots/
//   Perf ← output/generation/ui-tests/perf-timing.json (routes / APIs / objects)
//
// Output: output/generation/allure-results/  (feed to `allure serve`)
//
// Usage:
//   node generation-layer/allure-reporter/build.mjs              # build results only
//   node generation-layer/allure-reporter/build.mjs --serve      # build + open report
//   node generation-layer/allure-reporter/build.mjs --generate   # build + write static HTML

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const GEN = path.join(REPO_ROOT, 'output', 'generation');

const opts = parseArgs(process.argv.slice(2));
if (opts.help) { printHelp(); process.exit(0); }

const resultsDir = path.resolve(REPO_ROOT, opts.resultsDir || 'output/generation/allure-results');
fs.rmSync(resultsDir, { recursive: true, force: true });
fs.mkdirSync(resultsDir, { recursive: true });

const counts = { api: 0, ui: 0, perf: 0 };
const seen = [];

const api = convertApi(resultsDir);
if (api) { counts.api = api.n; seen.push(`API (${api.passed}/${api.n} passed, source: ${api.source})`); }
const ui = convertUi(resultsDir);
if (ui) { counts.ui = ui.n; seen.push(`UI (${ui.passed}/${ui.n} steps passed)`); }
const perf = convertPerf(resultsDir);
if (perf) { counts.perf = 1; seen.push(`Perf (${perf.routes} routes, ${perf.apis} APIs, ${perf.objects} objects)`); }

writeEnvironment(resultsDir);
writeCategories(resultsDir);

console.log('━━━━━━━━━━ allure-reporter ━━━━━━━━━━');
if (!seen.length) {
  console.error('  no inputs found. Run the UI/API generators first.');
  process.exit(2);
}
for (const s of seen) console.log('  ✓ ' + s);
console.log(`  results     ${path.relative(REPO_ROOT, resultsDir)}`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

if (opts.serve) runAllure(['serve', resultsDir]);
else if (opts.generate) {
  const out = path.resolve(REPO_ROOT, 'output/generation/allure-report');
  runAllure(['generate', resultsDir, '-o', out, '--clean']);
  console.log(`  report      ${path.relative(REPO_ROOT, out)}/index.html`);
} else {
  console.log('  view:  node generation-layer/allure-reporter/build.mjs --serve');
}

// ── API ────────────────────────────────────────────────────────────────────

function convertApi(dir) {
  const src = loadApi();
  if (!src) return null;
  let passed = 0;
  const base = Date.now();
  for (const t of src.tests) {
    const ok = !!t.ok;
    if (ok) passed++;
    const atts = [];
    if (t.bodyPreview) atts.push(attachText(dir, 'response', t.bodyPreview, 'text/plain'));
    writeResult(dir, {
      name: `${t.method} ${shortUrl(t.url)}`,
      fullName: `API#${t.method} ${t.url}`,
      historyId: hash('api#' + t.method + t.url),
      status: ok ? 'passed' : 'failed',
      statusDetails: ok ? {} : { message: t.error || `HTTP ${t.status}`, trace: t.bodyPreview || '' },
      stage: 'finished',
      start: base, stop: base + (t.ms || 0),
      labels: suiteLabels('API'),
      parameters: [
        { name: 'method', value: t.method },
        { name: 'status', value: String(t.status ?? '—') },
        { name: 'timing', value: (t.ms || 0) + 'ms' },
      ],
      attachments: atts,
    });
  }
  // Login as its own test when it failed (a common, important reason).
  if (src.login && src.login.attempted && src.login.ok === false) {
    writeResult(dir, {
      name: 'API login', fullName: 'API#login', historyId: hash('api#login'),
      status: 'failed', statusDetails: { message: src.login.error || 'login failed' },
      stage: 'finished', start: base, stop: base, labels: suiteLabels('API'),
    });
  }
  return { n: src.tests.length, passed, source: src.source };
}

function loadApi() {
  // Prefer api-tests; fall back to openapi-tests. Normalise both shapes.
  const a = readJson(path.join(GEN, 'api-tests', 'results.json'));
  if (a && Array.isArray(a.tests) && a.tests.length) {
    return {
      source: 'api-tests',
      login: a.login,
      tests: a.tests.map((t) => ({
        method: t.method, url: t.url, ok: t.ok, status: t.http_status,
        ms: t.timing_ms, error: t.error, bodyPreview: t.response_body_preview,
      })),
    };
  }
  const o = readJson(path.join(GEN, 'openapi-tests', 'results.json'));
  if (o && Array.isArray(o.results) && o.results.length) {
    return {
      source: 'openapi-tests',
      login: null,
      tests: o.results.map((r) => ({
        method: r.method, url: r.url, ok: r.pass, status: r.actual,
        ms: r.ms,
        error: r.pass ? null : `expected ${r.expected}, got ${r.actual}`,
        bodyPreview: typeof r.response?.body === 'string' ? r.response.body.slice(0, 600)
          : r.response?.body ? JSON.stringify(r.response.body).slice(0, 600) : null,
      })),
    };
  }
  if (a) return { source: 'api-tests', login: a.login, tests: [] }; // present but empty
  return null;
}

// ── UI ─────────────────────────────────────────────────────────────────────

function convertUi(dir) {
  const rr = readJson(path.join(GEN, 'ui-tests', 'run-result.json'));
  if (!rr || !Array.isArray(rr.steps)) return null;
  const uiDir = path.join(GEN, 'ui-tests');
  const base = Date.now();
  let cursor = base;
  let passed = 0;

  const steps = rr.steps.map((s) => {
    if (s.ok) passed++;
    const start = cursor; const stop = cursor + (s.ms || 0); cursor = stop;
    const atts = [];
    const shot = s.screenshot && path.join(uiDir, s.screenshot);
    if (shot && fs.existsSync(shot)) atts.push(attachFile(dir, 'screenshot', shot, 'image/png'));
    return {
      name: s.label,
      status: s.ok ? 'passed' : 'failed',
      statusDetails: s.ok ? {} : { message: s.error || '' },
      stage: 'finished', start, stop, steps: [], attachments: atts, parameters: [],
    };
  });

  const vitalAtt = rr.vitals ? [attachText(dir, 'web-vitals', JSON.stringify(rr.vitals, null, 2), 'application/json')] : [];
  const vitalsFailed = (rr.vitals?.checks || []).some((c) => !c.ok);
  const allPass = rr.steps.every((s) => s.ok);
  const firstFail = rr.steps.find((s) => !s.ok);
  // Surface the concrete failing assertion (not "N steps failed") so Allure's
  // category rules can bucket the reason.
  const uiMessage = allPass
    ? (vitalsFailed ? 'Web Vitals over threshold' : '')
    : `${rr.steps.length - passed}/${rr.steps.length} steps failed — first: ${firstFail?.error || 'unknown'}`;

  writeResult(dir, {
    name: `UI flow: ${rr.name}`,
    fullName: `UI#${rr.name}`,
    historyId: hash('ui#' + rr.name),
    status: allPass ? (vitalsFailed ? 'failed' : 'passed') : 'failed',
    statusDetails: uiMessage ? { message: uiMessage } : {},
    stage: 'finished', start: base, stop: cursor,
    description: `Target: ${rr.baseUrl}\nLogin: ${rr.login?.skipped || (rr.login?.ok ? 'ok' : 'n/a')}`,
    labels: suiteLabels('UI'),
    parameters: (rr.vitals?.checks || []).map((c) => ({ name: c.metric, value: `${c.value}${c.unit} (≤ ${c.threshold}${c.unit}) ${c.ok ? 'OK' : 'OVER'}` })),
    steps, attachments: vitalAtt,
  });
  return { n: rr.steps.length, passed };
}

// ── Perf ───────────────────────────────────────────────────────────────────

function convertPerf(dir) {
  const p = readJson(path.join(GEN, 'ui-tests', 'perf-timing.json'));
  if (!p) return null;
  const base = Date.now();
  const routes = p.routes || [];
  const net = p.network || [];
  const objects = net.filter((n) => n.kind === 'object');
  // API timing: UI-captured app APIs, supplemented with API-test timings (an
  // unauthenticated UI run fires few app APIs, so lean on the API suite's data).
  const uiApis = net.filter((n) => n.kind === 'api');
  const apiSrc = loadApi();
  const testApis = (apiSrc?.tests || []).map((t) => ({ method: t.method, url: t.url, status: t.status, durationMs: t.ms }));
  const byKey = new Map();
  for (const a of [...uiApis, ...testApis]) {
    const k = `${a.method} ${a.url}`;
    if (!byKey.has(k)) byKey.set(k, a);
  }
  const apis = [...byKey.values()];

  const leaf = (name, status = 'passed') => ({ name, status, stage: 'finished', start: base, stop: base, steps: [], attachments: [], parameters: [] });
  const group = (name, kids) => ({ name, status: 'passed', stage: 'finished', start: base, stop: base, steps: kids, attachments: [], parameters: [] });

  const routeSteps = routes.map((r) => leaf(`route ${r.route}: load ${r.loadMs ?? '?'}ms · TTFB ${r.ttfbMs ?? '?'}ms · DCL ${r.domContentLoadedMs ?? '?'}ms`));
  const apiSteps = apis.slice(0, 100).map((a) => leaf(`${a.method} ${shortUrl(a.url)} — ${a.durationMs ?? '?'}ms (${a.status ?? '—'})`));
  const slowObjects = [...objects].sort((x, y) => (y.durationMs || 0) - (x.durationMs || 0)).slice(0, 25);
  const objSteps = slowObjects.map((o) => leaf(`${o.type} ${shortUrl(o.url)} — ${o.durationMs ?? '?'}ms`));

  const atts = [
    attachText(dir, 'routes', JSON.stringify(routes, null, 2), 'application/json'),
    attachText(dir, 'api-timing', toCsv(apis, ['method', 'url', 'status', 'durationMs']), 'text/csv'),
    attachText(dir, 'object-timing', toCsv(objects, ['type', 'url', 'status', 'durationMs']), 'text/csv'),
  ];

  writeResult(dir, {
    name: `Performance timing: ${p.name || 'flow'}`,
    fullName: 'Perf#timing',
    historyId: hash('perf#timing'),
    status: 'passed', stage: 'finished', start: base, stop: base,
    description: 'Captured during the UI run: navigation timing per route, network timing per API call, and per-object resource loading.',
    labels: suiteLabels('Performance'),
    parameters: [
      { name: 'routes', value: String(routes.length) },
      { name: 'api calls', value: String(apis.length) },
      { name: 'objects', value: String(objects.length) },
    ],
    steps: [group('Routes', routeSteps), group('API calls', apiSteps), group(`Objects (slowest ${objSteps.length})`, objSteps)],
    attachments: atts,
  });
  return { routes: routes.length, apis: apis.length, objects: objects.length };
}

// ── Allure result helpers ────────────────────────────────────────────────────

function writeResult(dir, obj) {
  const uuid = crypto.randomUUID();
  fs.writeFileSync(path.join(dir, `${uuid}-result.json`), JSON.stringify({ uuid, ...obj }));
}

function attachText(dir, name, text, type) {
  const ext = type.includes('json') ? 'json' : type.includes('csv') ? 'csv' : 'txt';
  const file = `${crypto.randomUUID()}-attachment.${ext}`;
  fs.writeFileSync(path.join(dir, file), String(text));
  return { name, source: file, type };
}

function attachFile(dir, name, srcPath, type) {
  const ext = path.extname(srcPath).replace('.', '') || 'bin';
  const file = `${crypto.randomUUID()}-attachment.${ext}`;
  fs.copyFileSync(srcPath, path.join(dir, file));
  return { name, source: file, type };
}

function suiteLabels(suite) {
  return [
    { name: 'parentSuite', value: 'Testing Harness' },
    { name: 'suite', value: suite },
    { name: 'feature', value: suite },
    { name: 'framework', value: 'testing-harness' },
  ];
}

function writeEnvironment(dir) {
  const lines = [
    `Generated=${new Date().toISOString()}`,
    `Harness=testing-harness`,
    `Sources=API + UI + Performance`,
  ];
  const rr = readJson(path.join(GEN, 'ui-tests', 'run-result.json'));
  if (rr?.baseUrl) lines.push(`Target=${rr.baseUrl}`);
  if (rr?.name) lines.push(`Scenario=${rr.name}`);
  fs.writeFileSync(path.join(dir, 'environment.properties'), lines.join('\n') + '\n');
}

function writeCategories(dir) {
  // Order matters: Allure assigns the FIRST matching category. Specific
  // (auth / perf / UI) before the generic HTTP status buckets.
  const categories = [
    { name: 'Auth / login failures', matchedStatuses: ['failed', 'broken'], messageRegex: '(?s).*(401|403|\\blogin\\b|sign-?in|auth\\.).*' },
    { name: 'Performance budget exceeded', matchedStatuses: ['failed'], messageRegex: '(?s).*(over threshold|Web Vitals).*' },
    { name: 'UI assertion failures', matchedStatuses: ['failed'], messageRegex: '(?s).*(not visible|missing|expected url|steps failed|title ).*' },
    { name: 'Server errors (5xx)', matchedStatuses: ['failed', 'broken'], messageRegex: '(?s).*(HTTP 5\\d\\d|got 5\\d\\d).*' },
    { name: 'Client / validation (4xx)', matchedStatuses: ['failed'], messageRegex: '(?s).*(HTTP 4\\d\\d|got 4\\d\\d).*' },
  ];
  fs.writeFileSync(path.join(dir, 'categories.json'), JSON.stringify(categories, null, 2));
}

// ── allure CLI ────────────────────────────────────────────────────────────────

function runAllure(args) {
  const hasGlobal = spawnSync('allure', ['--version'], { encoding: 'utf8' }).status === 0;
  const [cmd, cmdArgs] = hasGlobal ? ['allure', args] : ['npx', ['--yes', 'allure-commandline', ...args]];
  console.log(`  $ ${cmd} ${cmdArgs.join(' ')}`);
  if (!hasGlobal) console.log('  (fetching allure-commandline via npx — first run downloads it; needs Java, which is present)');
  const r = spawnSync(cmd, cmdArgs, { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error('  allure failed. Install it (brew install allure) or run manually:');
    console.error(`    npx allure-commandline serve ${path.relative(REPO_ROOT, resultsDir)}`);
  }
}

// ── small utils ───────────────────────────────────────────────────────────────

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function hash(s) { return crypto.createHash('md5').update(s).digest('hex'); }
function shortUrl(u) { try { const x = new URL(u); return x.pathname + (x.search ? '?…' : ''); } catch { return String(u || '').slice(0, 80); } }
function toCsv(rows, cols) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-h': case '--help': out.help = true; break;
      case '--serve': out.serve = true; break;
      case '--generate': out.generate = true; break;
      case '--results-dir': out.resultsDir = argv[++i]; break;
      default: console.error(`allure-reporter: unknown option "${a}"`); process.exit(2);
    }
  }
  return out;
}

function printHelp() {
  console.log(`allure-reporter — consolidate API + UI + Perf into one Allure report

Usage:
  node generation-layer/allure-reporter/build.mjs [--serve | --generate]

  (no flag)     build output/generation/allure-results/ only
  --serve       build, then open the report (npx allure-commandline serve)
  --generate    build, then write static HTML to output/generation/allure-report/

Reads whatever exists: api-tests/openapi-tests results.json, ui-tests/run-result.json
(+ screenshots), ui-tests/perf-timing.json. Run the generators first.
`);
}
