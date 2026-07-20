#!/usr/bin/env node
// Context-server MCP (C4, p0-04).
//
// A read-only MCP server (stdio, Node) that serves ONE run's knowledge store to
// the generation agent as just-in-time retrieval tools — the alternative to
// stuffing the whole store into the prompt. The MCP boundary is the point: the
// storage behind it (a JSON file today, anything later) can change without the
// agent noticing.
//
// It owns NO query logic. Every tool is a thin wrapper over the p0-03 store
// accessors (`../knowledge-store/store.mjs`), so `get_feature_context` here and
// `featureContext()` in the plan creator / report are the SAME code — proven by
// server.test.mjs (acceptance 1, byte-for-byte).
//
// Non-Goals it enforces (p0-04 §1): no writes, no LLM, no network, no
// credentials — it reads one file at boot and answers from memory.
//
// The only direct dependency this file adds to the repo is
// `@modelcontextprotocol/sdk`. We use its LOW-LEVEL Server (raw JSON-Schema tool
// defs + our own tiny arg validator) rather than the high-level McpServer, so we
// do NOT also pull zod into our source — keeping the footprint to one package.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
} from '@modelcontextprotocol/sdk/types.js';

import { openStore } from '../knowledge-store/store.mjs';

const SERVER_INFO = { name: 'context-server', version: '0.1.0' };

// JIT retrieval means small slices: a broad query is capped and marked, never
// silently clipped (p0-04 §3, no-silent-caps). The agent can widen a call with
// `maxItems` when it really wants more.
const DEFAULT_MAX_ITEMS = 50;

// ── the four tools ───────────────────────────────────────────────────────────
// Each is { name, description, inputSchema (raw JSON Schema), handler(api,args) }.
// `api` is an openStore() binding; handlers only read it.

const TOOLS = [
  {
    name: 'get_feature_context',
    description:
      'The primary retrieval unit: one feature plus its endpoints ' +
      '(confidence-ranked, provenance-tagged), pages, and prioritized gaps. ' +
      'Look up by feature id or name.',
    inputSchema: {
      type: 'object',
      properties: {
        feature: { type: 'string', description: 'feature id or name' },
        maxItems: { type: 'integer', minimum: 1, description: `cap per list (default ${DEFAULT_MAX_ITEMS})` },
      },
      required: ['feature'],
      additionalProperties: false,
    },
    handler(api, args) {
      const ctx = api.featureContext(args.feature);
      if (!ctx) {
        // Valid string, no match — an execution condition the agent should SEE
        // and recover from, so it's an isError result (fed back to the model),
        // not a thrown protocol error. Empty results get mis-read; this doesn't.
        return toolError(
          `unknown feature "${args.feature}". Valid features: ${validFeatures(api)}`,
        );
      }
      const maxItems = args.maxItems ?? DEFAULT_MAX_ITEMS;
      const { value, truncated } = capLists(ctx, ['endpoints', 'pages', 'gaps'], maxItems);
      return ok(envelope(api.store, { context: value }, truncated));
    },
  },

  {
    name: 'query_endpoints',
    description:
      'Endpoint facts across the run, confidence-ranked, filtered by any of ' +
      'method / pathContains / featureId / minConfidence.',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string' },
        pathContains: { type: 'string' },
        featureId: { type: 'string' },
        minConfidence: { type: 'number', minimum: 0, maximum: 1 },
        maxItems: { type: 'integer', minimum: 1, description: `cap (default ${DEFAULT_MAX_ITEMS})` },
      },
      additionalProperties: false,
    },
    handler(api, args) {
      const { maxItems: mi, ...filter } = args;
      const all = api.queryEndpoints(filter);
      const maxItems = mi ?? DEFAULT_MAX_ITEMS;
      const endpoints = all.slice(0, maxItems);
      return ok(envelope(api.store, { endpoints, total: all.length }, all.length > maxItems));
    },
  },

  {
    name: 'list_gaps',
    description: 'Coverage gaps, prioritized, filtered by featureId and/or severity.',
    inputSchema: {
      type: 'object',
      properties: {
        featureId: { type: 'string' },
        severity: { type: 'string' },
        maxItems: { type: 'integer', minimum: 1, description: `cap (default ${DEFAULT_MAX_ITEMS})` },
      },
      additionalProperties: false,
    },
    handler(api, args) {
      const { maxItems: mi, ...filter } = args;
      const all = api.listGaps(filter);
      const maxItems = mi ?? DEFAULT_MAX_ITEMS;
      const gaps = all.slice(0, maxItems);
      return ok(envelope(api.store, { gaps, total: all.length }, all.length > maxItems));
    },
  },

  {
    name: 'list_features',
    description:
      "The agent's table of contents: every feature with its id, name, and " +
      'endpoint / page / gap counts.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler(api) {
      const features = api.listFeatures();
      return ok(envelope(api.store, { features }, false));
    },
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

// ── server assembly ──────────────────────────────────────────────────────────

/**
 * Build a configured (but not yet connected) MCP Server over an open store.
 * Split from the CLI bootstrap so tests can drive it with an InMemoryTransport.
 *
 * @param {ReturnType<typeof openStore>} api  an openStore() binding
 */
