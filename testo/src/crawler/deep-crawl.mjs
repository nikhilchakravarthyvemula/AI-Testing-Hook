// deep-crawl.mjs
//
// One-shot DEEP scan = click-driven crawl + data-driven detail fan-out.
//
//   Pass 1  (crawl.mjs)          walk the app by clicking — discovers routes,
//                                detail-route TEMPLATES, and captures every
//                                list/search API response.
//   Synthesize (synthesize-urls) mine ids from the captured list APIs and
//                                fan the detail templates out over the full
//                                id set → output/crawler/synthesized-urls.txt
//   Pass 2  (crawl.mjs)          crawl ONLY the synthesized detail URLs that
//                                pass 1 never actually visited, into a separate
//                                output dir (so pass-1 data is preserved), then
//                                merge the raw streams + bodies back together.
//
// Why two passes: synthesized URLs aren't known until after a crawl, and the
// crawler's POST_CRAWL_URLS seeds are per-run. Auth-state.json is shared and
// survives the per-dir wipe, so pass 2 stays logged in.
//
// Env (forwarded to crawl.mjs): BASE_URL, SEED_PATHS, MAX_PAGES, HEADLESS,
//   LOGIN_*, CRAWLER_LLM, CRAWL_BUDGET_MS (pass 1).
// Deep-specific:
//   SKIP_PASS1=1                 reuse existing output/crawler (don't re-walk)
//   DEEP_BUDGET_MS               pass-2 wall-clock budget (default 300000)
//   DEEP_MAX_PAGES               pass-2 page cap (default 60)
//   DEEP_WORKERS                 pass-2 worker contexts (default 1 — see pass 2)
//   DEEP_MAX_CLICKS              pass-2 per-page click cap (default 5)
//   DEEP_TABLE_WAIT_MS           pass-2 table-rows settle wait (default 10000)
//   DEEP_OUT_DIR_NAME            pass-2 scratch dir (default 'crawler-deep')

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const MAIN_DIR = path.join(REPO_ROOT, 'output', process.env.CRAWLER_OUT_DIR_NAME || 'crawler');
const DEEP_NAME = process.env.DEEP_OUT_DIR_NAME || 'crawler-deep';
const DEEP_DIR = path.join(REPO_ROOT, 'output', DEEP_NAME);
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

const RAW_STREAMS = ['requests', 'responses', 'failed', 'console', 'pages', 'websockets'];

function run(label, env) {
  console.log(`\n━━━━━━━━━━ ${label} ━━━━━━━━━━`);
  const r = spawnSync(process.execPath, [path.join(__dirname, env._SCRIPT)], {
    cwd: __dirname, stdio: 'inherit', env: { ...process.env, ...env },
  });
  if (r.status !== 0) console.warn(`[deep] ${label} exited with status ${r.status}`);
  return r.status === 0;
}

// ───────── Pass 1 ────────────────────────────────────────────────────────
if (process.env.SKIP_PASS1 === '1') {
  console.log('[deep] SKIP_PASS1=1 — reusing existing', path.relative(REPO_ROOT, MAIN_DIR));
} else {
  run('Pass 1 — click-driven crawl', { _SCRIPT: 'crawl.mjs' });
}

// ───────── Synthesize ─────────────────────────────────────────────────────
run('Synthesize detail URLs from captured APIs', { _SCRIPT: 'synthesize-urls.mjs' });

const feedFile = path.join(MAIN_DIR, 'synthesized-urls.txt');
const feed = fs.existsSync(feedFile)
  ? fs.readFileSync(feedFile, 'utf8').split('\n').map(s => s.trim()).filter(Boolean)
  : [];

if (feed.length === 0) {
  console.log('\n[deep] no new detail URLs to deep-crawl — pass 1 already covered everything. Done.');
  process.exit(0);
}
console.log(`\n[deep] ${feed.length} synthesized detail URL(s) to deep-crawl`);

// ───────── Pass 2 — crawl only the synthesized URLs ───────────────────────
fs.rmSync(DEEP_DIR, { recursive: true, force: true });
run('Pass 2 — deep-crawl synthesized detail pages', {
  _SCRIPT: 'crawl.mjs',
  CRAWLER_OUT_DIR_NAME: DEEP_NAME,
  SEED_PATHS: feed.join(','),               // seed exactly the detail URLs
  POST_CRAWL_URLS: '',
  CRAWL_BUDGET_MS: String(process.env.DEEP_BUDGET_MS || 300_000),
  // ONE worker context by default. The target's session is a single-use
  // rotating refresh token: N contexts cloned from the same auth-state race
  // on the refresh endpoint, the first rotation 401s the other N-1, and each
  // loser burns ~75s in serialized recovery — the whole pass-2 budget goes to
  // auth instead of crawling. One context = one refresh chain = no race.
  CRAWL_WORKERS: process.env.DEEP_WORKERS || '1',
  // The synthesized feed IS the complete work list — the discovery pre-pass
  // would only re-find pass-1 sidebar routes, and eats budget doing it.
  CRAWL_PREDISCOVERY: '0',
  // crawl.mjs reads MAX_INTERACT_PAGES ("MAX_PAGES" is not an env it knows).
  MAX_INTERACT_PAGES: String(process.env.DEEP_MAX_PAGES || 60),
  // Detail pages are for DATA capture (their APIs fire on load); a small
  // click cap keeps every synthesized URL within the pass-2 budget instead
  // of exhaustively clicking the first page's sidebar.
  SAFE_CLICK_MAX_PER_PAGE: String(process.env.DEEP_MAX_CLICKS || 5),
  // The walker's default 30s table-rows wait is sized for heavy LIST pages;
  // detail pages fire their XHRs on load, so 10s is plenty — at 30s the wait
  // alone would eat most of the per-page budget across the whole feed.
  CRAWL_TABLE_WAIT_MS: String(process.env.DEEP_TABLE_WAIT_MS || 10_000),
});

