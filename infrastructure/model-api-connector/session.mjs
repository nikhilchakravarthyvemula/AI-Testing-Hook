// runSession() — the agent-session engine touchpoint (C2b, use case A1).
//
// The one place an LLM gets a tool loop. Given one approved feature slice, it
// runs a bounded agent session that reads context through the context-server
// MCP and writes test files into the run workspace — then holds it to the
// HONESTY RULE: a session that produced no test files is a failure, no matter
// what the model claimed (the lesson from infrastructure/agentic-harness's
// OpenHarness era, carried forward).
//
// Same shape as complete(): it never throws for an engine problem; the caller
// (C6) gets { ok:false, error } and falls back to the template generator for
// that slice. Budget and ledger behave the same way, so single-shot calls and
// agent sessions draw down and are audited from one pool.
//
// C2b is Node, not Python: the OQ-4 spike proved the `claude` CLI hosts MCP and
// runs the full session, so there is no second runtime. See p0-02 §Open Questions.
//
// @typedef {Object} SessionProvider
// @property {string} id
// @property {(ctx: {workspace, system?, prompt, model?, mcpConfigPath?, allowedTools?,
//            maxTurns, timeoutMs, permissionMode?, slice}) =>
//            ({ok:true, model, finalText, usage:{turns,inputTokens,outputTokens}} |
//             {ok:false, error:'engine-unavailable', detail})} runSession

import fs from 'node:fs';
import path from 'node:path';

import { appendLedger, requestsSpent } from './ledger.mjs';
import { createClaudeSessionProvider } from './providers/claude-session.mjs';
import { createMockSessionProvider } from './providers/mock-session.mjs';
import { createCopilotSessionProvider } from './providers/copilot-session.mjs';

const SESSION_FACTORIES = {
  claude: createClaudeSessionProvider,
  mock: createMockSessionProvider,
  copilot: createCopilotSessionProvider,
};

const _cache = new Map();
function getSessionProvider(id) {
  if (!_cache.has(id)) {
    const factory = SESSION_FACTORIES[id];
    if (!factory) {
      throw new Error(`model-api-connector: unknown session engine "${id}". ` +
        `Known: ${Object.keys(SESSION_FACTORIES).join(', ')}`);
    }
    _cache.set(id, factory());
  }
  return _cache.get(id);
}

/** For tests. */
export function _resetSessionProviders() {
  _cache.clear();
}

const DEFAULT_MAX_TURNS = Number(process.env.SESSION_MAX_TURNS || 24);
const DEFAULT_TIMEOUT_MS = Number(process.env.SESSION_TIMEOUT_MS || 300_000);
const SESSION_MIN_BUDGET = Number(process.env.SESSION_MIN_BUDGET || 10);

/**
 * Run one agent session for one feature slice.
 *
 * @param {object} req
 * @param {string} req.workspace       run dir — required
 * @param {object} req.slice           { featureId, name, scenarios[] } — required
 * @param {string} [req.mcpConfigPath] mcp-config.json giving the session its tools
 * @param {string} [req.runId]         stamped into generated file headers
 * @param {string} [req.provider]      engine id; default ENGINE_PROVIDER or "claude"
 * @param {string} [req.model]
 * @param {number} [req.maxRequests]   budget cap
 * @param {number} [req.maxTurns]
 * @returns {Promise<object>} { ok:true, filesWritten, usage, engine, model }
 *   | { ok:false, error:'budget-exhausted'|'engine-unavailable'|'honesty-failure', detail, filesWritten? }
 */
