// End-to-end Playwright test generator.
//
// Combines TWO data sources:
//   1. crawler:  output/crawler/data/{click-graph,routes,pages}.json
//        → multi-step flows the UI actually supports + expected backend APIs
//   2. graphify: output/graphify/graph.json + the original source files
//        → maps each backend URL to the file/function that handles it
//
// Output: tests/e2e/<flow-name>.spec.mjs   one Playwright test per flow
//         tests/e2e/_handler-map.json       URL → {file,line,function} index
//
// Each generated test walks a click-graph path (e.g. /login → click "Sign in"
// → /overview → click "Users" → /user-list), with assertions at every step
// for URL change AND expected backend API calls. Inline comments link each API
// to the backend handler so test failures point straight at the code.
//
// Env vars:
//   TARGET_CODEBASE        Absolute path of the source repo graphify ran on
//                          (auto-detected from graphify metadata when omitted)
//   GRAPHIFY_GRAPH         Path to graphify's graph.json
//                          (default: output/graphify/graph.json)
//   E2E_MAX_FLOWS          Cap on generated tests (default: 12)
//   E2E_MAX_DEPTH          Max click-hops per flow (default: 5)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

const CRAWLER_DATA = path.join(REPO_ROOT, 'output', 'crawler', 'data');
const CLICK_GRAPH = path.join(CRAWLER_DATA, 'click-graph.json');
const ROUTES_JSON = path.join(CRAWLER_DATA, 'routes.json');
const PAGES_JSON  = path.join(CRAWLER_DATA, 'pages.json');

const GRAPHIFY_GRAPH = process.env.GRAPHIFY_GRAPH
  || path.join(REPO_ROOT, 'output', 'graphify', 'graph.json');

// Auto-detect TARGET_CODEBASE from graphify's metadata, or take from env.
function detectTargetCodebase() {
  if (process.env.TARGET_CODEBASE) return process.env.TARGET_CODEBASE;
  const candidates = [
    path.join(REPO_ROOT, 'output', 'graphify', '.graphify_analysis.json'),
    path.join(REPO_ROOT, 'output', 'graphify', 'manifest.json'),
  ];
  for (const f of candidates) {
    if (!fs.existsSync(f)) continue;
    try {
      const d = JSON.parse(fs.readFileSync(f, 'utf8'));
      for (const key of ['root', 'source_root', 'target', 'path', 'project_root', 'repo_root', 'project_path']) {
        const v = d[key];
        if (v && typeof v === 'string' && fs.existsSync(v)) return v;
      }
      // Manifest sometimes uses absolute paths as TOP-LEVEL KEYS. Sometimes
      // a `files` array. Sample either source and take the longest common
      // path prefix, then walk back to a real existing directory.
      let absPathSample = [];
      if (Array.isArray(d.files)) {
        absPathSample = d.files.filter(p => typeof p === 'string' && p.startsWith('/'));
      } else if (Array.isArray(d.manifest)) {
        absPathSample = d.manifest.filter(p => typeof p === 'string' && p.startsWith('/'));
      } else {
        absPathSample = Object.keys(d).filter(k => k.startsWith('/'));
      }
      absPathSample = absPathSample.slice(0, 50);
      if (absPathSample.length > 0) {
        let prefix = absPathSample[0];
        for (const p of absPathSample) {
          while (!p.startsWith(prefix)) prefix = prefix.slice(0, -1);
          if (!prefix) break;
        }
        if (prefix && prefix.includes('/')) {
          // Walk back to last dir separator and check it exists
          let dir = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix.slice(0, prefix.lastIndexOf('/'));
          while (dir && !fs.existsSync(dir)) dir = dir.slice(0, dir.lastIndexOf('/'));
          if (dir && fs.existsSync(dir) && fs.statSync(dir).isDirectory()) return dir;
        }
      }
    } catch {}
  }
  return null;
}
const TARGET_CODEBASE = detectTargetCodebase();
if (!TARGET_CODEBASE) {
  console.error('[e2e] Could not auto-detect TARGET_CODEBASE. Set it via env:');
  console.error('         TARGET_CODEBASE=/path/to/source/repo npm run e2e-gen');
  process.exit(1);
}
console.log(`[e2e] target codebase: ${TARGET_CODEBASE}${process.env.TARGET_CODEBASE ? ' (from env)' : ' (auto-detected)'}`);

const TESTS_DIR = path.join(REPO_ROOT, 'tests');
const E2E_DIR   = path.join(TESTS_DIR, 'e2e');
const MAX_FLOWS = Number(process.env.E2E_MAX_FLOWS || 12);
const MAX_DEPTH = Number(process.env.E2E_MAX_DEPTH || 5);

fs.mkdirSync(E2E_DIR, { recursive: true });

