// LLM advisor — the seam every crawler decision-point uses.
//
// Single public function: `adviseOn({ kind, page, context })` returns
// the LLM's recommendation in a per-kind structured shape. Falls back
// to `null` on any failure (timeout, missing key, invalid JSON, etc.)
// so the crawler can keep its deterministic path when the LLM is sick.
//
// The advisor itself is stateless — it owns the MiniMax client and a
// small JSON-validation step per decision kind. Prompt files live in
// sibling modules (auth-detector.mjs, intent-extract.mjs, …).

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { getClient } from '../../../infrastructure/model-api-connector/index.mjs';
import { parseLooseJson } from './strip-think.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');


// ── env loading ────────────────────────────────────────────────────────────
//
// Re-load <repo>/.env once on import in case the crawler was started
// directly (without going through testo). interfaces/cli/_lib/load-env
// has the canonical loader; we duplicate a tiny version here to avoid
// pulling in CLI deps.

let _envLoaded = false;
function ensureEnvLoaded() {
  if (_envLoaded) return;
  _envLoaded = true;
  const envFile = path.join(REPO_ROOT, '.env');
  if (!fs.existsSync(envFile)) return;
  for (const raw of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const [k, ...rest] = line.split('=');
    const v = rest.join('=').replace(/^['"]|['"]$/g, '').trim();
    if (k && v && !process.env[k.trim()]) process.env[k.trim()] = v;
  }
}


// ── client cache ───────────────────────────────────────────────────────────
//
// Build a single MiniMax client per process and reuse it. fetch() in
// Node 18+ already pools sockets, so this is mostly about avoiding the
// "missing API key" check on every call.

let _client = null;
function getMiniMaxClient() {
  ensureEnvLoaded();
  if (_client) return _client;
  try {
    _client = getClient('minimax');
    return _client;
  } catch (e) {
    console.warn(`[llm-advisor] MiniMax client unavailable: ${e.message}`);
    return null;
  }
}


// ── feature toggle ─────────────────────────────────────────────────────────
//
// `CRAWLER_LLM=0` disables every advisor call. Used for regression runs
// where deterministic output matters more than smarter behaviour.

function llmEnabled() {
  return (process.env.CRAWLER_LLM ?? '1') !== '0';
}


// ── adviser dispatch ───────────────────────────────────────────────────────


/**
 * Run an LLM-backed decision. Returns null on any failure so the crawler
 * falls through to its rule-based path.
 *
 * @param {Object} req
 * @param {'auth-detect'|'intent-extract'} req.kind
 * @param {Object} req.input            decision-specific input shape
 * @param {Object} [req.options]        per-call overrides (timeoutMs, maxTokens, ...)
 * @returns {Promise<Object|null>}
 */
export async function adviseOn(req) {
  if (!llmEnabled()) return null;
  const client = getMiniMaxClient();
  if (!client) return null;

  const handler = HANDLERS[req.kind];
  if (!handler) {
    console.warn(`[llm-advisor] unknown decision kind: ${req.kind}`);
    return null;
  }

  const t0 = Date.now();
  let res;
  try {
    const messages = handler.buildMessages(req.input);
    res = await client.chat({
      messages,
      temperature: handler.temperature ?? 0,
      maxTokens:   req.options?.maxTokens ?? handler.maxTokens ?? 2048,
      timeoutMs:   req.options?.timeoutMs ?? handler.timeoutMs ?? 25_000,
    });
  } catch (e) {
    console.warn(`[llm-advisor] ${req.kind} call failed: ${e.message}`);
    return null;
  }

  const parsed = parseLooseJson(res.content ?? '');
  if (!parsed) {
    console.warn(`[llm-advisor] ${req.kind} returned unparseable content (took ${Date.now() - t0}ms)`);
    return null;
  }

  const validated = handler.validate(parsed);
  if (!validated.ok) {
    console.warn(`[llm-advisor] ${req.kind} response failed validation: ${validated.reason}`);
    return null;
  }

  return {
    kind: req.kind,
    tookMs: Date.now() - t0,
    usage: res.usage,
    recommendation: validated.value,
  };
}


// ── handler registry ───────────────────────────────────────────────────────
//
// Each kind plugs its own prompt-builder + JSON validator into the
// registry. Handlers are exported from sibling files so this index stays
// thin and decision modules can be added without touching dispatch.

import * as authDetector      from './auth-detector.mjs';
import * as intentExtract     from './intent-extract.mjs';
import * as clickableSuggest  from './clickable-suggest.mjs';

const HANDLERS = {
  'auth-detect':       authDetector,
  'intent-extract':    intentExtract,
  'clickable-suggest': clickableSuggest,
};


// ── small helpers exposed for tests ────────────────────────────────────────

export { getMiniMaxClient, llmEnabled, ensureEnvLoaded };