export function createContextServer(api, { serverInfo = SERVER_INFO } = {}) {
  const server = new Server(serverInfo, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = TOOL_BY_NAME.get(req.params.name);
    if (!tool) throw new McpError(ErrorCode.MethodNotFound, `unknown tool "${req.params.name}"`);
    const args = validateInput(tool.name, tool.inputSchema, req.params.arguments);
    return tool.handler(api, args);
  });

  return server;
}

// ── launch descriptor (owned here; consumed by the generate stage, C6) ────────
// The generate stage writes <workspace>/mcp-config.json so runSession() can hand
// the `claude` CLI `--mcp-config`. The session runs with cwd = workspace, so the
// path to THIS file must be ABSOLUTE (the spec's illustrative repo-relative path
// would not resolve from the run dir). `process.execPath` pins the same node.

const SERVER_PATH = fileURLToPath(import.meta.url);

/** The single mcpServers entry that launches this server for a given run. */
export function mcpServerConfig(workspace) {
  return { command: process.execPath, args: [SERVER_PATH, '--workspace', path.resolve(workspace)] };
}

/** Write <workspace>/mcp-config.json and return its path. */
export function writeMcpConfig(workspace, { serverName = 'context-server' } = {}) {
  const cfg = { mcpServers: { [serverName]: mcpServerConfig(workspace) } };
  const p = path.join(workspace, 'mcp-config.json');
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
  return p;
}

// ── response helpers ─────────────────────────────────────────────────────────

/** Every response carries the run identity + freshness + a truncation flag. */
function envelope(store, payload, truncated) {
  return { runId: store.runId, servedAt: new Date().toISOString(), truncated: Boolean(truncated), ...payload };
}

function ok(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

/** A tool-execution error the model reads and recovers from (not a protocol error). */
function toolError(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function validFeatures(api) {
  const list = api.listFeatures().map((f) => `${f.name} (${f.featureId})`);
  return list.length ? list.join(', ') : '(none)';
}

/** Cap the named list fields at maxItems; truncated=true if any was clipped. */
function capLists(obj, fields, maxItems) {
  let truncated = false;
  const value = { ...obj };
  for (const f of fields) {
    const arr = obj[f];
    if (Array.isArray(arr) && arr.length > maxItems) {
      value[f] = arr.slice(0, maxItems);
      truncated = true;
    }
  }
  return { value, truncated };
}

// ── input validation (no zod: a tiny JSON-Schema subset for these four tools) ──

function validateInput(name, schema, rawArgs) {
  const args = rawArgs ?? {};
  if (typeof args !== 'object' || Array.isArray(args)) {
    throw new McpError(ErrorCode.InvalidParams, `${name}: arguments must be an object`);
  }
  const props = schema.properties ?? {};
  for (const key of schema.required ?? []) {
    if (args[key] === undefined) {
      throw new McpError(ErrorCode.InvalidParams, `${name}: missing required argument "${key}"`);
    }
  }
  const out = {};
  for (const [key, val] of Object.entries(args)) {
    const def = props[key];
    if (!def) throw new McpError(ErrorCode.InvalidParams, `${name}: unknown argument "${key}"`);
    checkType(name, key, def, val);
    out[key] = val;
  }
  return out;
}

function checkType(name, key, def, val) {
  const t = def.type;
  const okType =
    t === 'string' ? typeof val === 'string'
      : t === 'number' ? typeof val === 'number' && Number.isFinite(val)
        : t === 'integer' ? Number.isInteger(val)
          : t === 'boolean' ? typeof val === 'boolean'
            : true;
  if (!okType) throw new McpError(ErrorCode.InvalidParams, `${name}: "${key}" must be a ${t}`);
  if (def.enum && !def.enum.includes(val)) {
    throw new McpError(ErrorCode.InvalidParams, `${name}: "${key}" must be one of: ${def.enum.join(', ')}`);
  }
  if ((t === 'number' || t === 'integer')) {
    if (def.minimum != null && val < def.minimum) {
      throw new McpError(ErrorCode.InvalidParams, `${name}: "${key}" must be ≥ ${def.minimum}`);
    }
    if (def.maximum != null && val > def.maximum) {
      throw new McpError(ErrorCode.InvalidParams, `${name}: "${key}" must be ≤ ${def.maximum}`);
    }
  }
}

// ── CLI bootstrap ────────────────────────────────────────────────────────────

function parseWorkspace(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--workspace') return argv[i + 1];
    if (a.startsWith('--workspace=')) return a.slice('--workspace='.length);
  }
  return null;
}

async function main(argv) {
  const workspace = parseWorkspace(argv);
  if (!workspace) {
    process.stderr.write('context-server: --workspace <runDir> is required\n');
    process.exit(2);
  }
  let api;
  try {
    api = openStore(workspace); // single file load at boot; serves from memory
  } catch (e) {
    process.stderr.write(`context-server: ${e.message}\n`);
    process.exit(1);
  }
  const server = createContextServer(api);
  await server.connect(new StdioServerTransport());
  // stdout is the JSON-RPC channel — all logging goes to stderr so it stays clean.
  process.stderr.write(
    `context-server: serving run ${api.store.runId} (${api.store.features.length} features) over stdio\n`,
  );
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`context-server: fatal ${e?.stack || e}\n`);
    process.exit(1);
  });
}
