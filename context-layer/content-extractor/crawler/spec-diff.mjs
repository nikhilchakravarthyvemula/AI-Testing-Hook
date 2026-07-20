// spec-diff.mjs — compare our discovered/tested API surface against the
// official OpenAPI contract. Reports coverage: matched, missed (in spec but
// not tested), and extra (tested but not in spec).
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..', '..');

const OFFICIAL = process.argv[2];
const TESTED = path.join(REPO, 'output', 'generation', 'openapi-tests', 'manifest.json');
const DISCOVERED = path.join(REPO, 'output', 'crawler', 'reports', 'openapi.json');

// normalize an op key: METHOD + path with {param} AND concrete ids (uuid /
// long-hex / integer) collapsed to {}, leading /v2 stripped, trailing slash
// removed — so prefix, param-name, and concrete-vs-template differences all
// compare equal.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function tplPath(p) {
  return p.split('/').map(seg => {
    if (!seg) return seg;
    if (/^\{[^}]+\}$/.test(seg)) return '{}';
    if (UUID.test(seg) || /^[0-9a-f]{16,}$/i.test(seg) || /^\d+$/.test(seg)) return '{}';
    return seg;
  }).join('/').replace(/^\/v2(?=\/)/, '').replace(/\/+$/, '') || '/';
}
const norm = (method, p) => `${method.toUpperCase()} ${tplPath(p)}`;

const official = yaml.load(fs.readFileSync(OFFICIAL, 'utf8'));
const officialOps = new Map();   // normKey → {method, path}
for (const [p, methods] of Object.entries(official.paths || {})) {
  for (const m of Object.keys(methods)) {
    if (!['get','post','put','patch','delete','head','options'].includes(m)) continue;
    officialOps.set(norm(m, p), { method: m.toUpperCase(), path: p, summary: methods[m].summary || '' });
  }
}

const tested = JSON.parse(fs.readFileSync(TESTED, 'utf8')).tests;
const testedOps = new Map();
for (const t of tested) {
  const p = new URL(t.url).pathname;
  testedOps.set(norm(t.method, p), { method: t.method, path: p });
}

const discovered = JSON.parse(fs.readFileSync(DISCOVERED, 'utf8'));
const discoveredOps = new Map();
for (const [p, methods] of Object.entries(discovered.paths || {})) {
  for (const m of Object.keys(methods)) discoveredOps.set(norm(m, p), { method: m.toUpperCase(), path: p });
}

// restrict comparison to backend API ops (the official spec is the v2 backend).
// Our discovered set includes frontend HTML routes + 3rd-party (growthbook) —
// compare only ops whose normalized key matches the official namespace shape.
const matchedTested = [...officialOps.keys()].filter(k => testedOps.has(k));
const matchedDiscovered = [...officialOps.keys()].filter(k => discoveredOps.has(k));
const missed = [...officialOps.keys()].filter(k => !discoveredOps.has(k));      // in spec, never even seen
const seenNotTested = [...officialOps.keys()].filter(k => discoveredOps.has(k) && !testedOps.has(k));
// tested ops that don't map to any official path (undocumented / 3rd-party / templating artifact)
const extra = [...testedOps.keys()].filter(k => !officialOps.has(k));

const line = (s) => console.log(s);
line('━'.repeat(64));
line('API SPEC COVERAGE — official contract vs our crawl/tests');
line('━'.repeat(64));
line(`official endpoints : ${officialOps.size}`);
line(`tested (passing)   : ${testedOps.size}`);
line(`discovered (spec)  : ${discoveredOps.size}`);
line('');
line(`✅ official endpoints TESTED      : ${matchedTested.length}/${officialOps.size}  (${Math.round(100*matchedTested.length/officialOps.size)}%)`);
line(`👁  official endpoints DISCOVERED  : ${matchedDiscovered.length}/${officialOps.size}  (${Math.round(100*matchedDiscovered.length/officialOps.size)}%)`);
line('');
line(`── ✅ MATCHED & TESTED (${matchedTested.length}) ──`);
for (const k of matchedTested.sort()) line(`   ${k}`);
line('');
line(`── ❌ IN SPEC, NOT EXERCISED (${missed.length + seenNotTested.length}) ──`);
for (const k of missed.sort()) line(`   ${k}   — never observed`);
for (const k of seenNotTested.sort()) line(`   ${k}   — discovered, not tested`);
line('');
line(`── ➕ TESTED, NOT IN OFFICIAL SPEC (${extra.length}) ──`);
for (const k of extra.sort()) { const o = testedOps.get(k); line(`   ${k}   (${o.path})`); }

// write a markdown coverage report
const md = [];
md.push('# API coverage — official spec vs our tests');
md.push('');
md.push(`- Official spec: \`${OFFICIAL}\``);
md.push(`- Official endpoints: **${officialOps.size}** · tested: **${matchedTested.length}** (${Math.round(100*matchedTested.length/officialOps.size)}%) · discovered: **${matchedDiscovered.length}** (${Math.round(100*matchedDiscovered.length/officialOps.size)}%)`);
md.push('');
md.push('## ✅ Official endpoints we tested');
md.push(matchedTested.length ? matchedTested.sort().map(k => `- \`${k}\``).join('\n') : '_none_');
md.push('');
md.push('## ❌ Official endpoints NOT exercised');
const notEx = [...missed.map(k => `- \`${k}\` — never observed`), ...seenNotTested.map(k => `- \`${k}\` — discovered but not tested`)];
md.push(notEx.length ? notEx.sort().join('\n') : '_none — full coverage_');
md.push('');
md.push('## ➕ Tested but NOT in official spec');
md.push(extra.length ? extra.sort().map(k => { const o = testedOps.get(k); return `- \`${k}\` (\`${o.path}\`)`; }).join('\n') : '_none_');
md.push('');
const OUT = path.join(REPO, 'output', 'generation', 'openapi-tests', 'coverage-vs-official.md');
fs.writeFileSync(OUT, md.join('\n') + '\n');
line('');
line(`[spec-diff] wrote ${path.relative(REPO, OUT)}`);
