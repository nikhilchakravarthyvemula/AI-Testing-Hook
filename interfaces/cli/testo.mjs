#!/usr/bin/env node
// testo — the testing-harness CLI.
//
// Architecture: testo is just the user-facing seam. Each subcommand
// hands work off to one layer. Today only `scan` is wired; later
// commands (`plan`, `generate`, `run`, `report`) will map onto the
// other architecture-diagram boxes.
//
//   testo scan        → context-layer       (content extraction)
//   testo generate    → generation-layer    (api-test-generator)
//   testo run         → execution-layer     (test executor)
//   testo pipeline    → orchestration-layer (scan → generate → execute, wrapped)
//   testo plan        → generation-layer    (test plan creator)     [planned]
//   testo report      → execution-layer     (report generator)      [planned]
//
// No options parsed by the top-level — each subcommand owns its own
// flags. This keeps the dispatch layer trivial and lets subcommands
// evolve independently.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadRepoEnv } from './_lib/load-env.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// Auto-load <repo>/.env so testo invocations don't need a shell
// `source .env` first. Shell-exported vars always win.
const envResult = loadRepoEnv(REPO_ROOT);
if (envResult.found && envResult.loaded > 0 && process.env.TESTO_VERBOSE) {
  console.error(`[testo] loaded ${envResult.loaded} vars from ${envResult.path}`);
}

// ── subcommand registry ────────────────────────────────────────────────────

const COMMANDS = {
  scan: {
    description: 'Discover everything we can about a target: crawl the live app, walk the codebase, extract per-framework facts.',
    run: path.join(REPO_ROOT, 'interfaces', 'cli', 'commands', 'scan.mjs'),
  },
  ask: {
    description: 'Ask the agent to do something in plain English. LLM picks the right tools internally.',
    run: path.join(REPO_ROOT, 'interfaces', 'cli', 'commands', 'ask.mjs'),
  },
  generate: {
    description: 'Generate tests from indexed context. `testo generate api-tests` is the first kind.',
    run: path.join(REPO_ROOT, 'interfaces', 'cli', 'commands', 'generate.mjs'),
  },
  run: {
    description: 'Execute an already-generated test suite (execution-layer) → results.json.',
    run: path.join(REPO_ROOT, 'interfaces', 'cli', 'commands', 'run.mjs'),
  },
  pipeline: {
    description: 'Run the whole harness end-to-end: scan → generate → execute (orchestration-layer).',
    run: path.join(REPO_ROOT, 'interfaces', 'cli', 'commands', 'pipeline.mjs'),
  },
};

// ── dispatch ───────────────────────────────────────────────────────────────

const [, , cmd, ...args] = process.argv;

if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') {
  printHelp();
  process.exit(cmd ? 0 : 1);
}

const entry = COMMANDS[cmd];
if (!entry) {
  console.error(`testo: unknown command "${cmd}"`);
  printHelp();
  process.exit(2);
}

// Hand off to the subcommand module in a fresh process. Keeps the
// top-level dispatch in this file lean and lets subcommands set up
// their own env / cwd without polluting the parent.
const child = spawn('node', [entry.run, ...args], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));

// ── help ───────────────────────────────────────────────────────────────────

function printHelp() {
  console.log(`testo — testing-harness CLI

Usage:
  testo <command> [options]

Commands:`);
  for (const [name, meta] of Object.entries(COMMANDS)) {
    console.log(`  ${name.padEnd(10)} ${meta.description}`);
  }
  console.log(`
Run \`testo <command> --help\` for command-specific options.
`);
}
