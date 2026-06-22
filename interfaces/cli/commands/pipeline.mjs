// testo pipeline — run the whole harness end-to-end.
//
// The orchestration layer wraps the three working layers:
//
//   scan (context-layer) → generate (generation-layer) → execute (execution-layer)
//
// This front door parses the user-facing flags (same vocabulary as
// `testo scan` + `testo generate`), maps them onto the env contract the
// orchestrator reads, and hands off to orchestration-layer/pipeline.mjs.
//
// Examples:
//   testo pipeline --url http://localhost:8000 --user admin@x.com --pass secret
//   testo pipeline --url http://localhost:8000 --codebase /Users/me/app --user a@b --pass p
//   testo pipeline --url http://localhost:8000 --stages generate,execute   # skip scan
//   testo pipeline --url http://localhost:8000 --no-execute                # write tests, don't run
//   testo pipeline --codebase /Users/me/app --stages scan                  # scan only

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const opts = parseArgs(process.argv.slice(2));
if (opts.help) { printHelp(); process.exit(0); }

if (!opts.url && !opts.codebase) {
  console.error('testo pipeline: need at least --url or --codebase\n');
  printHelp();
  process.exit(2);
}

if (opts.codebase) {
  const abs = path.resolve(opts.codebase);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    console.error(`testo pipeline: --codebase ${abs} is not a directory`);
    process.exit(2);
  }
  opts.codebase = abs;
}

// ── env contract (shared with scan.mjs / generate.mjs + the orchestrator) ────

const env = { ...process.env };

if (opts.url) env.BASE_URL = opts.url;
if (opts.codebase) env.TARGET_CODEBASE = opts.codebase;
if (opts.user) env.LOGIN_EMAIL = opts.user;
if (opts.pass) env.LOGIN_PASSWORD = opts.pass;
if (opts.noLLM) env.CRAWLER_LLM = '0';

// graphify backend (same policy as `testo scan`: gemini disabled this checkout).
let resolvedBackend = 'auto';
if (opts.backend) {
  const b = opts.backend.toLowerCase();
  resolvedBackend = b;
  if (b === 'gemini') {
    console.error('testo pipeline: --backend gemini is disabled in this checkout (allowed: minimax, local, auto)');
    process.exit(2);
  } else if (b === 'minimax') {
    if (!env.MINIMAX_API_KEY) { console.error('testo pipeline: --backend minimax needs MINIMAX_API_KEY'); process.exit(2); }
    env.GRAPHIFY_BACKEND = 'minimax';
  } else if (b === 'local' || b === 'ollama') {
    env.GRAPHIFY_BACKEND = 'ollama'; resolvedBackend = 'local';
  } else if (b === 'auto') {
    delete env.GRAPHIFY_BACKEND;
  } else {
    env.GRAPHIFY_BACKEND = b;
  }
}
if (opts.model) env.GRAPHIFY_MODEL = opts.model;

// orchestrator controls.
if (opts.stages) env.ORCH_STAGES = opts.stages;
if (opts.noExecute) env.ORCH_EXECUTE = '0';
if (opts.maxTests) env.ORCH_MAX_TESTS = String(opts.maxTests);
if (opts.continueOnError) env.ORCH_CONTINUE = '1';

// ── banner ───────────────────────────────────────────────────────────────────

console.log('━━━━━━━━━━ testo pipeline ━━━━━━━━━━');
console.log(`  url        ${opts.url ?? '(none)'}`);
console.log(`  codebase   ${opts.codebase ?? '(none)'}`);
console.log(`  auth       ${opts.user ? '✓ creds set' : 'none'}`);
console.log(`  backend    ${resolvedBackend}${opts.model ? `  (model: ${opts.model})` : ''}`);
console.log(`  stages     ${opts.stages ?? 'scan,generate,execute'}`);
console.log(`  execute    ${opts.noExecute ? 'NO — generate only' : 'yes'}`);
console.log(`  on-error   ${opts.continueOnError ? 'continue' : 'stop'}`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

// ── handoff: orchestration-layer ──────────────────────────────────────────────

const orchestrator = path.join(REPO_ROOT, 'orchestration-layer', 'pipeline.mjs');
const child = spawn('node', [orchestrator], { env, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));

// ── helpers ──────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '-h':
      case '--help':            out.help = true; break;
      case '--url':             out.url = next(); break;
      case '--codebase':
      case '--code':            out.codebase = next(); break;
      case '--email':
      case '--user':
      case '--username':        out.user = next(); break;
      case '--pass':
      case '--password':        out.pass = next(); break;
      case '--no-llm':
      case '--no-LLM':          out.noLLM = true; break;
      case '--backend':         out.backend = next(); break;
      case '--model':           out.model = next(); break;
      case '--stages':          out.stages = next(); break;          // csv: scan,generate,execute
      case '--max-tests':       out.maxTests = next(); break;
      case '--no-execute':      out.noExecute = true; break;
      case '--continue-on-error': out.continueOnError = true; break;
      default:
        console.error(`testo pipeline: unknown option "${a}"`);
        process.exit(2);
    }
  }
  return out;
}

function printHelp() {
  console.log(`testo pipeline — run scan → generate → execute end-to-end

Usage:
  testo pipeline --url <URL> [--codebase PATH] [--user U --pass P] [options]

Options:
  --url <URL>            live target to crawl + test
  --codebase <PATH>      local repo to analyse (drives graphify + code extractors)
  --user / --pass        login creds (crawler login + API token)
  --stages <csv>         subset/order of: scan,generate,execute  (default: all)
  --no-execute           run scan + generate but don't execute the tests
  --max-tests <N>        cap how many APIs the generator turns into tests
  --continue-on-error    keep going if a stage fails (default: stop)
  --backend <NAME>       graphify LLM backend: auto | minimax | local
  --model <NAME>         override the model for the chosen backend
  --no-LLM               disable the crawler's LLM advisor
  -h, --help             show this help

Stages:
  scan       context-layer/scan.mjs            crawl + extract + index → knowledge base
  generate   generation-layer/api-test-generator  build the runnable test suite (no side effects)
  execute    execution-layer/test-executor        run the suite, normalize → output/execution/results.json

Examples:
  # Full run against a live app with a local codebase
  testo pipeline --url http://localhost:8000 --codebase /Users/me/app \\
                 --user admin@example.com --pass secret

  # Re-generate + re-run without re-scanning
  testo pipeline --url http://localhost:8000 --stages generate,execute --user a@b --pass p

  # Dry generation (write the suite, inspect it, run later with: testo run)
  testo pipeline --url http://localhost:8000 --no-execute
`);
}
