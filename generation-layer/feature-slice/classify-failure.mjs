// Post-hoc failure classification for the unified report.
//
// For every FAILED test row, answer the question a business user or
// developer actually cares about: is this OUR test's fault (a placeholder
// id, a missing query param, a guessed pass/fail bar, a generated URL that
// doesn't even match the endpoint it claims to test) or does it reflect the
// app's real behavior (which might not even be a failure — it can match
// traffic the crawl already observed live)?
//
// Pure post-hoc analysis over files the pipeline already writes
// (output/indexed_output/apis.json, output/mock-data/bundle.json) — no
// changes to either generator. Same shape/conventions as tag.mjs: own
// REPO_ROOT, reads its ground-truth files directly, no deps. Used by
// byo-llm-poc/ctx.mjs buildUnifiedReport.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { templatizePath, deriveKey } from './tag.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const APIS_FILE = path.join(REPO_ROOT, 'output', 'indexed_output', 'apis.json');
const BUNDLE_FILE = path.join(REPO_ROOT, 'output', 'mock-data', 'bundle.json');

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function pathnameOf(url) {
  try { return new URL(url).pathname; } catch { return null; }
}

// "METHOD:/templated/path" (apis.json's own id / results.json's api_id) <->
// "METHOD /templated/path" (tag.mjs's deriveKey format) — same convention
// already used in ctx.mjs's writeCoverage().
function toSpaceKey(colonId) {
  return String(colonId || '').replace(/^([A-Z]+):/, '$1 ');
}

// Loads the ground-truth files once per report build.
export function loadClassifyContext() {
  const apis = readJson(APIS_FILE);
  const bundle = readJson(BUNDLE_FILE);

  const endpointIndex = new Map();   // "METHOD /templated/path" -> primary
  const originCounts = new Map();
  for (const item of apis?.items || []) {
    const p = item.primary;
    if (!p) continue;
    endpointIndex.set(`${p.method} ${templatizePath(p.path)}`, p);
    originCounts.set(p.origin, (originCounts.get(p.origin) || 0) + 1);
  }
  let majorityOrigin = null, best = -1;
  for (const [origin, n] of originCounts) if (n > best) { best = n; majorityOrigin = origin; }

  // Pool observed path-param values BY NAME across every endpoint — a
  // blocked mutation (e.g. POST .../agents/{id}/config) has no observed
  // params of its own; the real id only shows up under a sibling GET.
  const paramPool = new Map();   // paramName -> Set<realValue>
  for (const e of bundle?.facts?.endpoints || []) {
    for (const [name, values] of Object.entries(e.observedPathParams || {})) {
      if (!paramPool.has(name)) paramPool.set(name, new Set());
      for (const v of values) paramPool.get(name).add(String(v));
    }
  }

  return { endpointIndex, paramPool, majorityOrigin };
}

