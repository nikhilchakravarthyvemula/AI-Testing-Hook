#!/usr/bin/env node
// ctx — BYO-LLM context CLI (POC for spec-12).
//
// The inversion: this CLI runs the EXISTING deterministic pipeline with its
// internal LLM switched OFF (no MiniMax, no agentic-harness), emits clean JSON,
// and hands the *reasoning* (click-intent classification, semantic enrichment)
// to whatever host agent invoked it — Claude Code / Copilot / Cursor. The host
// writes its annotations back via `ctx annotate-intents`.
//
// Contract: exactly ONE JSON object on stdout; every human/diagnostic line on
// stderr + output/tool-runs/ctx-<runId>.log. Exit 0 ok / 1 stage failed / 2 bad usage.
//
// This folder is a self-contained POC: it depends only on `node` and the
// existing context-layer scripts. It never imports testo/harness.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');      // byo-llm-poc/ sits at repo root
const OUT = path.join(REPO_ROOT, 'output');
const RUN_ENTRY = path.join(REPO_ROOT, 'context-layer', 'content-extractor', 'run.mjs');
const INDEX_ENTRY = path.join(REPO_ROOT, 'context-layer', 'indexer', 'index.mjs');

// ── stdout is JSON-only; everything else goes to stderr + a run log ──────────
let LOG_FILE = null;
function log(...a) {
  const line = a.join(' ');
  process.stderr.write(line + '\n');
  if (LOG_FILE) { try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch { /* best-effort */ } }
}
function emit(obj) { process.stdout.write(JSON.stringify(obj, null, 2) + '\n'); }
function die(msg, code = 2) { log(`[ctx] error: ${msg}`); process.exit(code); }

