// write-test-gen.mjs — exercise the official-spec endpoints the crawl never
// fired (writes + detail reads), using request bodies synthesized from the
// official OpenAPI schemas and real ids gathered from the crawl.
//
// Safety (test env, but tidy):
//   • device-override is PUT (create) then DELETE (cleanup) — no seed-data loss
//   • member role PATCH is a NO-OP (sets the member's CURRENT role back)
//   • POST creates use clearly test-labeled payloads
//
// Usage: node write-test-gen.mjs <official-spec.yaml>
import fs from 'node:fs'; import path from 'node:path'; import yaml from 'js-yaml';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..', '..');
const OUT = path.join(REPO, 'output', 'crawler');
const RAW = path.join(OUT, 'raw'); const BOD = path.join(OUT, 'bodies');
const AUTH_STATE = path.join(OUT, 'auth-state.json');
const TEST_DIR = path.join(REPO, 'output', 'generation', 'openapi-tests');
const SPEC_FILE = process.argv[2];
const BACKEND = process.env.API_BASE || 'https://surfacebackend-preview.superalign.ai';

const spec = yaml.load(fs.readFileSync(SPEC_FILE, 'utf8'));
const resolveRef = (ref) => ref.replace('#/', '').split('/').reduce((n, k) => n[k], spec);
function example(schema, depth = 0) {
  if (!schema) return null;
  if (schema.$ref) schema = resolveRef(schema.$ref);
  if (schema.example !== undefined) return schema.example;
  if (schema.enum) return schema.enum[0];
  if (schema.properties || schema.type === 'object') {
    const o = {}; const req = schema.required || [];
    for (const [k, v] of Object.entries(schema.properties || {})) { if (depth > 2 && !req.includes(k)) continue; o[k] = example(v, depth + 1); }
    return o;
  }
  if (schema.type === 'array') return [example(schema.items, depth + 1)].filter(x => x !== null);
  if (schema.format === 'uuid') return '00000000-0000-0000-0000-000000000000';
  if (schema.type === 'integer' || schema.type === 'number') return schema.example ?? 1;
  if (schema.type === 'boolean') return false;
  return schema.example ?? (schema.type === 'string' ? 'apitest' : null);
}
function bodyFor(method, p) {
  const op = spec.paths?.[p]?.[method.toLowerCase()];
  const sch = op?.requestBody?.content?.['application/json']?.schema;
  return sch ? example(sch) : null;
}