// Pull the facts needed to classify a UI-suite failure out of the raw
// Playwright result object (already in scope in ctx.mjs's collectUiTests).
// Everything here comes from result.error.message/.snippet, which Playwright's
// JSON reporter already embeds verbatim (confirmed: the generated spec's own
// `const url = "...";` / `data: {...}` source line is in `.snippet`) — no
// separate spec-file read needed.
export function extractUiFailureFacts(result) {
  const out = { actualUrl: null, actualStatus: null, expectedStatuses: null, credentialsEmbedded: false };
  const text = `${result?.error?.message || ''}\n${result?.error?.snippet || ''}`;
  if (!text.trim()) return out;

  const gotM = /expected one of ([\d,\s]+),?\s*got (\d+)/i.exec(text) || /expected (\d+),?\s*got (\d+)/i.exec(text);
  if (gotM) {
    out.expectedStatuses = gotM[1].split(',').map((s) => parseInt(s.trim(), 10)).filter(Number.isFinite);
    out.actualStatus = parseInt(gotM[2], 10);
  }
  const urlM = /(?:const|let)\s+url\s*=\s*["'`]([^"'`]+)["'`]/.exec(text);
  if (urlM) out.actualUrl = urlM[1];

  // Boolean only — the literal secret value is never captured/returned.
  out.credentialsEmbedded = /["'](password|passwd|secret)["']\s*:\s*["'][^"'$][^"']*["']/i.test(text);
  return out;
}

// The per-row decision. `row` must already carry either
// { apiId, actualUrl, httpStatus } (api suite, from collectApiTests) or
// { actualUrl, actualStatus, credentialsEmbedded } (ui suite, from
// extractUiFailureFacts). Returns failureClass: null when no endpoint key
// could be derived at all (e2e route-chain / FORM rows) — rendered as
// "needs manual review" rather than forced into a bucket.
export function classifyFailure(row, ctx) {
  const reasons = [];
  const flags = [];

  const declaredKey = row.suite === 'api' ? toSpaceKey(row.apiId) : (deriveKey(row)?.kind === 'endpoint' ? deriveKey(row).key : null);
  if (!declaredKey) return { failureClass: null, reasons: ['no endpoint could be derived for this test (route/form flow)'], flags };

  const actualStatus = row.suite === 'api' ? row.httpStatus : row.actualStatus;
  if (typeof actualStatus === 'number' && actualStatus >= 500) flags.push('server-error-5xx');

  const declared = ctx.endpointIndex.get(declaredKey) || null;
  if (declared && ctx.majorityOrigin && declared.origin !== ctx.majorityOrigin) flags.push('foreign-origin');
  if (row.suite === 'ui' && row.credentialsEmbedded) flags.push('credentials-embedded-in-test-source');

  // Rule 1 — self-consistency: does the actual called URL's path match what
  // this test declares it's testing? Catches both "unknown endpoint" and a
  // generator mangling the URL it built (e.g. a colon-suffixed verb).
  const declaredPath = declaredKey.split(' ').slice(1).join(' ');
  const actualPathname = pathnameOf(row.actualUrl);
  const actualTemplated = actualPathname ? templatizePath(actualPathname) : null;
  if (!declared || (actualTemplated && actualTemplated !== declaredPath)) {
    reasons.push(`generated request URL ("${actualPathname || row.actualUrl || 'unknown'}") doesn't match the endpoint this test declares ("${declaredPath}")`);
    return { failureClass: 'pipeline-issue', reasons, flags };
  }

  // Rule 2 — placeholder path param: a real value IS known somewhere for
  // this param name, but this test didn't use it.
  const declaredSegs = declaredPath.split('/');
  const actualSegs = (actualPathname || '').split('/');
  if (actualSegs.length === declaredSegs.length) {
    for (let i = 0; i < declaredSegs.length; i++) {
      const m = /^\{(\w+)\}$/.exec(declaredSegs[i]);
      if (!m) continue;
      const pool = ctx.paramPool.get(m[1]);
      if (pool && pool.size && !pool.has(actualSegs[i])) {
        reasons.push(`used placeholder value "${actualSegs[i]}" for path param "${m[1]}" instead of a real id the crawl observed (${[...pool].slice(0, 2).join(', ')})`);
        return { failureClass: 'pipeline-issue', reasons, flags };
      }
    }
  }

  // Rule 3 — missing required query parameter.
  const hasQuery = row.actualUrl ? (pathnameOf(row.actualUrl) !== null && new URL(row.actualUrl).search !== '') : false;
  if ((declared.queryParamNames || []).length && !hasQuery) {
    reasons.push(`endpoint expects query param(s) [${declared.queryParamNames.join(', ')}] but this test sent none`);
    return { failureClass: 'pipeline-issue', reasons, flags };
  }

  // Rule 4 — matches real observed traffic: not really a failure at all.
  const statusCounts = declared.statusCounts || {};
  if (typeof actualStatus === 'number' && statusCounts[String(actualStatus)]) {
    reasons.push(`HTTP ${actualStatus} was observed ${statusCounts[String(actualStatus)]} time(s) live during the crawl for this endpoint`);
    return { failureClass: 'expected-behavior', reasons, flags };
  }

  // Rule 5 — no observed baseline: the pass/fail bar itself was a guess.
  if (!Object.keys(statusCounts).length) {
    reasons.push('this endpoint was never called live during the crawl (mutation held back by safe-mode) — the expected status was guessed, not observed');
    return { failureClass: 'pipeline-issue', reasons, flags };
  }

  // Catch-all — well-formed request, real baseline exists, but the result
  // still doesn't match anything the crawl saw live.
  reasons.push(`HTTP ${actualStatus ?? '?'} doesn't match any status observed live for this endpoint (${Object.keys(statusCounts).join(', ') || 'none'})`);
  return { failureClass: 'possible-app-bug', reasons, flags };
}

// Batch entry point, mirrors ctx.mjs's attachSummaries(rows) exactly.
export function attachFailureClassification(rows) {
  const ctx = loadClassifyContext();
  let classified = 0;
  for (const row of rows) {
    if (row.status !== 'failed') continue;
    const r = classifyFailure(row, ctx);
    row.failureClass = r.failureClass;
    row.failureReasons = r.reasons;
    row.failureFlags = r.flags;
    if (r.failureClass) classified++;
  }
  return classified;
}