// ── run id + log file ────────────────────────────────────────────────────────
function newRunId() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const rnd = Math.random().toString(16).slice(2, 9);
  return `run-${ts}-${rnd}`;
}
function openLog(runId) {
  const dir = path.join(OUT, 'tool-runs');
  fs.mkdirSync(dir, { recursive: true });
  LOG_FILE = path.join(dir, `ctx-${runId}.log`);
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// ── run a node script with its stdout/stderr captured to the log (never to our
//    stdout — that channel is reserved for the single JSON envelope) ──────────
function runNode(entry, env, label) {
  return new Promise((resolve) => {
    log(`[ctx] → ${label} (deterministic; internal LLM off)`);
    const child = spawn('node', [entry], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const pipe = (s) => s.on('data', (d) => log(`  [${label}] ` + d.toString().replace(/\n$/, '')));
    pipe(child.stdout); pipe(child.stderr);
    child.on('error', (e) => { log(`[ctx] ✗ ${label} spawn error: ${e.message}`); resolve(1); });
    child.on('exit', (code) => { log(`[ctx] ${code === 0 ? '✓' : '✗'} ${label} exit ${code}`); resolve(code ?? 1); });
  });
}

// ── the deterministic env: switch every internal LLM call OFF (spec-12 §6) ────
// Graphify is NOT skipped: it runs deterministically (direct `python -m
// graphify update`, no LLM) whenever --codebase is given; framework detection
// is deterministic-only by construction now.
function skillModeEnv(extra) {
  return {
    ...process.env,
    CRAWLER_LLM: '0',                 // crawler emits raw clickables, no .intent
    ...extra,
  };
}
function mergeSkip(existing, add) {
  const set = new Set((existing ?? '').split(',').map((s) => s.trim()).filter(Boolean));
  set.add(add);
  return [...set].join(',');
}

// ── intent schema shipped to the host (mirrors crawler/llm-advisor/intent-extract.mjs) ──
const INTENT_SCHEMA = {
  description: 'One object per clickable. Classify conservatively; when unsure use category "unknown" with low confidence and safeToClick:false. Never invent an API call you cannot justify from the visible text/href.',
  fields: {
    id: 'string — echo the clickable id from the input verbatim (the join key)',
    intent: 'kebab-case short verb, e.g. "delete-user"',
    category: 'one of: navigation | mutation | form_submit | external | noop | unknown',
    destructive: 'boolean — true if it mutates/loses data (Delete/Transfer/Remove)',
    expectedApiCall: 'e.g. "DELETE /users/{id}" or null',
    expectedDestination: 'route path, "external", or null',
    humanLabel: 'short human phrase',
    safeToClick: 'boolean — false for anything destructive or unknown',
    confidence: 'number 0..1',
  },
};

// ── build a stable per-clickable id (the identity join key for write-back) ────
function clickableId(pageUrl, kind, c, idx) {
  const sig = [pageUrl, kind, c.text ?? '', c.selector ?? c.href ?? '', idx].join('|');
  // small, stable, human-inspectable
  let h = 0;
  for (let i = 0; i < sig.length; i++) { h = (h * 31 + sig.charCodeAt(i)) | 0; }
  return `cl_${(h >>> 0).toString(16)}`;
}

// ── emit the un-annotated clickables the host must classify (per page) ────────
function writeIntentDelegation(runId) {
  const bundle = readJson(path.join(OUT, 'crawler', 'bundle.json'));
  if (!bundle?.facts?.pages) return null;
  const dir = path.join(OUT, 'delegation', runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'intent-schema.json'), JSON.stringify(INTENT_SCHEMA, null, 2));

  const pageFiles = [];
  let totalClickables = 0;
  for (const [i, page] of (bundle.facts.pages).entries()) {
    const url = page.finalUrl || page.requestedUrl || `page-${i}`;
    const items = [];
    for (const [j, b] of (page.clickables?.buttons ?? []).entries())
      items.push({ id: clickableId(url, 'button', b, j), kind: 'button', text: b.text ?? '', selector: b.selector ?? null, hasIntent: !!b.intent });
    for (const [j, l] of (page.clickables?.links ?? []).entries())
      items.push({ id: clickableId(url, 'link', l, j), kind: 'link', text: l.text ?? '', href: l.href ?? null, selector: l.selector ?? null, hasIntent: !!l.intent });
    if (!items.length) continue;
    const unannotated = items.filter((it) => !it.hasIntent);
    if (!unannotated.length) continue;
    totalClickables += unannotated.length;
    const f = path.join(dir, `page-${String(i).padStart(3, '0')}.json`);
    fs.writeFileSync(f, JSON.stringify({ page: url, clickables: unannotated }, null, 2));
    pageFiles.push(path.relative(REPO_ROOT, f));
  }
  if (!pageFiles.length) return null;
  return {
    kind: 'crawler-intent',
    pending: true,
    reason: 'CRAWLER_LLM=0 (skill mode): clickables emitted un-annotated for host classification',
    input_paths: pageFiles,               // page/batch-scoped (spec-12 §12 B5)
    schema_path: path.relative(REPO_ROOT, path.join(dir, 'intent-schema.json')),
    clickables: totalClickables,
    write_back: `node byo-llm-poc/ctx.mjs annotate-intents ${path.relative(REPO_ROOT, dir)} --run-id ${runId} --json`,
  };
}

// ── commands ──────────────────────────────────────────────────────────────

async function cmdScan(opts) {
  if (!opts.url && !opts.codebase) return die('scan needs --url or --codebase');
  const runId = opts.runId || newRunId();
  openLog(runId);
  const startedAt = new Date().toISOString();

  const stages = [];
  if (!opts.reuse) {
    const env = skillModeEnv({
      ...(opts.url ? { BASE_URL: opts.url } : {}),
      ...(opts.codebase ? { TARGET_CODEBASE: path.resolve(opts.codebase) } : {}),
      ...(opts.url ? {} : { SKIP: mergeSkip(process.env.SKIP, 'crawler') }),
    });
    const extractCode = await runNode(RUN_ENTRY, env, 'content-extractor');
    stages.push({ id: 'content-extractor', ok: extractCode === 0, exitCode: extractCode });
    const indexCode = await runNode(INDEX_ENTRY, env, 'indexer');
    stages.push({ id: 'indexer', ok: indexCode === 0, exitCode: indexCode });
  } else {
    log('[ctx] --reuse: skipping the pipeline, reading existing output/');
  }

  // Synthesize the envelope from ON-DISK artifacts (never from child stdout).
  const extIndex = readJson(path.join(OUT, 'content-extraction-index.json')) || {};
  const idxIndex = readJson(path.join(OUT, 'indexed_output', 'index.json')) || {};
  const crawler = readJson(path.join(OUT, 'crawler', 'bundle.json'));
  const delegation = writeIntentDelegation(runId);

  const topics = idxIndex.topics || {};
  const counts = {
    apis: topics.apis?.count ?? 0,
    pages: topics.pages?.count ?? 0,
    clickEdges: topics['click-graph']?.count ?? 0,
    intentsAnnotated: crawler?.stats?.intentsAnnotated ?? 0,
  };
  const stagesOk = stages.every((s) => s.ok);
  const summary = {
    run_id: runId,
    mode: 'skill',
    startedAt,
    finishedAt: new Date().toISOString(),
    target: { baseUrl: opts.url ?? crawler?.target?.baseUrl ?? null, codebase: opts.codebase ?? null },
    stages,
    counts,
    delegations: delegation ? [delegation] : [],
    consumable: { index: 'output/indexed_output/index.json', topics_dir: 'output/indexed_output/' },
    log: LOG_FILE ? path.relative(REPO_ROOT, LOG_FILE) : null,
  };
  fs.writeFileSync(path.join(OUT, 'run-summary.json'), JSON.stringify(summary, null, 2));

  const ok = opts.reuse ? true : stagesOk;
  emit({ ok, ...summary });
  process.exit(ok ? 0 : 1);
}

// ── write-back: merge host-produced intents by clickable id (identity-keyed) ──
const CATEGORIES = new Set(['navigation', 'mutation', 'form_submit', 'external', 'noop', 'unknown']);
const DESTRUCTIVE_VERBS = new Set(['DELETE', 'PUT', 'POST', 'PATCH']);

// Safety flags are DERIVED here, never trusted from the host (spec-12 §12 B4):
// even a hijacked/hallucinating host cannot mark a destructive control safe.
function deriveSafety(raw) {
  const verb = (raw.expectedApiCall || '').trim().split(/\s+/)[0]?.toUpperCase();
  const destructive =
    raw.category === 'mutation' ||
    (verb && DESTRUCTIVE_VERBS.has(verb)) ||
    /\b(delete|remove|transfer|withdraw|deactivate|revoke|drop)\b/i.test(raw.intent || '');
  const known = CATEGORIES.has(raw.category) && raw.category !== 'unknown';
  const safeToClick = known && !destructive && raw.category !== 'form_submit';
  return { destructive, safeToClick };
}

function validateIntent(raw) {
  if (!raw || typeof raw.id !== 'string') return null;
  const category = CATEGORIES.has(raw.category) ? raw.category : 'unknown';
  const conf = Math.max(0, Math.min(1, Number(raw.confidence) || 0));
  const { destructive, safeToClick } = deriveSafety({ ...raw, category });
  return {
    id: raw.id,
    intent: String(raw.intent ?? 'unknown').slice(0, 80),
    category,
    destructive,                       // derived
    safeToClick,                       // derived
    expectedApiCall: raw.expectedApiCall ? String(raw.expectedApiCall).slice(0, 120) : null,
    expectedDestination: raw.expectedDestination ? String(raw.expectedDestination).slice(0, 200) : null,
    humanLabel: String(raw.humanLabel ?? '').slice(0, 120),
    confidence: conf,
  };
}

function buildIdMap(bundle) {
  const map = new Map();
  for (const [i, page] of (bundle.facts?.pages ?? []).entries()) {
    const url = page.finalUrl || page.requestedUrl || `page-${i}`;
    (page.clickables?.buttons ?? []).forEach((b, j) => map.set(clickableId(url, 'button', b, j), b));
    (page.clickables?.links ?? []).forEach((l, j) => map.set(clickableId(url, 'link', l, j), l));
  }
  return map;
}

function loadHostIntents(target) {
  const p = path.resolve(target);
  let file = p;
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) file = path.join(p, 'host-intents.json');
  const data = readJson(file);
  if (data == null) return { file, intents: null };
  const intents = Array.isArray(data) ? data : (Array.isArray(data.intents) ? data.intents : null);
  return { file, intents };
}

