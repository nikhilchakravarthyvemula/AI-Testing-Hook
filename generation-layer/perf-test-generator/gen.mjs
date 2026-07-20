#!/usr/bin/env node
// perf-test-generator — scenario.json → JMeter load-test plan (.jmx).
//
// Deterministic, zero-LLM. Generation needs NOTHING installed (pure string
// template → XML). Executing the plan needs Java + JMeter on PATH, which is
// opt-in (--run) — by default this just emits the artifact: a .jmx HSBC perf
// engineers can open in the JMeter GUI, plus a run script and a .jtl parser.
//
// Pipeline:
//   1. read scenario.json → perf.httpFlow + perf.jmeter
//   2. emit output/generation/perf-tests/plan.jmx       (Thread Group + samplers)
//   3. validate: re-parse the XML for well-formedness
//   4. emit run-perf.sh + parse-jtl.mjs
//   5. (--run, if jmeter present) execute, then parse results.jtl vs thresholds
//   6. write results.json + report.md (house shape)
//
// Auth note: against OAuth/PKCE targets (e.g. superalign/Keycloak) a bearer
// token can't be auto-captured, so the plan parameterises it as ${__P(token)}
// — pass `-Jtoken=<JWT>` to run-perf.sh. Stated in the report.
//
// Usage:
//   node generation-layer/perf-test-generator/gen.mjs scenario.json
//   node generation-layer/perf-test-generator/gen.mjs scenario.json --run   # needs jmeter
//   node generation-layer/perf-test-generator/gen.mjs scenario.json --url https://staging...

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadRepoEnv } from '../../testo/_lib/load-env.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

loadRepoEnv(REPO_ROOT);

// Generated helper-file contents (declared up-front: module-level imperative
// code below runs top-to-bottom, before any `const` later in the file).
const RUN_PERF_SH = `#!/usr/bin/env bash
# Run the generated JMeter plan headless and check thresholds.
#   TOKEN=<JWT> bash run-perf.sh        # auth'd endpoints
#   bash run-perf.sh                    # no auth
set -uo pipefail
HERE="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"

if ! command -v jmeter >/dev/null 2>&1; then
  echo "[run-perf] ERROR: jmeter not on PATH. Install Apache JMeter (brew install jmeter)." >&2
  exit 2
fi

rm -f "$HERE/results.jtl"
echo "[run-perf] jmeter -n -t plan.jmx -l results.jtl -Jtoken=***"
jmeter -n -t "$HERE/plan.jmx" -l "$HERE/results.jtl" -Jtoken="\${TOKEN:-}" -j "$HERE/jmeter.log"

echo "[run-perf] parsing results…"
node "$HERE/parse-jtl.mjs" "$HERE/results.jtl"
`;

const PARSE_JTL_MJS = `#!/usr/bin/env node
// Parse a JMeter results.jtl (CSV) → p50/p95/p99 + error-rate.
import fs from 'node:fs';
const file = process.argv[2] || 'results.jtl';
if (!fs.existsSync(file)) { console.error('no ' + file); process.exit(2); }
const lines = fs.readFileSync(file, 'utf8').split('\\n').filter((l) => l.trim());
const header = lines[0].split(',');
const iE = header.indexOf('elapsed'), iS = header.indexOf('success');
const el = []; let err = 0, n = 0;
for (let i = 1; i < lines.length; i++) {
  const c = lines[i].split(',');
  if (iE >= 0) el.push(Number(c[iE]));
  if (iS >= 0 && c[iS] === 'false') err++;
  n++;
}
el.sort((a, b) => a - b);
const pct = (p) => (el.length ? el[Math.min(el.length - 1, Math.floor((p / 100) * el.length))] : 0);
console.log('samples=' + n + ' errors=' + err + ' (' + (n ? (100 * err / n).toFixed(2) : 0) + '%)');
console.log('p50=' + pct(50) + 'ms p95=' + pct(95) + 'ms p99=' + pct(99) + 'ms max=' + (el[el.length - 1] || 0) + 'ms');
`;

const opts = parseArgs(process.argv.slice(2));
if (opts.help || !opts.scenario) { printHelp(); process.exit(opts.help ? 0 : 2); }

const scenarioPath = path.resolve(process.cwd(), opts.scenario);
if (!fs.existsSync(scenarioPath)) {
  console.error(`perf-test-generator: scenario not found: ${scenarioPath}`);
  process.exit(2);
}