// ── real ids from captured data ────────────────────────────────────────────
const resp = fs.readFileSync(path.join(RAW, 'responses.ndjson'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
function captured(substr, method) {
  for (const r of resp) {
    if (r.url.includes(substr) && (!method || r.method === method) && r.status >= 200 && r.status < 300) {
      const f = path.join(BOD, `${r.bodyHash}.bin`);
      if (r.bodyHash && fs.existsSync(f)) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch {} }
    }
  }
  return null;
}
const members = (captured('/v2/members')?.members) || [];
const member = members[0] || { id: '00000000-0000-0000-0000-000000000000', role: 'member' };
const policy = (captured('/v2/policies/search', 'POST')?.results || [])[0] || { id: '00000000-0000-0000-0000-000000000000' };
const asset = (captured('/v2/inventory/search', 'POST')?.results || [])[0] || { id: '00000000-0000-0000-0000-000000000000' };
const ENDPOINT_ID = '3fc1199e-2c7d-475e-88d8-5f317edfef87';
const orgId = (() => { try { return JSON.parse(fs.readFileSync(AUTH_STATE, 'utf8')).origins[0].localStorage.find(x => x.name === 'superalign.org_id')?.value; } catch { return null; } })();

console.log(`[write-test] ids → member=${member.id}(${member.role}) policy=${policy.id} asset=${asset.id} org=${orgId}`);

// ── ordered test steps ──────────────────────────────────────────────────────
const U = (p) => BACKEND + p;
const steps = [
  // detail reads
  { name: 'GET organization',            method: 'GET',    url: U('/v2/organization'),                                     expect: [200] },
  { name: 'GET asset detail',            method: 'GET',    url: U(`/v2/assets/${asset.id}`),                               expect: [200, 404] },
  { name: 'GET asset risks',             method: 'GET',    url: U(`/v2/assets/${asset.id}/risks`),                         expect: [200, 404] },
  { name: 'GET asset endpoints',         method: 'GET',    url: U(`/v2/assets/${asset.id}/endpoints?page=1&page_size=50`), expect: [200, 404] },
  { name: 'GET asset↔endpoint risk',     method: 'GET',    url: U(`/v2/assets/${asset.id}/endpoints/${ENDPOINT_ID}/risk`), expect: [200, 404] },
  { name: 'GET policy detail',           method: 'GET',    url: U(`/v2/policies/${policy.id}`),                            expect: [200, 404] },
  // idempotent write
  { name: 'POST auth/sync',              method: 'POST',   url: U('/v2/auth/sync'),  body: bodyFor('POST', '/v2/auth/sync') || {}, expect: [200, 201, 204] },
  // no-op role update (set member's CURRENT role back)
  { name: 'PATCH member role (no-op)',   method: 'PATCH',  url: U(`/v2/members/${member.id}/role`), body: { role: member.role }, expect: [200] },
  // device-override round-trip: PUT (create) then DELETE (cleanup)
  { name: 'PUT device-override',         method: 'PUT',    url: U(`/v2/policies/${policy.id}/device-overrides/${ENDPOINT_ID}`),
    body: bodyFor('PUT', '/v2/policies/{id}/device-overrides/{device_id}') || { action: 'warn', reason: 'apitest override' }, expect: [200, 201] },
  { name: 'DELETE device-override',      method: 'DELETE', url: U(`/v2/policies/${policy.id}/device-overrides/${ENDPOINT_ID}`), expect: [200, 204], cleanup: true },
  // create policy (test-labeled; leaves a test policy behind in the test env)
  { name: 'POST policy (create)',        method: 'POST',   url: U('/v2/policies'),
    body: (() => { const b = bodyFor('POST', '/v2/policies') || {}; if (b && typeof b === 'object') { b.stable_id = `test:apitest-${Math.floor(Date.now()/1000)}`; if ('reason' in b) b.reason = 'apitest'; } return b; })(),
    expect: [200, 201] },
];

// ── token ────────────────────────────────────────────────────────────────
async function token() {
  if (process.env.TEST_BEARER) return process.env.TEST_BEARER;
  const { chromium } = await import('playwright');
  const b = await chromium.launch({ headless: true });
  const page = await (await b.newContext({ storageState: AUTH_STATE })).newPage();
  let t = null;
  page.on('request', r => { const a = r.headers()['authorization']; if (!t && /^bearer /i.test(a || '')) t = a.replace(/^bearer /i, ''); });
  try { await page.goto('https://console-preview.superalign.ai/endpoints', { waitUntil: 'domcontentloaded', timeout: 30000 }); for (let i = 0; i < 24 && !t; i++) await page.waitForTimeout(500); } catch {}
  await b.close(); return t;
}

const tok = await token();
if (!tok) { console.error('[write-test] no token (run: npm run login). Aborting.'); process.exit(1); }
console.log('[write-test] token captured; running', steps.length, 'write/detail tests…\n');

const results = [];
for (const s of steps) {
  const headers = { 'Accept': 'application/json', 'Authorization': `Bearer ${tok}` };
  if (s.body !== undefined) headers['Content-Type'] = 'application/json';
  const t0 = Date.now(); let status = 0, respBody = '', err = null;
  try {
    const res = await fetch(s.url, { method: s.method, headers, body: s.body !== undefined ? JSON.stringify(s.body) : undefined });
    status = res.status; respBody = (await res.text()).slice(0, 4000);
  } catch (e) { err = e.message; }
  const pass = s.expect.includes(status);
  results.push({ name: s.name, method: s.method, url: s.url, body: s.body, expect: s.expect, status, pass, ms: Date.now() - t0, respBody, err, cleanup: !!s.cleanup });
  console.log(`  ${pass ? '✓' : '✗'} ${s.method} ${s.url.replace(BACKEND, '')}  → ${status || err} (expect ${s.expect.join('/')})${s.cleanup ? '  [cleanup]' : ''}`);
}

// ── report ───────────────────────────────────────────────────────────────
const passed = results.filter(r => r.pass).length;
const md = ['# Write / mutation API tests (official-spec driven)', '',
  `- Generated: ${new Date().toISOString()}`,
  `- Official spec: \`${SPEC_FILE}\``,
  `- Backend: \`${BACKEND}\``,
  `- **Result: ${passed}/${results.length} passed**`, '',
  '| # | Test | Method | Path | Expected | Actual | Result | Time |',
  '|---|---|---|---|---|---|---|---|'];
results.forEach((r, i) => md.push(`| ${i + 1} | ${r.name} | ${r.method} | \`${r.url.replace(BACKEND, '')}\` | ${r.expect.join('/')} | ${r.status || r.err} | ${r.pass ? '✅' : '❌'} | ${r.ms}ms |`));
md.push('', '## Request / response detail', '');
const fence = (l, b) => { if (b == null || b === '') return; md.push(`**${l}:**`, '```json', typeof b === 'string' ? b : JSON.stringify(b, null, 2), '```'); };
results.forEach((r, i) => {
  md.push(`### ${i + 1}. ${r.name} ${r.pass ? '✅' : '❌'}`, '', `- \`${r.method} ${r.url}\` → **${r.status}** (expect ${r.expect.join('/')}) in ${r.ms}ms`, '');
  if (r.body !== undefined) fence('Request body', r.body);
  fence('Response body', (() => { try { return JSON.stringify(JSON.parse(r.respBody), null, 2); } catch { return r.respBody; } })());
  if (r.err) fence('Error', r.err);
  md.push('');
});
fs.writeFileSync(path.join(TEST_DIR, 'write-tests-report.md'), md.join('\n') + '\n');
fs.writeFileSync(path.join(TEST_DIR, 'write-tests-results.json'), JSON.stringify({ ranAt: new Date().toISOString(), backend: BACKEND, results }, null, 2));
console.log(`\n[write-test] RESULT: ${passed}/${results.length} passed`);
console.log(`[write-test] wrote output/generation/openapi-tests/write-tests-report.md`);