async function cmdAnnotateIntents(opts) {
  const target = (opts._ || [])[0];
  if (!target) return die('annotate-intents needs a host-intents file or delegation dir');
  const runId = opts.runId || 'adhoc';
  openLog(runId);

  const { file, intents } = loadHostIntents(target);
  if (!Array.isArray(intents)) return die(`no host intents array at ${file} (expected [] or {intents:[]})`, 1);

  const bundlePath = path.join(OUT, 'crawler', 'bundle.json');
  const bundle = readJson(bundlePath);
  if (!bundle) return die('no output/crawler/bundle.json — run `ctx scan` first', 1);
  const idMap = buildIdMap(bundle);

  let merged = 0, rejectedShape = 0, rejectedUnknownId = 0;
  for (const raw of intents) {
    const v = validateIntent(raw);
    if (!v) { rejectedShape++; continue; }
    const target = idMap.get(v.id);
    if (!target) { rejectedUnknownId++; log(`[ctx]   ↳ reject: id not in bundle: ${v.id}`); continue; }
    const { id, ...intent } = v;
    target.intent = intent;   // identity-keyed attach
    merged++;
  }

  // refresh the counter honestly
  let count = 0;
  for (const p of bundle.facts?.pages ?? []) {
    for (const b of p.clickables?.buttons ?? []) if (b.intent) count++;
    for (const l of p.clickables?.links ?? []) if (l.intent) count++;
  }
  bundle.stats = bundle.stats || {};
  bundle.stats.intentsAnnotated = count;
  fs.writeFileSync(bundlePath, JSON.stringify(bundle, null, 2));
  log(`[ctx] merged ${merged} intents (rejected: ${rejectedShape} malformed, ${rejectedUnknownId} unknown-id); bundle now has ${count} annotated`);

  // re-index so click-graph reflects the host's intents
  const idxCode = await runNode(INDEX_ENTRY, process.env, 'indexer');

  const ok = idxCode === 0 && merged > 0;
  emit({
    ok,
    run_id: runId,
    tool: 'annotate-intents',
    counts: { merged, rejectedMalformed: rejectedShape, rejectedUnknownId, intentsAnnotated: count },
    reindexed: idxCode === 0,
    delegation: { kind: 'crawler-intent', pending: false },
    log: LOG_FILE ? path.relative(REPO_ROOT, LOG_FILE) : null,
  });
  process.exit(ok ? 0 : 1);
}

