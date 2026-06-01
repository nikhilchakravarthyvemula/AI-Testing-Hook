// testo ask — open-ended prompt-driven entrypoint.
//
// Unlike `testo scan` (which is deterministic — runs a known pipeline
// against a known target), `testo ask` takes plain English and lets
// the LLM agent figure out which registered tools to call and how.
//
// Internally:
//   testo ask "<prompt>"
//     → interfaces/cli/commands/ask.mjs (this file)
//     → infrastructure/agentic-harness/bin/ask.py
//     → ToolService.invoke_via_free_agent(prompt, custom_tools=ALL_REGISTERED)
//
// Tool selection is hidden from the CLI. The user asks; the agent acts.
//
// Examples:
//   testo ask "Graphify /Users/me/myrepo and tell me which file has the
//              most outgoing calls"
//
//   testo ask "Look at /Users/me/myrepo with bash + grep and tell me
//              which web framework it uses"

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const GRAPHIFY_PYTHON = path.join(REPO_ROOT, 'scripts', 'graphify', '.venv', 'bin', 'python');
const ASK_PY = path.join(REPO_ROOT, 'infrastructure', 'agentic-harness', 'bin', 'ask.py');

// ── arg parsing ────────────────────────────────────────────────────────────

const opts = parseArgs(process.argv.slice(2));
if (opts.help || !opts.prompt) {
  printHelp();
  process.exit(opts.help ? 0 : 2);
}

if (!fs.existsSync(GRAPHIFY_PYTHON)) {
  console.error(`testo ask: python interpreter missing at ${GRAPHIFY_PYTHON}`);
  console.error('           (the agentic-harness reuses scripts/graphify/.venv)');
  process.exit(2);
}

// ── banner ─────────────────────────────────────────────────────────────────

console.log('━━━━━━━━━━ testo ask ━━━━━━━━━━');
console.log(`  prompt     ${truncate(opts.prompt, 70)}`);
console.log(`  max-turns  ${opts.maxTurns ?? '80 (default)'}`);
if (opts.register?.length) {
  console.log(`  tools      ${opts.register.join(', ')}`);
} else {
  console.log(`  tools      (all registered + full toolbelt)`);
}
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

// ── handoff ────────────────────────────────────────────────────────────────

const argv = [ASK_PY, opts.prompt];
if (opts.maxTurns) argv.push('--max-turns', String(opts.maxTurns));
for (const t of opts.register ?? []) argv.push('--register', t);

const child = spawn(GRAPHIFY_PYTHON, argv, { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));

// ── helpers ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { register: [] };
  // Anything not consumed by a flag becomes the prompt. Allows:
  //   testo ask "do the thing"
  //   testo ask do the thing
  const free = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '-h':
      case '--help':       out.help = true; break;
      case '--max-turns':  out.maxTurns = Number(next()); break;
      case '--register':   out.register.push(next()); break;
      case '--prompt':     out.prompt = next(); break;
      default:
        if (a.startsWith('--')) {
          console.error(`testo ask: unknown option "${a}"`);
          process.exit(2);
        }
        free.push(a);
    }
  }
  if (!out.prompt && free.length) out.prompt = free.join(' ');
  if (!out.register.length) out.register = null;
  return out;
}

function printHelp() {
  console.log(`testo ask — open-ended LLM-driven task runner

Usage:
  testo ask "<prompt>"                  one-shot agentic call
  testo ask --prompt "<prompt>"         (equivalent)

Options:
  --max-turns N         max LLM turns (default: 80)
  --register TOOL       restrict registered tools to this name (repeatable).
                        Default: all tools auto-registered.
  -h, --help            show this help

What it does:
  Loads .env → builds a free-agent loop with the full toolbelt (bash,
  read_file, write_file, edit_file, glob, grep, todo_write, agent) PLUS
  every registered tool (currently: graphify). Sends your prompt to
  the configured LLM (MiniMax-M2.7 by default). The LLM picks tools,
  runs them, chains them, recovers from errors — and reports back.

Examples:
  # Let the agent run graphify and analyse the output
  testo ask "Graphify /Users/me/myrepo, then count how many functions
             are in the largest community."

  # Pure free-form codebase question — no preregistered tools needed
  testo ask --register bash --register grep \\
            "Which web framework does /Users/me/myrepo use?"
`);
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
