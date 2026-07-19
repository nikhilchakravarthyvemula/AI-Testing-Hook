// complete() — the single-shot engine touchpoint (C2a).
//
// Every Tier-1 call in the project (S1 scenario ideation, S2 entity match, S4
// enrichment; later S6/S7) goes through this one function. It wraps a dumb
// provider with the four things that make an engine call safe to depend on:
//
//   1. CACHE   — the same question twice costs the engine once (and is free even
//                when the budget is spent).
//   2. BUDGET  — never make a call the run's request cap forbids.
//   3. SCHEMA  — when a shape is required, get it or fail cleanly (one retry).
//   4. LEDGER  — every live call is recorded, so cost is auditable and the
//                report can tell the truth about it.
//
// It NEVER throws for an engine problem: a caller gets { ok:false, error } and
// takes its deterministic fallback (docs/harness-use-cases.md). The connector
// does not record degradation itself — that's the caller's markDegraded (C1).
//
// @typedef {Object} SingleShotProvider
// @property {string} id
// @property {(ctx: {system?, prompt, model?, timeoutMs, useCase, cacheKey, workspace}) =>
//            ({ok:true, text, model, usage:{inputTokens,outputTokens}} |
//             {ok:false, error:'engine-unavailable', detail})} singleShot

import { readCache, writeCache, cacheKeyFor } from './cache.mjs';
import { appendLedger, requestsSpent } from './ledger.mjs';
import { renderSchemaInstruction, parseAndValidate } from './schema.mjs';

import { createClaudeProvider } from './providers/claude.mjs';
import { createMockProvider, recordFixture } from './providers/mock.mjs';
import { createCopilotProvider } from './providers/copilot.mjs';

const PROVIDER_FACTORIES = {
  claude: createClaudeProvider,
  mock: createMockProvider,
  copilot: createCopilotProvider,
};

const _providerCache = new Map();
function getProvider(id) {
  if (!_providerCache.has(id)) {
    const factory = PROVIDER_FACTORIES[id];
    if (!factory) {
      throw new Error(`model-api-connector: unknown engine "${id}". ` +
        `Known: ${Object.keys(PROVIDER_FACTORIES).join(', ')}`);
    }
    _providerCache.set(id, factory());
  }
  return _providerCache.get(id);
}

/** For tests: drop memoized providers (e.g. after changing CLAUDE_BIN). */
export function _resetProviders() {
  _providerCache.clear();
}

const DEFAULT_TIMEOUT_MS = Number(process.env.ENGINE_CALL_TIMEOUT_MS || 120_000);
const DEFAULT_MODEL = process.env.MODEL_API_DEFAULT_MODEL || null;

/**
 * Make a single-shot completion.
 *
 * @param {object} req
 * @param {string}  req.useCase        ledger tag, e.g. "S1" — required
 * @param {string}  req.prompt         the user prompt — required
 * @param {string}  req.workspace      run dir; locates cache/ + ledger.jsonl — required
 * @param {string} [req.system]        system prompt
 * @param {object} [req.schema]        JSON Schema the reply must match (see schema.mjs)
 * @param {string} [req.cacheKey]      override the content-hash key
 * @param {string} [req.provider]      engine id; default ENGINE_PROVIDER or "claude"
 * @param {string} [req.model]         model override
 * @param {number} [req.maxRequests]   budget cap; default from env or Infinity
 * @param {number} [req.timeoutMs]
 * @returns {Promise<object>} { ok:true, json?|text, usage, engine, model, cacheHit, durationMs }
 *                          | { ok:false, error:'budget-exhausted'|'engine-unavailable'|'bad-output', detail }
 */