function cmdContext(opts) {
  const idx = readJson(path.join(OUT, 'indexed_output', 'index.json'));
  if (!idx) return die('no output/indexed_output/index.json — run `ctx scan` first', 1);
  if (opts.topic) {
    const meta = (idx.topics || {})[opts.topic];
    if (!meta) return die(`unknown topic "${opts.topic}". Available: ${Object.keys(idx.topics || {}).join(', ')}`, 1);
    const data = readJson(path.join(OUT, 'indexed_output', meta.file));
    emit({ ok: true, topic: opts.topic, count: meta.count, items: data?.items ?? data });
  } else {
    emit({ ok: true, target: idx.target ?? null, topics: idx.topics ?? {} });
  }
}

// ── generate / execute: shell the deterministic api-test-generator skill ─────
// CLI owns the loop (Deepline pattern): the host only reads the JSON envelope.
// Credentials travel via inherited env (LOGIN_EMAIL/LOGIN_PASSWORD) ONLY —
// there are no credential flags, so secrets never appear in argv/ps.
const SKILL_RESULT_MARKER = '[call_skill:result] ';

function runSkill(kv, label) {
  const py = path.join(REPO_ROOT, 'context-layer', 'content-extractor', '_lib', '.venv', 'bin', 'python');
  const call = path.join(REPO_ROOT, 'testo', 'skill-register', 'bin', 'call_skill.py');
  const argv = [call, 'api-test-generator', '--mode', 'direct', '--json'];
  for (const [k, v] of Object.entries(kv)) {
    if (v !== null && v !== undefined && v !== '' && v !== 0) argv.push(`--${k}`, String(v));
  }
  return new Promise((resolve) => {
    log(`[ctx] → ${label} (deterministic; no LLM)`);
    const child = spawn(py, argv, { cwd: REPO_ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let result = null;
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (line.startsWith(SKILL_RESULT_MARKER)) {
          try { result = JSON.parse(line.slice(SKILL_RESULT_MARKER.length)); } catch { /* keep null */ }
        } else {
          log(`  [${label}] ${line}`);
        }
      }
    });
    child.stderr.on('data', (d) => log(`  [${label}] ` + d.toString().replace(/\n$/, '')));
    child.on('error', (e) => { log(`[ctx] ✗ ${label} spawn error: ${e.message}`); resolve({ code: 1, result: null }); });
    child.on('exit', (code) => { log(`[ctx] ${code === 0 ? '✓' : '✗'} ${label} exit ${code}`); resolve({ code: code ?? 1, result }); });
  });
}

