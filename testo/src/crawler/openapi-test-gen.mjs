// openapi-test-gen.mjs
//
// Spec-driven API test generation + execution.
//
//   INPUT : output/crawler/reports/openapi.json   (the spec we built from
//                                                   captured traffic)
//           output/crawler/raw/{requests,responses}.ndjson + bodies/  (the
//                                                   real calls + bodies we gathered)
//           output/crawler/auth-state.json         (to capture a FRESH token)
//   OUTPUT: output/generation/openapi-tests/
//           ├── curls/<opId>.sh     runnable curl per API op (token via $BEARER)
//           ├── manifest.json       every test: method/url/headers/body/expected
//           ├── results.json        execution outcome per test (if --execute)
//           └── report.md           human summary
//
// For each JSON API operation in the spec we pick a representative REAL
// request that the crawl captured (same URL + body — so path/query ids and
// request bodies are valid), attach a fresh Authorization: Bearer token, run
// it, and PASS/FAIL against the status the spec documents. Request bodies for
// POST search endpoints also get a mock-data variant when available.
//
// Flags:  --no-execute   only write curls + manifest (don't hit the API)
//         --max N        cap number of operations tested
// Env:    BASE_URL, TEST_BEARER (skip live capture), CRAWLER_OUT_DIR_NAME

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..', '..');
const OUT = path.join(REPO, 'output', process.env.CRAWLER_OUT_DIR_NAME || 'crawler');
const SPEC = path.join(OUT, 'reports', 'openapi.json');
const RAW = path.join(OUT, 'raw');
const BODIES = path.join(OUT, 'bodies');
const AUTH_STATE = path.join(OUT, 'auth-state.json');
const TEST_DIR = path.join(REPO, 'output', 'generation', 'openapi-tests');
const CURL_DIR = path.join(TEST_DIR, 'curls');

const EXECUTE = !process.argv.includes('--no-execute');
const MAX = (() => { const i = process.argv.indexOf('--max'); return i >= 0 ? Number(process.argv[i + 1]) : Infinity; })();

const ndjson = (p) => fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
const tpl = (pn) => pn.split('/').map(s => /^\d+$/.test(s) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) || /^[0-9a-f]{16,}$/i.test(s) ? '{id}' : s).join('/');

if (!fs.existsSync(SPEC)) { console.error('[apitest] no spec at', SPEC, '— run spec.mjs first'); process.exit(1); }
const spec = JSON.parse(fs.readFileSync(SPEC, 'utf8'));

// ── index captured requests by METHOD + templated path → representative real call
const requests = ndjson(path.join(RAW, 'requests.ndjson'));
const responses = ndjson(path.join(RAW, 'responses.ndjson'));
const respByKey = new Map();
for (const r of responses) { const k = `${r.method} ${r.url}`; if (!respByKey.has(k)) respByKey.set(k, r); }
const sampleByOp = new Map();   // "METHOD templatedPath" → {url, method, headers, body}
for (const r of requests) {
  let u; try { u = new URL(r.url); } catch { continue; }
  const key = `${r.method} ${tpl(u.pathname)}`;
  if (sampleByOp.has(key)) continue;
  // prefer a request that produced a 2xx
  const resp = respByKey.get(`${r.method} ${r.url}`);
  sampleByOp.set(key, { url: r.url, method: r.method, headers: r.headers || {}, postData: r.postData || null, status: resp?.status });
}

// mock-data bodies (alt request bodies) keyed by METHOD path
const mock = (() => {
  const p = path.join(REPO, 'output', 'indexed_output', 'mock-data.json');
  if (!fs.existsSync(p)) return new Map();
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  const m = new Map();
  for (const it of (d.items || [])) { const pr = it.primary || {}; if (pr.method && pr.path) m.set(`${pr.method} ${pr.path}`, pr.firstRequestBody); }
  return m;
})();