export async function complete(req) {
  const startedAt = Date.now();

  // ── validate the request itself (a programming error, so it DOES throw) ────
  for (const k of ['useCase', 'prompt', 'workspace']) {
    if (!req?.[k]) throw new Error(`complete(): "${k}" is required`);
  }

  const {
    useCase, prompt, workspace, system, schema,
    provider = process.env.ENGINE_PROVIDER || 'claude',
    model = DEFAULT_MODEL,
    maxRequests = Number(process.env.RUN_BUDGET) || Infinity,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = req;

  const cacheKey = req.cacheKey || cacheKeyFor({ useCase, system, prompt, schema });
  const engine = getProvider(provider);

  // ── 1. cache — before budget, before the engine ───────────────────────────
  const cached = readCache(workspace, cacheKey);
  if (cached) {
    appendLedger(workspace, {
      useCase, caller: 'connector', engine: cached.engine, model: cached.model,
      requests: 0, inputTokens: 0, outputTokens: 0,
      cacheHit: true, degraded: false, durationMs: Date.now() - startedAt,
      note: `cache hit (${useCase})`,
    });
    // A hit incurred nothing THIS call — usage is zeroed to match its ledger
    // line. The original cost lives on the first call's line, not here.
    const { usage: _originalUsage, ...payload } = cached;
    return {
      ok: true, ...payload,
      usage: { requests: 0, inputTokens: 0, outputTokens: 0 },
      cacheHit: true, durationMs: Date.now() - startedAt,
    };
  }

  // The prompt the engine actually sees: schema-conformance is prompted, not
  // just validated, so the model knows the target shape.
  const enginePrompt = schema
    ? `${prompt}\n\n${renderSchemaInstruction(schema)}`
    : prompt;

  const budgetLeft = () => requestsSpent(workspace) < maxRequests;

  // ── 2. budget — never make a call the cap forbids ─────────────────────────
  if (!budgetLeft()) {
    return {
      ok: false, error: 'budget-exhausted',
      detail: `budget of ${maxRequests} request(s) is spent — not calling the engine for ${useCase}`,
    };
  }

  // ── first attempt ─────────────────────────────────────────────────────────
  const usage = { requests: 0, inputTokens: 0, outputTokens: 0 };
  let attempt = engine.singleShot({ system, prompt: enginePrompt, model, timeoutMs, useCase, cacheKey, workspace });
  recordAttempt({ workspace, useCase, engine: provider, attempt, usage, startedAt });

  if (!attempt.ok) {
    return { ok: false, error: 'engine-unavailable', detail: attempt.detail };
  }

  // No schema → the text IS the answer.
  if (!schema) {
    return success({ workspace, useCase, cacheKey, cached: {
      text: attempt.text, engine: provider, model: attempt.model,
    }, usage, startedAt, recordText: attempt.text });
  }

  // ── schema: validate, and retry ONCE on a mismatch ────────────────────────
  let check = parseAndValidate(attempt.text, schema);
  if (check.ok) {
    return success({ workspace, useCase, cacheKey, cached: {
      json: check.value, engine: provider, model: attempt.model,
    }, usage, startedAt, recordText: attempt.text });
  }

  if (!budgetLeft()) {
    return { ok: false, error: 'bad-output',
      detail: `output did not match schema and no budget to retry: ${check.errors.join('; ')}` };
  }

  const retryPrompt =
    `${enginePrompt}\n\nYour previous response did not conform. Errors:\n` +
    check.errors.map((e) => `  - ${e}`).join('\n') +
    '\n\nReturn corrected JSON only.';
  attempt = engine.singleShot({ system, prompt: retryPrompt, model, timeoutMs, useCase, cacheKey, workspace });
  recordAttempt({ workspace, useCase, engine: provider, attempt, usage, startedAt });

  if (!attempt.ok) {
    return { ok: false, error: 'engine-unavailable', detail: attempt.detail };
  }
  check = parseAndValidate(attempt.text, schema);
  if (check.ok) {
    return success({ workspace, useCase, cacheKey, cached: {
      json: check.value, engine: provider, model: attempt.model,
    }, usage, startedAt, recordText: attempt.text });
  }
  return { ok: false, error: 'bad-output',
    detail: `output did not match schema after one retry: ${check.errors.join('; ')}` };
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Ledger one live attempt and fold its usage in. Every live call = 1 request. */
function recordAttempt({ workspace, useCase, engine, attempt, usage, startedAt }) {
  usage.requests += 1;
  if (attempt.ok) {
    usage.inputTokens += attempt.usage?.inputTokens ?? 0;
    usage.outputTokens += attempt.usage?.outputTokens ?? 0;
  }
  appendLedger(workspace, {
    useCase, caller: 'connector', engine,
    model: attempt.ok ? attempt.model : null,
    requests: 1,
    inputTokens: attempt.ok ? (attempt.usage?.inputTokens ?? 0) : 0,
    outputTokens: attempt.ok ? (attempt.usage?.outputTokens ?? 0) : 0,
    cacheHit: false,
    degraded: !attempt.ok,          // this individual call failed to deliver
    durationMs: Date.now() - startedAt,
    note: attempt.ok ? `${useCase} ok` : `${useCase} ${attempt.error}: ${attempt.detail}`,
  });
}

/** Persist the cache entry (and optional fixture), then return the success shape. */
function success({ workspace, useCase, cacheKey, cached, usage, startedAt, recordText }) {
  writeCache(workspace, cacheKey, { ...cached, usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } });

  // MOCK_RECORD captures a live engine answer as a replayable fixture, so a
  // later `--engine mock` run reproduces this exact response for free.
  if (process.env.MOCK_RECORD === '1' && cached.engine !== 'mock') {
    recordFixture(useCase, cacheKey, { text: recordText, model: cached.model, usage: {
      inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
    } });
  }

  return {
    ok: true,
    ...(cached.json !== undefined ? { json: cached.json } : { text: cached.text }),
    usage,
    engine: cached.engine,
    model: cached.model,
    cacheHit: false,
    durationMs: Date.now() - startedAt,
  };
}