async function cmdGenerate(opts) {
  if (!readJson(path.join(OUT, 'indexed_output', 'apis.json')))
    return die('no output/indexed_output/apis.json — run `ctx scan` first', 1);
  const runId = opts.runId || newRunId();
  openLog(runId);
  const { code, result } = await runSkill(
    { execute: 'false', base_url: opts.url || null, max_tests: opts.maxTests || null }, 'generate');
  const r = result || {};
  log(`[generator] ${r.curls_generated ?? 0} curls generated → output/generation/api-tests/curls/`);
  const ok = code === 0 && !!r.ok;
  emit({
    ok, run_id: runId, tool: 'generate',
    counts: { curls_generated: r.curls_generated ?? 0 },
    output: 'output/generation/api-tests/',
    results: 'output/generation/api-tests/results.json',
    error: r.error ?? null,
    log: LOG_FILE ? path.relative(REPO_ROOT, LOG_FILE) : null,
  });
  process.exit(ok ? 0 : 1);
}

async function cmdExecute(opts) {
  if (!readJson(path.join(OUT, 'indexed_output', 'apis.json')))
    return die('no output/indexed_output/apis.json — run `ctx scan` first', 1);
  const runId = opts.runId || newRunId();
  openLog(runId);
  const { code, result } = await runSkill(
    { execute: 'true', base_url: opts.url || null, max_tests: opts.maxTests || null }, 'execute');
  const r = result || {};
  log(`[generator] ${r.curls_generated ?? 0} curls generated → output/generation/api-tests/curls/`);
  log(`[executor] ${r.curls_executed ?? 0} tests run — ${r.passed ?? 0} passed, ${r.failed ?? 0} failed, ${r.skipped ?? 0} skipped`);
  const ok = code === 0 && !!r.ok;
  emit({
    ok, run_id: runId, tool: 'execute',
    counts: {
      curls_generated: r.curls_generated ?? 0,
      executed: r.curls_executed ?? 0,
      passed: r.passed ?? 0,
      failed: r.failed ?? 0,
      skipped: r.skipped ?? 0,
    },
    loginOk: r.login_succeeded ?? false,
    results: 'output/generation/api-tests/results.json',
    report: 'output/generation/api-tests/report.md',
    error: r.error ?? null,
    log: LOG_FILE ? path.relative(REPO_ROOT, LOG_FILE) : null,
  });
  process.exit(ok ? 0 : 1);
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const opts = parseArgs(rest);
  switch (cmd) {
    case 'scan': return cmdScan(opts);
    case 'context': return cmdContext(opts);
    case 'annotate-intents': return cmdAnnotateIntents(opts);
    case 'generate': return cmdGenerate(opts);
    case 'execute': return cmdExecute(opts);
    case 'help': case '-h': case '--help': case undefined: return printHelp();
    default: return die(`unknown command "${cmd}". Try: ctx help`);
  }
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--url': o.url = next(); break;
      case '--codebase': case '--code': o.codebase = next(); break;
      case '--topic': o.topic = next(); break;
      case '--run-id': o.runId = next(); break;
      case '--reuse': o.reuse = true; break;
      case '--max-tests': o.maxTests = parseInt(next(), 10) || 0; break;
      case '--json': o.json = true; break;   // accepted; JSON is always the output
      default:
        if (a.startsWith('-')) return die(`unknown option "${a}"`);
        o._ = (o._ ?? []).concat(a);
    }
  }
  return o;
}

function printHelp() {
  process.stderr.write(`ctx — BYO-LLM context CLI (POC)

Runs the deterministic pipeline (internal LLM off) and emits clean JSON for a
host agent to reason over. The host classifies intents and writes them back.

Commands:
  ctx scan --url <URL> [--codebase <PATH>] [--reuse] [--json]
        Run the deterministic scan (incl. graphify when --codebase is given);
        emit a run-summary + a delegation block listing the un-annotated
        clickables the host must classify.
        --reuse skips the pipeline and reads existing output/ (fast demo).
  ctx context [--topic apis|pages|click-graph|...] [--json]
        Emit the consumable indexed context (or one topic) for the host.
  ctx annotate-intents <delegation-dir> --run-id R [--json]
        Merge host-produced click-intents back into the crawler bundle.
  ctx generate [--url <URL>] [--max-tests N] [--json]
        Build curl API tests from the indexed context (writes only, no run).
  ctx execute [--url <URL>] [--max-tests N] [--json]
        Generate AND run the API tests against the live target.
        Login creds via env: LOGIN_EMAIL / LOGIN_PASSWORD (never flags).

Every command prints exactly one JSON object to stdout; logs go to stderr.
`);
}

main();