let scenario;
try {
  scenario = JSON.parse(fs.readFileSync(scenarioPath, 'utf8'));
} catch (e) {
  console.error(`perf-test-generator: scenario.json is not valid JSON — ${e.message}`);
  process.exit(2);
}

const baseUrl = (opts.url || scenario.baseUrl || process.env.BASE_URL || '').replace(/\/$/, '');
const perf = scenario.perf || {};
const httpFlow = Array.isArray(perf.httpFlow) ? perf.httpFlow : [];
const jm = perf.jmeter || {};
const profile = {
  vus: int(jm.vus, 10),
  rampUpS: int(jm.rampUpS, 5),
  durationS: int(jm.durationS, 30),
  p95Ms: jm.thresholds?.p95Ms ?? null,
  errorRatePct: jm.thresholds?.errorRatePct ?? null,
};

if (!baseUrl) { console.error('perf-test-generator: no baseUrl (scenario.baseUrl / --url / BASE_URL).'); process.exit(2); }
if (!httpFlow.length) { console.error('perf-test-generator: scenario.perf.httpFlow is empty — nothing to load-test.'); process.exit(2); }

const { origin, basePath } = splitUrl(baseUrl);
const outDir = path.resolve(REPO_ROOT, opts.outputDir || 'output/generation/perf-tests');
fs.mkdirSync(outDir, { recursive: true });

// ── emit plan.jmx ─────────────────────────────────────────────────────────────

const jmxPath = path.join(outDir, 'plan.jmx');
fs.writeFileSync(jmxPath, buildJmx({ name: scenario.name || 'perf-plan', origin, basePath, httpFlow, profile }));

console.log('━━━━━━━━━━ perf-test-generator ━━━━━━━━━━');
console.log(`  scenario    ${scenario.name}`);
console.log(`  target      ${baseUrl}`);
console.log(`  profile     ${profile.vus} VUs · ${profile.rampUpS}s ramp · ${profile.durationS}s`);
console.log(`  samplers    ${httpFlow.length}`);
console.log(`  emitted     ${path.relative(REPO_ROOT, jmxPath)}`);

// ── validate (well-formedness) ────────────────────────────────────────────────

const wf = checkWellFormed(fs.readFileSync(jmxPath, 'utf8'));
if (!wf.ok) {
  console.error(`perf-test-generator: emitted .jmx is not well-formed XML — ${wf.error}`);
  process.exit(1);
}
console.log(`  validate    ✓ well-formed XML (${wf.tags} tags)`);

// ── emit run script + parser ──────────────────────────────────────────────────

fs.writeFileSync(path.join(outDir, 'run-perf.sh'), RUN_PERF_SH);
fs.chmodSync(path.join(outDir, 'run-perf.sh'), 0o755);
fs.writeFileSync(path.join(outDir, 'parse-jtl.mjs'), PARSE_JTL_MJS);
fs.chmodSync(path.join(outDir, 'parse-jtl.mjs'), 0o755);

// ── optional execute ──────────────────────────────────────────────────────────

let execResult = null;
const jmeterOnPath = spawnSync('jmeter', ['--version'], { encoding: 'utf8' }).status === 0;

if (opts.run) {
  if (!jmeterOnPath) {
    console.error('  run         ✗ `jmeter` not on PATH — install Apache JMeter or drop --run.');
  } else {
    console.log('  run         executing jmeter (non-GUI)…');
    const token = opts.token || process.env.PERF_TOKEN || '';
    const r = spawnSync('bash', [path.join(outDir, 'run-perf.sh')], {
      cwd: outDir, encoding: 'utf8', stdio: 'inherit',
      env: { ...process.env, TOKEN: token },
    });
    const jtl = path.join(outDir, 'results.jtl');
    if (r.status === 0 && fs.existsSync(jtl)) {
      execResult = parseJtl(fs.readFileSync(jtl, 'utf8'), profile);
    } else {
      console.error('  run         ✗ jmeter run failed or produced no results.jtl');
    }
  }
} else {
  console.log(`  run         SKIPPED (generate-only; ${jmeterOnPath ? 'jmeter available — add --run to execute' : 'jmeter not installed'})`);
}

// ── report ────────────────────────────────────────────────────────────────────

writeReports(outDir, { scenario: scenario.name, baseUrl, profile, httpFlow, execResult, jmeterOnPath });
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`  report      ${path.relative(REPO_ROOT, path.join(outDir, 'report.md'))}`);
console.log(`  to run      bash ${path.relative(REPO_ROOT, path.join(outDir, 'run-perf.sh'))}   (set TOKEN=<jwt> for auth'd endpoints)`);
process.exit(0);

