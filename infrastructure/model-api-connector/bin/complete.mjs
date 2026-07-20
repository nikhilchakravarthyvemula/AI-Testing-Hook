#!/usr/bin/env node
// The S4 bridge — a CLI wrapper over complete() (p0-02 §3.4, OQ-5).
//
// graphify's enrichment is Python; it can't `import` the Node connector. Rather
// than reintroduce a Python engine path, a Python caller shells to THIS process,
// so its single-shot call inherits everything complete() provides — the run's
// content cache, the ledger line, and the budget cap. One connector, one place
// cost is audited, whatever language the caller is written in.
//
// Contract (language-agnostic, JSON over stdio):
//   stdin : a JSON request object —
//     { useCase, prompt, workspace,            // required
//       system?, schema?, provider?, model?, maxRequests?, cacheKey? }
//   stdout: the JSON result complete() returned —
//     { ok:true, json?|text?, usage, engine, model, cacheHit, durationMs }
//     | { ok:false, error, detail }            // engine down / budget spent
//   exit  : 0 whenever a RESULT was produced (ok true OR false — the caller
//           reads `ok` and falls back deterministically on false);
//           2 only on a malformed invocation (bad JSON / missing field), which
//           is a bug in the caller, not an engine outcome.
//
// So a Python caller distinguishes "bridge worked, engine unavailable → use the
// raw-AST fallback" (exit 0, ok:false) from "I called the bridge wrong" (exit 2).

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadRepoEnv } from '../../../interfaces/cli/_lib/load-env.mjs';
import { complete } from '../index.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

// So ENGINE_PROVIDER / RUN_BUDGET / model defaults resolve exactly as they do
// for an in-process caller. The payload may still override any of them.
loadRepoEnv(REPO_ROOT);

const REQUIRED = ['useCase', 'prompt', 'workspace'];
const PASS_THROUGH = [
  'useCase', 'prompt', 'workspace', 'system', 'schema',
  'provider', 'model', 'maxRequests', 'cacheKey',
];

main();

async function main() {
  let req;
  try {
    req = JSON.parse(await readStdin());
  } catch (e) {
    return fail(`request was not valid JSON: ${e.message}`);
  }
  if (req === null || typeof req !== 'object' || Array.isArray(req)) {
    return fail('request must be a JSON object');
  }
  for (const k of REQUIRED) {
    if (req[k] === undefined || req[k] === null || req[k] === '') {
      return fail(`missing required field "${k}"`);
    }
  }

  // Only forward the fields complete() knows — an unexpected key is the caller's
  // mistake, but a harmless one; we drop it rather than fail the whole call.
  const call = {};
  for (const k of PASS_THROUGH) if (req[k] !== undefined) call[k] = req[k];

  let result;
  try {
    result = await complete(call);
  } catch (e) {
    // complete() throws only for a programming error (a required arg it still
    // found missing) — surface it as a bad request, not an engine result.
    return fail(`complete() rejected the request: ${e.message}`);
  }

  process.stdout.write(JSON.stringify(result) + '\n');
  process.exit(0);
}

function fail(detail) {
  process.stdout.write(JSON.stringify({ ok: false, error: 'bad-request', detail }) + '\n');
  process.exit(2);
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}