export async function runSession(req) {
  for (const k of ['workspace', 'slice']) {
    if (!req?.[k]) throw new Error(`runSession(): "${k}" is required`);
  }
  const {
    workspace, slice, mcpConfigPath, runId,
    provider = process.env.ENGINE_PROVIDER || 'claude',
    model = process.env.MODEL_API_DEFAULT_MODEL || null,
    maxRequests = Number(process.env.RUN_BUDGET) || Infinity,
    maxTurns = DEFAULT_MAX_TURNS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = req;

  if (!slice.featureId) throw new Error('runSession(): slice.featureId is required');
  const engine = getSessionProvider(provider);
  const startedAt = Date.now();

  // ── budget: don't START a session we can't afford to finish ───────────────
  // A session is many turns; reserving a floor stops us kicking one off with
  // only 1 request left and stranding it half-generated.
  const remaining = maxRequests - requestsSpent(workspace);
  if (remaining < SESSION_MIN_BUDGET) {
    return {
      ok: false, error: 'budget-exhausted',
      detail: `only ${remaining} request(s) left; a session needs a floor of ${SESSION_MIN_BUDGET}`,
    };
  }

  const featureDir = path.join(workspace, 'tests', slice.featureId);
  const before = listFiles(featureDir);

  // ── run the session ───────────────────────────────────────────────────────
  const result = engine.runSession({
    workspace, slice, model, mcpConfigPath, maxTurns, timeoutMs,
    system: buildSystemPrompt(),
    prompt: buildSessionPrompt(slice, runId),
    allowedTools: deriveAllowedTools(mcpConfigPath),
  });

  const durationMs = Date.now() - startedAt;

  if (!result.ok) {
    appendLedger(workspace, sessionLine({
      slice, engine: provider, model: null, requests: 1, durationMs,
      degraded: true, note: `A1 ${result.error}: ${result.detail}`,
    }));
    return { ok: false, error: 'engine-unavailable', detail: result.detail };
  }

  // ── the honesty rule ──────────────────────────────────────────────────────
  const after = listFiles(featureDir);
  const filesWritten = [...after].filter((f) => !before.has(f));

  const requests = result.usage?.turns ?? 1;
  appendLedger(workspace, sessionLine({
    slice, engine: provider, model: result.model, requests, durationMs,
    inputTokens: result.usage?.inputTokens ?? 0,
    outputTokens: result.usage?.outputTokens ?? 0,
    degraded: filesWritten.length === 0,
    note: `A1 ${slice.featureId}: ${filesWritten.length} file(s), ${requests} turn(s)`,
  }));

  if (filesWritten.length === 0) {
    // The model may have said "done" — but it wrote nothing. That is a failure,
    // and C6 will fall back to the template generator for this slice.
    return {
      ok: false, error: 'honesty-failure', filesWritten: [],
      detail: `session for "${slice.featureId}" ended without writing any test file`,
    };
  }

  return {
    ok: true,
    filesWritten: filesWritten.map((f) => path.join('tests', slice.featureId, f)),
    usage: {
      turns: requests, requests,
      inputTokens: result.usage?.inputTokens ?? 0,
      outputTokens: result.usage?.outputTokens ?? 0,
    },
    engine: provider,
    model: result.model,
    durationMs,
  };
}

// ── the A1 behavioural contract (the session's job) ──────────────────────────

function buildSystemPrompt() {
  return [
    'You are a test-generation agent. Your only output is test files written to disk;',
    'you do not explain or summarise. Use the provided MCP tools to read the',
    'application context, and write tests that exercise only what that context',
    'describes. Never invent endpoints, pages, or fields that the context does not',
    'contain. Do not run shell commands.',
  ].join(' ');
}

function buildSessionPrompt(slice, runId) {
  const lines = [];
  lines.push(`Generate tests for the feature "${slice.name}" (id: ${slice.featureId}).`);
  lines.push('');
  lines.push('For EACH scenario below:');
  lines.push(`  1. Call the context-server MCP tools (get_feature_context for "${slice.name}",`);
  lines.push('     and query_endpoints / list_gaps as needed) to get the exact endpoints and');
  lines.push('     pages involved. Use ONLY what those tools return.');
  lines.push(`  2. Write ONE test file at tests/${slice.featureId}/<scenarioId>.spec.mjs`);
  lines.push('     (use the scenarioId as the filename).');
  lines.push('  3. Begin each file with a header comment:');
  lines.push(`     // run: ${runId ?? '(run)'}  scenario: <scenarioId>  generator: agent`);
  lines.push('');
  lines.push('UI and perf scenarios use @playwright/test; api scenarios use a fetch-based');
  lines.push('runnable test. Generate mutation scenarios too — whether they RUN is decided');
  lines.push('later, not by you.');
  lines.push('');
  lines.push('Scenarios:');
  for (const sc of slice.scenarios ?? []) {
    const targets = [
      ...(sc.targets?.endpoints ?? []),
      ...(sc.targets?.pages ?? []),
    ].join(', ');
    lines.push(`  - ${sc.scenarioId} [${sc.kind}${sc.mutation ? ', mutation' : ''}]: ${sc.title}`);
    lines.push(`      intent: ${sc.intent}`);
    if (targets) lines.push(`      targets: ${targets}`);
  }
  lines.push('');
  lines.push('When every scenario has its file, you are done.');
  return lines.join('\n');
}

/** Allow file tools + whatever MCP servers the config declares. Bash is never allowed. */
function deriveAllowedTools(mcpConfigPath) {
  const tools = ['Write', 'Edit', 'Read', 'Glob', 'Grep'];
  if (mcpConfigPath && fs.existsSync(mcpConfigPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf8'));
      for (const name of Object.keys(cfg.mcpServers ?? {})) {
        tools.push(`mcp__${name}`);   // allow the whole server's tool set
      }
    } catch {
      // a broken config just means no MCP tools are allowed — the session will
      // fail the honesty rule (no context → nothing to write), which is honest.
    }
  }
  return tools;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function sessionLine({ slice, engine, model, requests, inputTokens = 0, outputTokens = 0, degraded, durationMs, note }) {
  return {
    useCase: 'A1', caller: 'session', engine, model,
    requests, inputTokens, outputTokens,
    cacheHit: false, degraded, durationMs, note,
    feature: slice.featureId,
  };
}

/** Relative paths of every file under dir (recursive). Empty set if absent. */
function listFiles(dir, base = dir, acc = new Set()) {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, base, acc);
    else acc.add(path.relative(base, full));
  }
  return acc;
}