// ── JMeter .jmx builder ───────────────────────────────────────────────────────

function buildJmx({ name, origin, basePath, httpFlow, profile }) {
  const { host, port, protocol } = parseOrigin(origin);
  const samplers = httpFlow.map((h, i) => sampler(h, i, basePath)).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<jmeterTestPlan version="1.2" properties="5.0" jmeter="5.6.3">
  <hashTree>
    <TestPlan guiclass="TestPlanGui" testclass="TestPlan" testname="${xml(name)}" enabled="true">
      <boolProp name="TestPlan.functional_mode">false</boolProp>
      <boolProp name="TestPlan.serialize_threadgroups">false</boolProp>
      <elementProp name="TestPlan.user_defined_variables" elementType="Arguments" guiclass="ArgumentsPanel" testclass="Arguments" testname="User Defined Variables" enabled="true">
        <collectionProp name="Arguments.arguments"/>
      </elementProp>
      <stringProp name="TestPlan.comments">Generated by perf-test-generator from scenario "${xml(name)}".</stringProp>
    </TestPlan>
    <hashTree>
      <ConfigTestElement guiclass="HttpDefaultsGui" testclass="ConfigTestElement" testname="HTTP Request Defaults" enabled="true">
        <stringProp name="HTTPSampler.domain">${xml(host)}</stringProp>
        <stringProp name="HTTPSampler.port">${xml(port)}</stringProp>
        <stringProp name="HTTPSampler.protocol">${xml(protocol)}</stringProp>
        <stringProp name="HTTPSampler.connect_timeout">10000</stringProp>
        <stringProp name="HTTPSampler.response_timeout">30000</stringProp>
        <elementProp name="HTTPsampler.Arguments" elementType="Arguments"><collectionProp name="Arguments.arguments"/></elementProp>
      </ConfigTestElement>
      <hashTree/>
      <HeaderManager guiclass="HeaderPanel" testclass="HeaderManager" testname="HTTP Header Manager" enabled="true">
        <collectionProp name="HeaderManager.headers">
          <elementProp name="" elementType="Header">
            <stringProp name="Header.name">Authorization</stringProp>
            <stringProp name="Header.value">Bearer \${__P(token,)}</stringProp>
          </elementProp>
          <elementProp name="" elementType="Header">
            <stringProp name="Header.name">Accept</stringProp>
            <stringProp name="Header.value">application/json</stringProp>
          </elementProp>
        </collectionProp>
      </HeaderManager>
      <hashTree/>
      <ThreadGroup guiclass="ThreadGroupGui" testclass="ThreadGroup" testname="Load - ${xml(name)}" enabled="true">
        <stringProp name="ThreadGroup.num_threads">${profile.vus}</stringProp>
        <stringProp name="ThreadGroup.ramp_time">${profile.rampUpS}</stringProp>
        <boolProp name="ThreadGroup.scheduler">true</boolProp>
        <stringProp name="ThreadGroup.duration">${profile.durationS}</stringProp>
        <stringProp name="ThreadGroup.on_sample_error">continue</stringProp>
        <elementProp name="ThreadGroup.main_controller" elementType="LoopController" guiclass="LoopControlPanel" testclass="LoopController" testname="Loop Controller" enabled="true">
          <boolProp name="LoopController.continue_forever">true</boolProp>
          <stringProp name="LoopController.loops">-1</stringProp>
        </elementProp>
      </ThreadGroup>
      <hashTree>
${samplers}
        <ResultCollector guiclass="SummaryReport" testclass="ResultCollector" testname="Summary Report" enabled="true">
          <boolProp name="ResultCollector.error_logging">false</boolProp>
          <stringProp name="filename">results.jtl</stringProp>
        </ResultCollector>
        <hashTree/>
        <ResultCollector guiclass="StatVisualizer" testclass="ResultCollector" testname="Aggregate Report" enabled="true">
          <boolProp name="ResultCollector.error_logging">false</boolProp>
          <stringProp name="filename"></stringProp>
        </ResultCollector>
        <hashTree/>
      </hashTree>
    </hashTree>
  </hashTree>
</jmeterTestPlan>
`;
}

function sampler(h, i, basePath) {
  const method = (h.method || 'GET').toUpperCase();
  const fullPath = joinPath(basePath, h.path || '/');
  const body = h.body != null ? JSON.stringify(h.body) : '';
  const bodyArg = body
    ? `        <elementProp name="HTTPsampler.Arguments" elementType="Arguments">
          <collectionProp name="Arguments.arguments">
            <elementProp name="" elementType="HTTPArgument">
              <boolProp name="HTTPArgument.always_encode">false</boolProp>
              <stringProp name="Argument.value">${xml(body)}</stringProp>
              <stringProp name="Argument.metadata">=</stringProp>
            </elementProp>
          </collectionProp>
        </elementProp>
        <boolProp name="HTTPSampler.postBodyRaw">true</boolProp>`
    : `        <elementProp name="HTTPsampler.Arguments" elementType="Arguments"><collectionProp name="Arguments.arguments"/></elementProp>`;
  return `        <HTTPSamplerProxy guiclass="HttpTestSampleGui" testclass="HTTPSamplerProxy" testname="${xml(method)} ${xml(h.path || '/')}" enabled="true">
${bodyArg}
          <stringProp name="HTTPSampler.path">${xml(fullPath)}</stringProp>
          <stringProp name="HTTPSampler.method">${xml(method)}</stringProp>
          <boolProp name="HTTPSampler.follow_redirects">true</boolProp>
          <boolProp name="HTTPSampler.use_keepalive">true</boolProp>
        </HTTPSamplerProxy>
        <hashTree/>`;
}

// ── .jtl parsing (CSV) — shared by inline exec + parse-jtl.mjs ────────────────

function parseJtl(text, profile) {
  const lines = text.split('\n').filter((l) => l.trim());
  if (!lines.length) return { samples: 0, error: 'empty results.jtl' };
  const header = lines[0].split(',');
  const iElapsed = header.indexOf('elapsed');
  const iSuccess = header.indexOf('success');
  const elapsed = [];
  let errors = 0, n = 0;
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (iElapsed >= 0 && cols[iElapsed] != null) elapsed.push(Number(cols[iElapsed]));
    if (iSuccess >= 0 && cols[iSuccess] === 'false') errors++;
    n++;
  }
  elapsed.sort((a, b) => a - b);
  const pct = (p) => (elapsed.length ? elapsed[Math.min(elapsed.length - 1, Math.floor((p / 100) * elapsed.length))] : 0);
  const errorRatePct = n ? Math.round((10000 * errors) / n) / 100 : 0;
  const p95 = pct(95);
  const checks = [];
  if (profile.p95Ms != null) checks.push({ metric: 'p95Ms', value: p95, threshold: profile.p95Ms, ok: p95 <= profile.p95Ms });
  if (profile.errorRatePct != null) checks.push({ metric: 'errorRatePct', value: errorRatePct, threshold: profile.errorRatePct, ok: errorRatePct <= profile.errorRatePct });
  return { samples: n, errors, errorRatePct, p50: pct(50), p95, p99: pct(99), max: elapsed[elapsed.length - 1] || 0, checks };
}

// ── reports ───────────────────────────────────────────────────────────────────

function writeReports(dir, ctx) {
  const summary = {
    generatedAt: new Date().toISOString(),
    kind: 'perf-tests',
    scenario: ctx.scenario,
    target: ctx.baseUrl,
    profile: ctx.profile,
    httpFlow: ctx.httpFlow,
    jmeterOnPath: ctx.jmeterOnPath,
    execution: ctx.execResult,
  };
  fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify(summary, null, 2));

  const L = [];
  L.push('# Performance Test (JMeter) Report');
  L.push('');
  L.push(`_generated ${summary.generatedAt}_`);
  L.push('');
  L.push(`- scenario: **${ctx.scenario}**`);
  L.push(`- target:   \`${ctx.baseUrl}\``);
  L.push(`- profile:  **${ctx.profile.vus} VUs**, ${ctx.profile.rampUpS}s ramp-up, ${ctx.profile.durationS}s duration`);
  L.push('');
  L.push('## Plan');
  L.push(`- artifact: \`plan.jmx\` (open in the JMeter GUI, or run headless)`);
  L.push(`- samplers (${ctx.httpFlow.length}):`);
  for (const h of ctx.httpFlow) L.push(`  - \`${(h.method || 'GET').toUpperCase()} ${h.path}\`${h.auth ? '  (auth)' : ''}`);
  L.push('');
  L.push('## Auth');
  L.push('- Token is parameterised as `${__P(token)}` → `Authorization: Bearer …`.');
  L.push('- OAuth/PKCE targets (Keycloak/superalign) can\'t auto-mint a token; pass one:');
  L.push('  ```bash');
  L.push('  TOKEN=<JWT> bash run-perf.sh');
  L.push('  ```');
  L.push('');
  L.push('## Thresholds');
  L.push(`- p95 ≤ ${ctx.profile.p95Ms ?? '—'}ms`);
  L.push(`- error-rate ≤ ${ctx.profile.errorRatePct ?? '—'}%`);
  L.push('');
  L.push('## Result');
  if (!ctx.execResult) {
    L.push(ctx.jmeterOnPath
      ? '- not executed (generate-only). Run with `--run` or `bash run-perf.sh`.'
      : '- not executed — JMeter is not installed here. The `.jmx` is ready to run where JMeter is available.');
  } else {
    const e = ctx.execResult;
    L.push(`- samples: **${e.samples}**  (errors: ${e.errors}, ${e.errorRatePct}%)`);
    L.push(`- latency: p50 ${e.p50}ms · **p95 ${e.p95}ms** · p99 ${e.p99}ms · max ${e.max}ms`);
    for (const c of e.checks || []) L.push(`- ${c.ok ? '✓' : '✗'} ${c.metric} = ${c.value} (≤ ${c.threshold})`);
  }
  L.push('');
  fs.writeFileSync(path.join(dir, 'report.md'), L.join('\n') + '\n');
}