// ───────── Verify FIRST: which synthesized pages did pass 2 reach? ────────
// (Computed before any merge so we don't fold login-page noise into the main
//  capture when pass 2 failed auth.)
const deepPages = fs.existsSync(path.join(DEEP_DIR, 'raw', 'pages.ndjson'))
  ? fs.readFileSync(path.join(DEEP_DIR, 'raw', 'pages.ndjson'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
  : [];
const reached = new Set();
let authRedirects = 0;
for (const p of deepPages) {
  const u = p.finalUrl || p.requestedUrl || '';
  if (/auth\.|openid-connect|\/login\b|\/sso\b/i.test(u)) authRedirects++;
  for (const f of feed) if (u.includes(f.split('?')[0]) && (!f.includes('=') || u.includes(f.split('=').pop().split('&')[0]))) reached.add(f);
}

// Pass 2 recorded ZERO pages: the walker never processed a task (budget spent
// entirely in auth setup/recovery). authRedirects can't count what was never
// recorded, so without this gate the login-noise raw streams — captured by the
// network listeners during the failed warm-up — would be merged into the main
// capture below. Skip the merge outright.
if (deepPages.length === 0) {
  console.log(`\n━━━━━━━━━━ deep-crawl: PASS 2 CAPTURED NO PAGES ━━━━━━━━━━`);
  console.log(`  the walker recorded 0 page visits — the crawl budget was likely spent in`);
  console.log(`  auth setup/recovery before any synthesized URL was reached.`);
  console.log(`  → retry with a bigger budget:  DEEP_BUDGET_MS=300000 SKIP_PASS1=1 npm run deep-crawl`);
  console.log(`  → if it still bounces to login, refresh the session:  npm run login`);
  console.log(`  (skipped merge — main capture left untouched; scratch dir: ${path.relative(REPO_ROOT, DEEP_DIR)})`);
  process.exit(0);
}

// If pass 2 reached nothing and bounced to auth, the saved session expired —
// warn loudly and DON'T pollute the main capture with login-page records.
if (reached.size === 0 && authRedirects > 0) {
  console.log(`\n━━━━━━━━━━ deep-crawl: AUTH EXPIRED ━━━━━━━━━━`);
  console.log(`  pass 2 was redirected to the login/SSO page on ${authRedirects} page visit(s)`);
  console.log(`  and reached 0/${feed.length} synthesized detail URLs.`);
  console.log(`  → the saved auth-state.json has expired. Refresh it, then re-run:`);
  console.log(`      testo scan --url ${BASE_URL} --sso        # headed SSO login refreshes auth-state`);
  console.log(`      npm run deep-crawl                         # SKIP_PASS1=1 to reuse pass-1 data`);
  console.log(`  (skipped merge — main capture left untouched; scratch dir: ${path.relative(REPO_ROOT, DEEP_DIR)})`);
  process.exit(0);
}

// ───────── Merge pass-2 capture back into the main dir ────────────────────
// Append NDJSON streams and copy any new body blobs, so downstream consumers
// (analyze.mjs, spec.mjs, the graph) see the deep pages as part of one run.
let appended = 0, bodiesCopied = 0;
for (const name of RAW_STREAMS) {
  const src = path.join(DEEP_DIR, 'raw', `${name}.ndjson`);
  const dst = path.join(MAIN_DIR, 'raw', `${name}.ndjson`);
  if (!fs.existsSync(src)) continue;
  const data = fs.readFileSync(src, 'utf8');
  if (!data) continue;
  fs.appendFileSync(dst, data.endsWith('\n') ? data : data + '\n');
  appended += data.split('\n').filter(Boolean).length;
}
const deepBodies = path.join(DEEP_DIR, 'bodies');
const mainBodies = path.join(MAIN_DIR, 'bodies');
if (fs.existsSync(deepBodies)) {
  fs.mkdirSync(mainBodies, { recursive: true });
  for (const f of fs.readdirSync(deepBodies)) {
    const dst = path.join(mainBodies, f);
    if (!fs.existsSync(dst)) { fs.copyFileSync(path.join(deepBodies, f), dst); bodiesCopied++; }
  }
}
// copy deep screenshots too (best-effort)
const deepShots = path.join(DEEP_DIR, 'screenshots');
const mainShots = path.join(MAIN_DIR, 'screenshots');
if (fs.existsSync(deepShots)) {
  fs.mkdirSync(mainShots, { recursive: true });
  for (const f of fs.readdirSync(deepShots)) {
    const dst = path.join(mainShots, f);
    if (!fs.existsSync(dst)) fs.copyFileSync(path.join(deepShots, f), dst);
  }
}

console.log(`\n━━━━━━━━━━ deep-crawl summary ━━━━━━━━━━`);
console.log(`  synthesized detail URLs : ${feed.length}`);
console.log(`  pass-2 pages captured   : ${deepPages.length}`);
console.log(`  synthesized URLs reached: ${reached.size}/${feed.length}`);
console.log(`  merged back: ${appended} ndjson records, ${bodiesCopied} new body blobs`);
console.log(`  pass-2 scratch dir: ${path.relative(REPO_ROOT, DEEP_DIR)} (safe to delete)`);
for (const u of reached) console.log(`    ✓ reached ${u}`);
const missed = feed.filter(f => !reached.has(f));
for (const u of missed.slice(0, 10)) console.log(`    ✗ missed  ${u}`);
console.log(`\n[deep] next: re-run analyze/spec over ${path.relative(REPO_ROOT, MAIN_DIR)} to fold deep pages into routes.json / openapi.`);