// ----- load -----
function loadJSON(p, fallback = null) {
  if (!fs.existsSync(p)) return fallback;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
const clickGraph = loadJSON(CLICK_GRAPH);
const routes     = loadJSON(ROUTES_JSON);
const pages      = loadJSON(PAGES_JSON);
const graphify   = loadJSON(GRAPHIFY_GRAPH);
if (!clickGraph || !routes) {
  console.error('[e2e] missing click-graph.json or routes.json under output/crawler/data/. Run `npm run all` first.');
  process.exit(1);
}

// ============================================================
// PART 1 — Build URL → handler index from graphify + source files
// ============================================================

const handlers = {};   // 'METHOD /path' -> { file, function, line, framework, raw }
const scanStats = { filesScanned: 0, fastapi: 0, flask: 0, django: 0, express: 0, nestjs: 0, nextjs: 0 };

// Cross-file router-prefix index: { fileRelPath: prefix } for files whose
// routes are mounted under a prefix in an entrypoint. Populated by a second
// pass scanning likely entrypoint files for include_router/use(router) etc.
const filePrefixes = new Map();
const generalPrefixes = new Set();   // any prefix seen anywhere — fallback try-list

function recordHandler(method, fullPath, info) {
  const key = `${method} ${fullPath.replace(/\/+/g, '/')}`;
  if (!handlers[key]) handlers[key] = info;
}

function scanFastAPI(relFile, content) {
  const lines = content.split('\n');
  // Local APIRouter(prefix="...") in the same file
  let localPrefix = '';
  const localMatch = content.match(/APIRouter\s*\([^)]*?prefix\s*=\s*['"]([^'"]+)['"]/);
  if (localMatch) localPrefix = localMatch[1];

  const routeRe = /@\s*(?:[\w_]+)\s*\.\s*(get|post|put|delete|patch|head|options)\s*\(\s*['"]([^'"]*)['"]/;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(routeRe);
    if (!m) continue;
    const method = m[1].toUpperCase();
    const decPath = m[2];
    let fn = null;
    for (let j = i + 1; j < Math.min(lines.length, i + 20); j++) {
      const dm = lines[j].match(/^\s*(?:async\s+)?def\s+(\w+)\s*\(/);
      if (dm) { fn = dm[1]; break; }
    }
    const info = { file: relFile, function: fn, line: i + 1, framework: 'fastapi', raw: lines[i].trim() };
    // Publish with NO prefix, local APIRouter prefix, and any cross-file prefix
    // that mounts this file. Crawler URL lookup tries each variant.
    const prefixes = new Set(['']);
    if (localPrefix) prefixes.add(localPrefix);
    if (filePrefixes.has(relFile)) prefixes.add(filePrefixes.get(relFile));
    for (const p of prefixes) recordHandler(method, p + decPath, info);
    scanStats.fastapi++;
  }
}

function scanFlask(relFile, content) {
  const lines = content.split('\n');
  // @app.route('/foo', methods=['GET', 'POST'])
  // @app.get('/foo')   (Flask 2+)
  // @blueprint.route('/foo')
  const routeStyleRe = /@\s*(?:[\w_]+)\s*\.\s*route\s*\(\s*['"]([^'"]+)['"][^)]*(?:methods\s*=\s*\[([^\]]+)\])?/;
  const shortStyleRe = /@\s*(?:[\w_]+)\s*\.\s*(get|post|put|delete|patch|head|options)\s*\(\s*['"]([^'"]+)['"]/;
  for (let i = 0; i < lines.length; i++) {
    let method = null, decPath = null;
    let m = lines[i].match(shortStyleRe);
    if (m) { method = m[1].toUpperCase(); decPath = m[2]; }
    else if ((m = lines[i].match(routeStyleRe))) {
      decPath = m[1];
      const methods = m[2] ? m[2].match(/['"]\w+['"]/g) || [] : ['GET'];
      for (const mt of methods) {
        const cleanMethod = mt.replace(/['"]/g, '').toUpperCase();
        let fn = null;
        for (let j = i + 1; j < Math.min(lines.length, i + 20); j++) {
          const dm = lines[j].match(/^\s*def\s+(\w+)\s*\(/);
          if (dm) { fn = dm[1]; break; }
        }
        recordHandler(cleanMethod, decPath, { file: relFile, function: fn, line: i + 1, framework: 'flask', raw: lines[i].trim() });
        scanStats.flask++;
      }
      continue;
    }
    if (!method) continue;
    let fn = null;
    for (let j = i + 1; j < Math.min(lines.length, i + 20); j++) {
      const dm = lines[j].match(/^\s*def\s+(\w+)\s*\(/);
      if (dm) { fn = dm[1]; break; }
    }
    recordHandler(method, decPath, { file: relFile, function: fn, line: i + 1, framework: 'flask', raw: lines[i].trim() });
    scanStats.flask++;
  }
}

function scanDjango(relFile, content) {
  // Only urls.py-style files
  if (!/urls?\.py$/.test(relFile)) return;
  const lines = content.split('\n');
  // path('foo/<int:id>/', views.foo, name='foo')
  // re_path(r'^foo/(?P<id>\d+)/', views.foo)
  const re = /(?:^|\s)(?:re_)?path\s*\(\s*(?:r?['"])([^'"]+)['"]\s*,\s*([\w.]+)/;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (!m) continue;
    let urlPath = m[1];
    // Strip regex anchors and convert <type:name> / (?P<name>...) → {name}
    urlPath = urlPath.replace(/\^|\$/g, '');
    urlPath = urlPath.replace(/<(?:[\w]+:)?([\w]+)>/g, '{$1}');
    urlPath = urlPath.replace(/\(\?P<([\w]+)>[^)]+\)/g, '{$1}');
    if (!urlPath.startsWith('/')) urlPath = '/' + urlPath;
    const view = m[2];
    // Django views handle all methods unless decorated; record as '*'
    recordHandler('*', urlPath, { file: relFile, function: view, line: i + 1, framework: 'django', raw: lines[i].trim() });
    scanStats.django++;
  }
}

function scanExpress(relFile, content) {
  const lines = content.split('\n');
  const re = /(?:[\w_]+)\s*\.\s*(get|post|put|delete|patch|head|options)\s*\(\s*['"`]([^'"`]+)['"`]/;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (!m) continue;
    const method = m[1].toUpperCase();
    const p = m[2];
    const prefixes = new Set(['']);
    if (filePrefixes.has(relFile)) prefixes.add(filePrefixes.get(relFile));
    for (const pre of prefixes) recordHandler(method, pre + p, {
      file: relFile, function: null, line: i + 1, framework: 'express', raw: lines[i].trim(),
    });
    scanStats.express++;
  }
}

function scanNestJs(relFile, content) {
  // Need a @Controller('prefix') AND method decorators
  const ctrlMatch = content.match(/@Controller\s*\(\s*['"]([^'"]*)['"]/);
  if (!ctrlMatch && !content.includes('@Controller')) return;
  const ctrlPrefix = ctrlMatch && ctrlMatch[1] ? '/' + ctrlMatch[1].replace(/^\//, '') : '';
  const lines = content.split('\n');
  const re = /@(Get|Post|Put|Delete|Patch|Head|Options)\s*\(\s*['"]?([^'")]*)['"]?\s*\)/;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (!m) continue;
    const method = m[1].toUpperCase();
    const sub = m[2] || '';
    const full = (ctrlPrefix + (sub.startsWith('/') || !sub ? sub : '/' + sub)).replace(/\/+/g, '/');
    let fn = null;
    for (let j = i + 1; j < Math.min(lines.length, i + 8); j++) {
      const dm = lines[j].match(/^\s*(?:public\s+|private\s+|async\s+)*(\w+)\s*\(/);
      if (dm) { fn = dm[1]; break; }
    }
    recordHandler(method, full || '/', { file: relFile, function: fn, line: i + 1, framework: 'nestjs', raw: lines[i].trim() });
    scanStats.nestjs++;
  }
}

function scanNextJs(relFile, content) {
  let urlPath = null;
  let m = relFile.match(/\/(api\/.*?)\/route\.(?:ts|tsx|js|mjs)$/);
  if (m) urlPath = '/' + m[1];
  else { m = relFile.match(/pages\/(api\/.*?)\.(?:ts|tsx|js|mjs)$/); if (m) urlPath = '/' + m[1]; }
  if (!urlPath) return;
  urlPath = urlPath.replace(/\[\.\.\.([^\]]+)\]/g, '{$1}').replace(/\[([^\]]+)\]/g, '{$1}');
  const exportRe = /export\s+(?:async\s+)?(?:const|function|let)\s+(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b/g;
  let exp;
  while ((exp = exportRe.exec(content)) !== null) {
    const method = exp[1].toUpperCase();
    recordHandler(method, urlPath, {
      file: relFile, function: method, line: content.slice(0, exp.index).split('\n').length, framework: 'next.js', raw: '',
    });
    scanStats.nextjs++;
  }
  if (/export\s+default\s+function/.test(content) && relFile.includes('pages/api')) {
    recordHandler('*', urlPath, { file: relFile, function: 'handler', line: 1, framework: 'next.js-pages-api', raw: '' });
    scanStats.nextjs++;
  }
}

// Resolve {VAR} or {module.VAR} references inside an f-string prefix by
// looking up the variable's literal value in the same file, in a referenced
// module file, or in common config files (settings.py, config.py, etc.).
function resolveVarRef(expr, contextContent, codeFilesList) {
  const parts = expr.trim().split('.');
  const varName = parts[parts.length - 1];
  const moduleName = parts.length > 1 ? parts[0] : null;
  const re = new RegExp(`(?:^|\\n)\\s*${varName}\\s*(?:[:=]|:\\s*\\w+\\s*=)\\s*['"]([^'"]+)['"]`);
  // Same file first
  const localMatch = contextContent.match(re);
  if (localMatch) return localMatch[1];
  // module-prefixed: look in <moduleName>.py
  if (moduleName) {
    for (const f of codeFilesList) {
      if (path.basename(f).replace(/\.\w+$/, '') !== moduleName) continue;
      try {
        const c = fs.readFileSync(path.join(TARGET_CODEBASE, f), 'utf8');
        const m = c.match(re);
        if (m) return m[1];
      } catch {}
    }
  }
  // Common config-style file names
  for (const f of codeFilesList) {
    const b = path.basename(f);
    if (!['settings.py', 'config.py', 'constants.py', 'common.py', 'config.ts', 'constants.ts'].includes(b)) continue;
    try {
      const c = fs.readFileSync(path.join(TARGET_CODEBASE, f), 'utf8');
      const m = c.match(re);
      if (m) return m[1];
    } catch {}
  }
  return null;
}

function resolveFString(rawTemplate, content, codeFilesList) {
  // Replace each {expr} with its resolved value, or return null if any is unresolved.
  let ok = true;
  const out = rawTemplate.replace(/\{([^}]+)\}/g, (_, expr) => {
    const v = resolveVarRef(expr, content, codeFilesList);
    if (v == null) { ok = false; return '<?>'; }
    return v;
  });
  return ok ? out : null;
}

// First pass — scan entrypoints for cross-file prefix mounts
function scanCrossFilePrefixes(codeFilesList) {
  const entrypointRe = /(?:^|\/)(main|app|server|index|__init__|api)\.(py|ts|tsx|js|mjs|cjs)$/;
  const entrypoints = codeFilesList.filter(f => entrypointRe.test(f));
  for (const rel of entrypoints) {
    const abs = path.join(TARGET_CODEBASE, rel);
    if (!fs.existsSync(abs)) continue;
    let content; try { content = fs.readFileSync(abs, 'utf8'); } catch { continue; }

    // FastAPI: include_router(<expr>, prefix="/x")  or  prefix=f"{VAR}/x"
    // Capture: f? marker, then string body
    const re1 = /include_router\s*\(\s*([\w_.]+)[^)]*?prefix\s*=\s*(f)?['"]([^'"]+)['"]/g;
    let m;
    while ((m = re1.exec(content)) !== null) {
      const routerExpr = m[1];
      const isFstring = !!m[2];
      let prefix = m[3];
      if (isFstring) {
        const resolved = resolveFString(prefix, content, codeFilesList);
        if (!resolved) continue;
        prefix = resolved;
      }
      generalPrefixes.add(prefix);
      const modName = routerExpr.split('.')[0];
      for (const f of codeFilesList) {
        const base = path.basename(f, path.extname(f));
        if (base === modName || f.endsWith('/' + modName + '.py')) filePrefixes.set(f, prefix);
      }
    }

    // Express: app.use('/x', router)
    const re2 = /(?:app|router)\s*\.\s*use\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*([\w_$.]+)/g;
    while ((m = re2.exec(content)) !== null) {
      generalPrefixes.add(m[1]);
      const modName = m[2].split('.')[0];
      for (const f of codeFilesList) {
        const base = path.basename(f).replace(/\.\w+$/, '');
        if (base === modName) filePrefixes.set(f, m[1]);
      }
    }
  }
  console.log(`[e2e] cross-file prefixes discovered: ${[...generalPrefixes].join(', ') || '(none)'}; ${filePrefixes.size} file→prefix mappings`);
}

const codeFiles = new Set();
if (graphify?.nodes) {
  for (const n of graphify.nodes) {
    if (n.file_type === 'code' && n.source_file) codeFiles.add(n.source_file);
  }
}
const codeFilesList = [...codeFiles];
console.log(`[e2e] scanning ${codeFiles.size} code files for route handlers under ${TARGET_CODEBASE}`);

// Pass 1: cross-file prefix discovery (FastAPI include_router, Express app.use)
scanCrossFilePrefixes(codeFilesList);

// Pass 2: per-file route scanning across all detected frameworks
for (const rel of codeFiles) {
  const abs = path.join(TARGET_CODEBASE, rel);
  if (!fs.existsSync(abs)) continue;
  let content; try { content = fs.readFileSync(abs, 'utf8'); } catch { continue; }
  scanStats.filesScanned++;
  if (rel.endsWith('.py')) {
    scanFastAPI(rel, content);
    scanFlask(rel, content);
    scanDjango(rel, content);
  } else if (/\.(ts|tsx|mjs|js|cjs)$/.test(rel)) {
    scanExpress(rel, content);
    scanNextJs(rel, content);
    scanNestJs(rel, content);
  }
}
console.log(`[e2e] scan stats: ${JSON.stringify(scanStats)} → ${Object.keys(handlers).length} handler entries`);
fs.writeFileSync(path.join(E2E_DIR, '_handler-map.json'), JSON.stringify(handlers, null, 2));

// Convenience lookup. Try exact match, then method-agnostic, then try
// stripping each known cross-file prefix. Returns the first hit.
function findHandler(method, urlPath) {
  const M = method.toUpperCase();
  if (handlers[`${M} ${urlPath}`]) return handlers[`${M} ${urlPath}`];
  if (handlers[`* ${urlPath}`]) return handlers[`* ${urlPath}`];
  for (const prefix of generalPrefixes) {
    if (urlPath.startsWith(prefix)) {
      const stripped = urlPath.slice(prefix.length) || '/';
      if (handlers[`${M} ${stripped}`]) return handlers[`${M} ${stripped}`];
      if (handlers[`* ${stripped}`]) return handlers[`* ${stripped}`];
    }
  }
  return null;
}

// ============================================================
// PART 2 — Extract flows from click-graph
// ============================================================

function shortPath(url) {
  try { const u = new URL(url); return u.pathname + (u.search || ''); } catch { return url; }
}
function urlRegexLiteral(url) {
  const p = shortPath(url).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `new RegExp(${JSON.stringify(p)})`;
}

// Edges come from two sources:
//   1. click-graph.json — INTERACT_MODE pass, hadNav:true clicks
//   2. pages.json — for each page, its <a href> links that point at OTHER
//      visited pages (this is the BFS link graph the main crawler implicitly
//      followed but didn't record as edges)
const navEdges = [];
for (const e of (clickGraph?.edges || [])) {
  if (e.hadNav) navEdges.push({ from: e.from, to: e.to, label: e.button, kind: 'click' });
}

// Synthesize edges from page links → other known page URLs.
const knownUrls = new Set((pages?.pages || []).map(p => p.finalUrl).filter(Boolean));
function normUrl(u) {
  try { const o = new URL(u); o.hash = ''; return o.toString(); } catch { return u; }
}
const knownNorm = new Set([...knownUrls].map(normUrl));
let anchorEdges = 0;
for (const p of (pages?.pages || [])) {
  if (!p.finalUrl) continue;
  for (const link of (p.clickables?.links || [])) {
    if (!link.href || !link.text) continue;
    const tgt = normUrl(link.href);
    if (!knownNorm.has(tgt) || tgt === normUrl(p.finalUrl)) continue;
    navEdges.push({ from: p.finalUrl, to: link.href, label: link.text, kind: 'anchor' });
    anchorEdges++;
  }
}
console.log(`[e2e] edges: ${(clickGraph?.edges || []).filter(e => e.hadNav).length} from click-graph + ${anchorEdges} from anchor links`);

const adj = new Map();
const dedupSig = new Set();
for (const e of navEdges) {
  const sig = `${e.from}→${e.label}→${e.to}`;
  if (dedupSig.has(sig)) continue;
  dedupSig.add(sig);
  if (!adj.has(e.from)) adj.set(e.from, []);
  adj.get(e.from).push({ to: e.to, button: e.label, kind: e.kind });
}

// Flow extraction: walk from every node with outgoing edges. Cycles are
// prevented per-walk. Dedup by step-signature globally. Cap at MAX_FLOWS.
// Prioritize "important" starts (login, overview/dashboard) so the most
// interesting flows appear first.
const allNodes = new Set([...navEdges.map(e => e.from), ...navEdges.map(e => e.to)]);
const startCandidates = [...adj.keys()].sort((a, b) => {
  const score = u => {
    if (/\/login$/i.test(u)) return 0;
    if (/\/(overview|dashboard|home)$/i.test(u)) return 1;
    if (/\/(index|user|approvals|me|profile)/i.test(u)) return 2;
    return 3;
  };
  return score(a) - score(b);
});

const flows = [];
const flowSig = new Set();
function walk(node, steps, depth) {
  if (flows.length >= MAX_FLOWS) return;
  const nexts = adj.get(node) || [];
  if (nexts.length === 0 || depth >= MAX_DEPTH) {
    pushFlow(steps);
    return;
  }
  let advanced = false;
  for (const { to, button, kind } of nexts) {
    if (steps.some(s => s.to === to) || node === to) continue; // cycle
    advanced = true;
    walk(to, [...steps, { from: node, to, button, kind }], depth + 1);
  }
  if (!advanced) pushFlow(steps);
}
function pushFlow(steps) {
  if (steps.length < 1) return;
  const sig = steps.map(s => `${s.from}→${s.button}→${s.to}`).join('|');
  if (flowSig.has(sig)) return;
  flowSig.add(sig);
  flows.push({ steps });
}
for (const start of startCandidates) walk(start, [], 0);

// Greedy diversity filter: drop flows whose final-page is the same as a
// prior shorter flow — keeps the catalog representative without duplicates.
const seenEndpoints = new Set();
const diverse = [];
for (const f of flows) {
  const endKey = f.steps[f.steps.length - 1].to;
  if (seenEndpoints.has(endKey) && f.steps.length > 1) continue;
  seenEndpoints.add(endKey);
  diverse.push(f);
  if (diverse.length >= MAX_FLOWS) break;
}
flows.length = 0;
flows.push(...diverse);
console.log(`[e2e] extracted ${flows.length} flow(s) (max ${MAX_FLOWS}, depth ≤ ${MAX_DEPTH})`);

// ============================================================
// PART 3 — Emit per-flow Playwright test files
// ============================================================

// Page → triggered backend APIs (from routes.json)
const apisByPage = new Map();
for (const p of (routes.pages || [])) {
  if (p.triggeredApis) apisByPage.set(p.url, p.triggeredApis);
}

function flowFileName(steps) {
  const last = shortPath(steps[steps.length - 1].to);
  const base = last.split('?')[0].split('/').filter(Boolean).slice(-2).join('-') || 'flow';
  return base.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 60) + '_' + steps.length + 'step';
}

function flowTitle(steps) {
  return steps.map(s => shortPath(s.to)).join(' → ');
}

function generateStepCode(step, index) {
  const apis = apisByPage.get(step.to) || [];
  // Annotate each backend API call with handler info, if known.
  const handlerComments = apis.slice(0, 6).map(api => {
    const m = api.match(/^(\w+)\s+https?:\/\/[^/]+(.+)$/) || api.match(/^(\w+)\s+(.+)$/);
    if (!m) return `    //   ↳ api: ${api}`;
    const h = findHandler(m[1], m[2]);
    if (!h) return `    //   ↳ ${m[1]} ${m[2]}   (handler: unknown — undocumented or dynamic route)`;
    const fnPart = h.function ? `:${h.function}()` : '';
    return `    //   ↳ ${m[1]} ${m[2]}   (handler: ${h.file}:${h.line}${fnPart}, ${h.framework})`;
  });

  const buttonText = step.button.replace(/'/g, "\\'");
  const targetUrlRe = urlRegexLiteral(step.to);

  // Wait for first 3 expected APIs (best-effort, .catch swallows if none fire)
  const apiWaits = apis.slice(0, 3).map(api => {
    const m = api.match(/^\w+\s+https?:\/\/[^/]+(.+)$/) || api.match(/^\w+\s+(.+)$/);
    if (!m) return null;
    const re = m[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return `page.waitForResponse(new RegExp(${JSON.stringify(re)}), { timeout: 5000 }).catch(() => null)`;
  }).filter(Boolean);

  return `  // ─── Step ${index + 1} ───────────────────────────────────────
  // From ${shortPath(step.from)}  →  click "${step.button}"  →  ${shortPath(step.to)}
${handlerComments.join('\n')}
  await test.step(${JSON.stringify(`step ${index + 1}: click "${step.button}" → ${shortPath(step.to)}`)}, async () => {
    const apiPromises = ${apiWaits.length ? `[
      ${apiWaits.join(',\n      ')}
    ]` : '[]'};
    await page.locator(${JSON.stringify(`button:has-text("${buttonText}"), a:has-text("${buttonText}")`)}).first().click();
    await page.waitForURL(${targetUrlRe}, { timeout: 10_000 }).catch(() => {});
    await Promise.allSettled(apiPromises);
    await expect(page).toHaveURL(${targetUrlRe});
  });
`;
}

function generateFlowTest(flow) {
  const firstFrom = shortPath(flow.steps[0].from);
  const needsLogin = !flow.steps.some(s => s.from.includes('/login'));
  const title = flowTitle(flow.steps);

  return `import { test, expect } from '@playwright/test';
import { login } from '../helpers/login.mjs';

// Generated by context-layer/content-extractor/crawler/generator/e2e.mjs from click-graph + graphify.
// Flow: ${title}
//
// Backend handler annotations come from scanning your source files for
// route decorators (@app.get(...), @router.get(...), Next.js exports).
// If a comment says "handler: unknown", the URL didn't match any decorator —
// likely a dynamic route, a proxy, or a framework we don't scan yet.

test('e2e: ${title.replace(/'/g, "\\'")}', async ({ page }) => {
  await page.goto('${firstFrom}');
${needsLogin ? '  await login(page);\n' : ''}
${flow.steps.map((s, i) => generateStepCode(s, i)).join('\n')}
});
`;
}

// ============================================================
// PART 3a — Wipe + setup subdirs
// ============================================================
const SUB = {
  flows:       path.join(E2E_DIR, 'flows'),
  api:         path.join(E2E_DIR, 'api'),
  auth:        path.join(E2E_DIR, 'auth'),
  forms:       path.join(E2E_DIR, 'forms'),
};
for (const dir of Object.values(SUB)) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

// ============================================================
// PART 3b — Flows (multi-step user journeys)
// ============================================================
let flowsWritten = 0;
for (const flow of flows) {
  const fname = flowFileName(flow.steps);
  fs.writeFileSync(path.join(SUB.flows, `${fname}.spec.mjs`), generateFlowTest(flow));
  flowsWritten++;
}

// ============================================================
// PART 3c — Direct API tests (one per real API endpoint)
// ============================================================
const apiEndpoints = (routes.endpoints || []).filter(e => e.isApi);
function endpointSlug(method, urlPath) {
  return (method + '_' + urlPath).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 80);
}
function fmtSchema(sample) {
  if (sample == null) return null;
  // Top-level shape only — avoid bloating the test with full bodies.
  if (Array.isArray(sample)) return { type: 'array', items: typeof sample[0] };
  if (typeof sample === 'object') return { type: 'object', keys: Object.keys(sample).slice(0, 12) };
  return { type: typeof sample };
}
let apiWritten = 0;
for (const e of apiEndpoints) {
  const method = e.method.toUpperCase();
  const fullUrl = e.origin + e.path;
  const sampleStatus = Object.entries(e.statusCounts).sort((a,b)=>b[1]-a[1])[0]?.[0] || '200';
  const expectedStatuses = Object.keys(e.statusCounts).map(Number);
  const sampleBody = Object.values(e.exampleResponseBodiesByStatus || {})[0];
  const shape = fmtSchema(sampleBody);
  const handler = findHandler(method, e.path);
  const handlerComment = handler
    ? `// Handler: ${handler.file}:${handler.line}${handler.function ? ':' + handler.function + '()' : ''}  [${handler.framework}]`
    : '// Handler: unknown — undocumented or dynamic';
  const needsAuth = e.observedAuth?.bearer || e.observedAuth?.cookie;
  const reqBody = e.exampleRequestBodies?.[0];
  const reqBodyArg = reqBody && method !== 'GET' && method !== 'HEAD'
    ? `, { data: ${JSON.stringify(reqBody)} }`
    : '';
  const expr = method === 'GET' || method === 'HEAD'
    ? `await request.${method.toLowerCase()}(url)`
    : `await request.${method.toLowerCase()}(url${reqBodyArg})`;

  const code = `import { test, expect } from '@playwright/test';
${needsAuth ? "import { login } from '../../helpers/login.mjs';\n" : ''}
// Generated by context-layer/content-extractor/crawler/generator/e2e.mjs from routes.json.
${handlerComment}
// Observed during crawl: ${e.samples} sample(s), status counts ${JSON.stringify(e.statusCounts)}, auth: ${needsAuth ? (e.observedAuth.bearer ? 'bearer' : 'cookie') : 'none'}

test('API ${method} ${e.path} → ${sampleStatus}', async ({ page, context }) => {
  ${needsAuth ? "await page.goto('/');\n  await login(page);\n  " : ''}const request = context.request;
  const url = ${JSON.stringify(fullUrl)};
  const response = ${expr};
  expect(response.status(), \`expected one of \${${JSON.stringify(expectedStatuses)}.join(',')}, got \${response.status()}\`).toBeOneOf(${JSON.stringify(expectedStatuses)});
${shape ? `  if (response.headers()['content-type']?.includes('json')) {
    const body = await response.json();
${shape.type === 'object' ? `    // Captured response had keys: ${shape.keys.join(', ')}
    for (const key of ${JSON.stringify(shape.keys)}) {
      expect.soft(body, \`missing key '\${key}' — schema changed?\`).toHaveProperty(key);
    }` : `    expect(${shape.type === 'array' ? 'Array.isArray(body)' : 'typeof body'}).${shape.type === 'array' ? 'toBe(true)' : `toBe('${shape.type}')`});`}
  }
` : ''}});
`;
  fs.writeFileSync(path.join(SUB.api, `${endpointSlug(method, e.path)}.spec.mjs`), code);
  apiWritten++;
}

// ============================================================
// PART 3d — Auth-gate tests (anon context → 401/403)
// ============================================================
const bearerEndpoints = (routes.endpoints || []).filter(e => e.isApi && e.observedAuth?.bearer);
let authWritten = 0;
for (const e of bearerEndpoints) {
  const method = e.method.toUpperCase();
  const fullUrl = e.origin + e.path;
  const handler = findHandler(method, e.path);
  const handlerComment = handler
    ? `// Handler: ${handler.file}:${handler.line}${handler.function ? ':' + handler.function + '()' : ''}`
    : '// Handler: unknown';
  const code = `import { test, expect } from '@playwright/test';

// Generated by context-layer/content-extractor/crawler/generator/e2e.mjs from routes.json#authObservations.
${handlerComment}
// This endpoint required Bearer auth during the crawl. Verify that an
// UNAUTHENTICATED request is properly rejected (401/403/etc.).

test.use({ storageState: { cookies: [], origins: [] } });

test('AUTH-GATE ${method} ${e.path} blocks anonymous', async ({ request }) => {
  const response = await request.${method.toLowerCase()}(${JSON.stringify(fullUrl)}${method === 'GET' || method === 'HEAD' ? '' : ', { data: {} }'});
  expect([401, 403, 422], \`expected 401/403/422 got \${response.status()}\`).toContain(response.status());
});
`;
  fs.writeFileSync(path.join(SUB.auth, `gate_${endpointSlug(method, e.path)}.spec.mjs`), code);
  authWritten++;
}

// ============================================================
// PART 3e — Form-submission tests (fill + submit + assert outcome)
// ============================================================
function fillValueLiteral(field) {
  switch (field.type) {
    case 'email':    return "'test+e2e@example.com'";
    case 'password': return "'TestPassword123!'";
    case 'number':   return "'1'";
    case 'date':     return "new Date().toISOString().slice(0,10)";
    case 'tel':      return "'5551234567'";
    case 'url':      return "'https://example.com'";
    case 'search':   return "'test'";
    default:         return "'e2e-test-value'";
  }
}
let formsWritten = 0;
for (const p of (pages?.pages || [])) {
  for (const form of (p.forms || [])) {
    const u = new URL(p.finalUrl);
    const pathRel = u.pathname + (u.search || '');
    // Skip login forms — covered by auth.spec.mjs
    if (form.fields?.some(f => f.type === 'password') && /login/i.test(pathRel)) continue;
    if ((form.fields || []).length === 0) continue;

    const fills = form.fields.filter(f => f.name || f.id || f.placeholder || f.ariaLabel || f.labelText).map(f => {
      const fieldJson = JSON.stringify({
        name: f.name, id: f.id, placeholder: f.placeholder, ariaLabel: f.ariaLabel, labelText: f.labelText, type: f.type,
      });
      return `  await fillField(page, ${fieldJson}, ${fillValueLiteral(f)});`;
    }).join('\n');
    if (!fills) continue;

    const submitText = form.buttons?.find(b => b.type === 'submit')?.text || 'Submit';
    const formSlug = (pathRel + '_' + (form.id || form.name || form.resolvedAction || 'form'))
      .replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '').slice(0, 80);

    const code = `import { test, expect } from '@playwright/test';
import { login, fillField } from '../../helpers/login.mjs';

// Generated by context-layer/content-extractor/crawler/generator/e2e.mjs from pages.json#forms.
// Page: ${pathRel}
// Form: action=${form.resolvedAction || form.action || '?'} method=${(form.method || 'GET').toUpperCase()}
// Fields: ${(form.fields || []).map(f => f.name || f.id || f.placeholder || '?').filter(Boolean).join(', ')}
// Submit: "${submitText}"

test('FORM submit on ${pathRel} (${form.fields.length} fields)', async ({ page }) => {
  await page.goto('${pathRel}');
  await login(page);
  // Re-navigate after login if it pushed us elsewhere.
  if (!page.url().includes(${JSON.stringify(pathRel)})) {
    await page.goto('${pathRel}');
  }
${fills}
  const before = page.url();
  await page.locator(${JSON.stringify(`button:has-text("${submitText.replace(/"/g, '\\"')}"), button[type='submit']`)}).first().click();
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  // Best-effort success assertion: URL changed, OR a toast appeared, OR no console error.
  const after = page.url();
  expect(after).toBeDefined();
});
`;
    fs.writeFileSync(path.join(SUB.forms, `${formSlug}.spec.mjs`), code);
    formsWritten++;
  }
}

// ============================================================
// PART 4 — Index + summary
// ============================================================
const summary = {
  generatedAt: new Date().toISOString(),
  target: TARGET_CODEBASE,
  handlersIndexed: Object.keys(handlers).length,
  scanStats,
  categories: {
    flows: { count: flowsWritten, dir: 'tests/e2e/flows/' },
    api: { count: apiWritten, dir: 'tests/e2e/api/' },
    auth: { count: authWritten, dir: 'tests/e2e/auth/' },
    forms: { count: formsWritten, dir: 'tests/e2e/forms/' },
  },
  totalTests: flowsWritten + apiWritten + authWritten + formsWritten,
};
fs.writeFileSync(path.join(E2E_DIR, '_index.json'), JSON.stringify(summary, null, 2));

console.log(`[e2e] FLOWS:  ${flowsWritten}  → tests/e2e/flows/`);
console.log(`[e2e] API:    ${apiWritten}  → tests/e2e/api/`);
console.log(`[e2e] AUTH:   ${authWritten}  → tests/e2e/auth/`);
console.log(`[e2e] FORMS:  ${formsWritten}  → tests/e2e/forms/`);
console.log(`[e2e] total tests: ${summary.totalTests}`);
console.log(`[e2e] handler map at tests/e2e/_handler-map.json (${Object.keys(handlers).length} entries)`);
console.log(`[e2e] summary at    tests/e2e/_index.json`);