// ── small utils ────────────────────────────────────────────────────────────────

function xml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function int(v, d) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }
function splitUrl(u) {
  try { const x = new URL(u); return { origin: x.origin, basePath: x.pathname.replace(/\/$/, '') }; }
  catch { return { origin: u, basePath: '' }; }
}
function parseOrigin(origin) {
  try {
    const x = new URL(origin);
    const protocol = x.protocol.replace(':', '');
    const port = x.port || (protocol === 'https' ? '443' : '80');
    return { host: x.hostname, port, protocol };
  } catch { return { host: origin, port: '443', protocol: 'https' }; }
}
function joinPath(base, p) {
  const b = (base || '').replace(/\/$/, '');
  const q = p.startsWith('/') ? p : '/' + p;
  return (b + q) || '/';
}

function checkWellFormed(xmlText) {
  // No XML lib in deps — do a lightweight balance check: every <tag ...> has a
  // matching </tag> (ignoring self-closing <tag/> and the <?xml ?> prolog).
  const stack = [];
  let tags = 0;
  const re = /<\/?([A-Za-z_][\w.-]*)(\s[^>]*?)?(\/?)>/g;
  let m;
  while ((m = re.exec(xmlText))) {
    const [, name, , selfClose] = m;
    if (m[0].startsWith('<?') ) continue;
    tags++;
    if (m[0].startsWith('</')) {
      if (!stack.length || stack.pop() !== name) return { ok: false, error: `unbalanced </${name}>` };
    } else if (!selfClose) {
      stack.push(name);
    }
  }
  if (stack.length) return { ok: false, error: `unclosed <${stack[stack.length - 1]}>` };
  return { ok: true, tags };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '-h':
      case '--help': out.help = true; break;
      case '--run': out.run = true; break;
      case '--token': out.token = next(); break;
      case '--url': out.url = next(); break;
      case '--output-dir':
      case '--output': out.outputDir = next(); break;
      default:
        if (a.startsWith('-')) { console.error(`perf-test-generator: unknown option "${a}"`); process.exit(2); }
        else if (!out.scenario) out.scenario = a;
        else { console.error(`perf-test-generator: unexpected arg "${a}"`); process.exit(2); }
    }
  }
  return out;
}

function printHelp() {
  console.log(`perf-test-generator — scenario.json → JMeter .jmx load-test plan

Usage:
  node generation-layer/perf-test-generator/gen.mjs <scenario.json> [options]

Options:
  --run               execute the plan now (requires Apache JMeter on PATH)
  --token <JWT>       bearer token for auth'd samplers (or set TOKEN/PERF_TOKEN env)
  --url <URL>         override scenario.baseUrl
  --output-dir <DIR>  default: output/generation/perf-tests
  -h, --help          this help

Generates plan.jmx + run-perf.sh + parse-jtl.mjs. Generation needs nothing
installed; only --run requires JMeter.
`);
}