// ── collect testable operations from the spec (JSON-bodied APIs only) ──────
const servers = (spec.servers || []).map(s => s.url);
const ops = [];
for (const [p, methods] of Object.entries(spec.paths || {})) {
  for (const [method, op] of Object.entries(methods)) {
    const m = method.toUpperCase();
    // Skip OAuth/OIDC/login endpoints — they're auth plumbing, not business
    // APIs, and a replayed one-time token exchange always 400s.
    if (/(\/realms\/|\/protocol\/openid-connect\/|\/oauth2?\/|\/login\b|\/sso\b)/i.test(p)) continue;
    const respHasJson = Object.values(op.responses || {}).some(r => r?.content?.['application/json']);
    if (!respHasJson) continue;                       // skip HTML pages / bodyless
    const key = `${m} ${p}`;
    const sample = sampleByOp.get(key);
    if (!sample) continue;                            // need a real captured call to replay
    const origin = (() => { try { return new URL(sample.url).origin; } catch { return servers[0]; } })();
    const expected = Object.keys(op.responses || {}).map(Number).filter(n => n >= 200 && n < 400).sort()[0] || 200;
    const needsAuth = !!op.security;
    const ctHeader = (op.parameters || []).find(x => x.in === 'header' && x.name.toLowerCase() === 'content-type')?.example;
    ops.push({
      opId: op.operationId || key.replace(/[^a-z0-9]+/gi, '_'),
      method: m, path: p, url: sample.url, origin, needsAuth,
      contentType: ctHeader || (sample.postData ? 'application/json' : null),
      body: sample.postData || (mock.get(`${m} ${p}`) ? JSON.stringify(mock.get(`${m} ${p}`)) : null),
      bodySource: sample.postData ? 'captured' : (mock.get(`${m} ${p}`) ? 'mock-data' : null),
      expected, observedStatus: sample.status,
    });
  }
}
ops.sort((a, b) => a.path.localeCompare(b.path));
const tests = ops.slice(0, MAX);
console.log(`[apitest] ${ops.length} testable API operation(s) from spec; preparing ${tests.length}`);

// ── capture a fresh Bearer token from the authenticated session ────────────
async function captureToken() {
  if (process.env.TEST_BEARER) return process.env.TEST_BEARER;
  if (!fs.existsSync(AUTH_STATE)) return null;
  const { chromium } = await import('playwright');
  const base = process.env.BASE_URL || servers.find(s => !/auth\.|backend/.test(s)) || servers[0];
  const b = await chromium.launch({ headless: true });
  const ctx = await b.newContext({ storageState: AUTH_STATE });
  const page = await ctx.newPage();
  let token = null;
  page.on('request', req => {
    const a = req.headers()['authorization'];
    if (!token && a && /^bearer /i.test(a)) token = a.replace(/^bearer /i, '');
  });
  try {
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 30000 });
    for (let i = 0; i < 20 && !token; i++) await page.waitForTimeout(500);
    // nudge: visit a data page to force an API call
    if (!token) { await page.goto(base + '/endpoints', { waitUntil: 'domcontentloaded' }).catch(() => {}); for (let i = 0; i < 16 && !token; i++) await page.waitForTimeout(500); }
  } catch {}
  await b.close();
  return token;
}

function jwtExp(t) { try { return JSON.parse(Buffer.from(t.split('.')[1], 'base64').toString()).exp * 1000; } catch { return null; } }

// ── emit curl scripts + manifest ───────────────────────────────────────────
fs.rmSync(TEST_DIR, { recursive: true, force: true });
fs.mkdirSync(CURL_DIR, { recursive: true });
const manifest = [];
for (const t of tests) {
  const lines = ['#!/usr/bin/env bash', 'set -euo pipefail', ': "${BEARER:?export BEARER=<token>}"', ''];
  let c = `curl -sS -w '\\n%{http_code} %{time_total}s\\n' -X ${t.method} '${t.url}'`;
  if (t.needsAuth) c += ` \\\n  -H "Authorization: Bearer $BEARER"`;
  if (t.contentType) c += ` \\\n  -H 'Content-Type: ${t.contentType}'`;
  c += ` \\\n  -H 'Accept: application/json'`;
  if (t.body) c += ` \\\n  --data '${t.body.replace(/'/g, "'\\''")}'`;
  lines.push(c, '');
  fs.writeFileSync(path.join(CURL_DIR, `${t.opId}.sh`), lines.join('\n'));
  manifest.push({ opId: t.opId, method: t.method, url: t.url, needsAuth: t.needsAuth, contentType: t.contentType, bodySource: t.bodySource, expectedStatus: t.expected });
}
fs.writeFileSync(path.join(TEST_DIR, 'manifest.json'), JSON.stringify({ generatedAt: new Date().toISOString(), count: manifest.length, tests: manifest }, null, 2));
console.log(`[apitest] wrote ${manifest.length} curl script(s) → ${path.relative(REPO, CURL_DIR)}/`);

// ── execute ────────────────────────────────────────────────────────────────
let results = [];
if (EXECUTE) {
  const token = await captureToken();
  if (!token) {
    console.warn('[apitest] could not capture a Bearer token (session may be expired). Curls written with $BEARER placeholder; skipping live run.');
  } else {
    const exp = jwtExp(token);
    console.log(`[apitest] captured token (exp ${exp ? new Date(exp).toISOString() : '?'}); executing ${tests.length} test(s)…`);
    for (const t of tests) {
      const headers = { 'Accept': 'application/json' };
      if (t.needsAuth) headers['Authorization'] = `Bearer ${token}`;
      if (t.contentType) headers['Content-Type'] = t.contentType;
      const t0 = Date.now();
      let status = 0, ok = false, respBody = '', respHeaders = {}, err = null;
      try {
        const res = await fetch(t.url, { method: t.method, headers, body: t.body || undefined });
        status = res.status;
        respHeaders = Object.fromEntries(res.headers.entries());
        respBody = (await res.text()).slice(0, 8000);   // cap to keep report sane
        ok = status === t.expected || (status >= 200 && status < 300 && t.expected >= 200 && t.expected < 300);
      } catch (e) { err = e.message; }
      // redact the bearer in the recorded request headers
      const recHeaders = { ...headers };
      if (recHeaders['Authorization']) recHeaders['Authorization'] = 'Bearer <redacted>';
      results.push({
        opId: t.opId, method: t.method, url: t.url, expected: t.expected, actual: status, pass: ok, ms: Date.now() - t0,
        request: { headers: recHeaders, bodySource: t.bodySource, body: t.body || null },
        response: { status, contentType: respHeaders['content-type'] || null, headers: respHeaders, body: respBody },
        err,
      });
      console.log(`  ${ok ? '✓' : '✗'} ${t.method} ${t.path}  → ${status} (expected ${t.expected})`);
    }
    fs.writeFileSync(path.join(TEST_DIR, 'results.json'), JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2));
  }
}

// ── report.md (summary table + per-API request/response detail) ────────────
const passed = results.filter(r => r.pass).length;
const md = [];
md.push('# API tests — spec-driven request/response report');
md.push('');
md.push(`- Generated: ${new Date().toISOString()}`);
md.push(`- Spec: \`output/crawler/reports/openapi.json\``);
md.push(`- Operations tested: **${tests.length}** (of ${ops.length} JSON APIs in spec)`);
if (results.length) md.push(`- **Result: ${passed}/${results.length} passed**`);
md.push('');
md.push('## Summary');
md.push('');
md.push('| # | Method | Path | Auth | Req body | Expected | Actual | Result | Time |');
md.push('|---|---|---|---|---|---|---|---|---|');
tests.forEach((t, i) => {
  const r = results.find(x => x.opId === t.opId);
  md.push(`| ${i + 1} | ${t.method} | \`${t.path}\` | ${t.needsAuth ? 'bearer' : '—'} | ${t.bodySource || '—'} | ${t.expected} | ${r ? (r.actual || r.err) : '—'} | ${r ? (r.pass ? '✅' : '❌') : 'not run'} | ${r ? r.ms + 'ms' : '—'} |`);
});
md.push('');
md.push('## Request / response detail');
md.push('');
const fence = (label, lang, body) => { if (body == null || body === '') return; md.push(`**${label}:**`); md.push('```' + (lang || '')); md.push(typeof body === 'string' ? body : JSON.stringify(body, null, 2)); md.push('```'); };
const pretty = (s) => { try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; } };
tests.forEach((t, i) => {
  const r = results.find(x => x.opId === t.opId);
  md.push(`### ${i + 1}. ${t.method} ${t.path}  ${r ? (r.pass ? '✅' : '❌') : ''}`);
  md.push('');
  md.push(`- **URL:** \`${t.url}\``);
  md.push(`- **Auth:** ${t.needsAuth ? 'Bearer JWT' : 'none'}${t.contentType ? ` · **Content-Type:** \`${t.contentType}\`` : ''}`);
  if (r) md.push(`- **Expected ${t.expected} → got ${r.actual}** in ${r.ms}ms${r.response?.contentType ? ` · resp \`${r.response.contentType}\`` : ''}`);
  md.push('');
  if (t.body) fence(`Request body (${t.bodySource})`, 'json', pretty(t.body));
  if (r?.response?.body) fence('Response body', 'json', pretty(r.response.body));
  if (r?.err) fence('Error', '', r.err);
  md.push('');
});
fs.writeFileSync(path.join(TEST_DIR, 'report.md'), md.join('\n') + '\n');
// also dump each full response body to responses/<opId>.json for inspection
const RESP_DIR = path.join(TEST_DIR, 'responses');
fs.mkdirSync(RESP_DIR, { recursive: true });
for (const r of results) if (r.response?.body) fs.writeFileSync(path.join(RESP_DIR, `${r.opId}.json`), r.response.body);
console.log(`[apitest] wrote ${path.relative(REPO, path.join(TEST_DIR, 'report.md'))}  + responses/`);
if (results.length) console.log(`[apitest] RESULT: ${passed}/${results.length} passed`);
