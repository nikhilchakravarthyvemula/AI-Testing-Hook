// testo generate <kind> — generation-layer entrypoint.
//
// Today only `api-tests` is wired. Pattern matches `testo scan`'s
// dispatch: this file is the front door; sub-kinds map to specific
// skills under generation-layer/ via the skill-register.
//
// Examples:
//   testo generate api-tests --url http://localhost:3000 \
//                            --user admin@example.com --pass secret
//   testo generate api-tests --no-execute    # write curls but don't run them
//   testo generate api-tests --max-tests 5   # quick smoke run

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const GRAPHIFY_PYTHON = path.join(REPO_ROOT, 'scripts', 'graphify', '.venv', 'bin', 'python');
const CALL_SKILL_PY   = path.join(REPO_ROOT, 'infrastructure', 'skill-register', 'bin', 'call_skill.py');

const KINDS = {
  'api-tests': {
    skill: 'api-test-generator',
    description: 'Build + run curl-based API tests against the live target.',
  },
};

// ── parse argv ─────────────────────────────────────────────────────────────

const [kindArg, ...rest] = process.argv.slice(2);
const opts = parseArgs(rest);

if (opts.help || !kindArg || kindArg === '-h' || kindArg === '--help') {
  printHelp();
  process.exit(opts.help ? 0 : 2);
}

const kind = KINDS[kindArg];
if (!kind) {
  console.error(`testo generate: unknown kind "${kindArg}". Available: ${Object.keys(KINDS).join(', ')}`);
  process.exit(2);
}

// ── env ────────────────────────────────────────────────────────────────────

const env = { ...process.env };
// Map our user-facing flags onto skill-register's --key value pairs.
const skillArgs = [];
const PUSH = (k, v) => { skillArgs.push(`--${k}`, String(v)); };

if (opts.url)       env.BASE_URL = opts.url;
if (opts.user)      PUSH('login_email',    opts.user);
if (opts.pass)      PUSH('login_password', opts.pass);
if (opts.url)       PUSH('base_url',       opts.url);
if (opts.outputDir) PUSH('output_dir',     opts.outputDir);
if (opts.maxTests)  PUSH('max_tests',      opts.maxTests);
if (opts.timeout)   PUSH('timeout_s',      opts.timeout);
if (opts.noExecute) PUSH('execute',        'false');

// ── banner ─────────────────────────────────────────────────────────────────

console.log('━━━━━━━━━━ testo generate ━━━━━━━━━━');
console.log(`  kind        ${kindArg}  (skill: ${kind.skill})`);
console.log(`  url         ${opts.url ?? '(auto-detect from crawler bundle)'}`);
console.log(`  user        ${opts.user ? '✓ set' : '(no login)'}`);
console.log(`  output      ${opts.outputDir ?? 'output/generation/api-tests'}`);
console.log(`  execute     ${opts.noExecute ? 'NO — generate curls only' : 'YES'}`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

// ── handoff ────────────────────────────────────────────────────────────────

if (!fs.existsSync(GRAPHIFY_PYTHON)) {
  console.error(`testo generate: python interpreter missing at ${GRAPHIFY_PYTHON}`);
  process.exit(2);
}
if (!fs.existsSync(CALL_SKILL_PY)) {
  console.error(`testo generate: skill-register CLI missing at ${CALL_SKILL_PY}`);
  process.exit(2);
}

const argv = [CALL_SKILL_PY, kind.skill, '--mode', 'direct', ...skillArgs];
const child = spawn(GRAPHIFY_PYTHON, argv, { env, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));


// ── helpers ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '-h':
      case '--help':         out.help = true; break;
      case '--url':          out.url = next(); break;
      case '--user':
      case '--username':     out.user = next(); break;
      case '--pass':
      case '--password':     out.pass = next(); break;
      case '--output':
      case '--output-dir':   out.outputDir = next(); break;
      case '--max-tests':    out.maxTests = next(); break;
      case '--timeout':      out.timeout = next(); break;
      case '--no-execute':   out.noExecute = true; break;
      default:
        console.error(`testo generate: unknown option "${a}"`);
        process.exit(2);
    }
  }
  return out;
}

function printHelp() {
  console.log(`testo generate <kind> [options]

Kinds:`);
  for (const [k, v] of Object.entries(KINDS)) {
    console.log(`  ${k.padEnd(14)} ${v.description}`);
  }
  console.log(`
Common options:
  --url <URL>            target API base URL (defaults to crawler bundle's first API origin)
  --user <USER>          login email/username (skill skips login if absent)
  --pass <PASS>          login password
  --output-dir <PATH>    where to write generated tests + results (default: output/generation/<kind>)
  --max-tests <N>        cap the number of APIs to test
  --timeout <SECONDS>    per-curl timeout (default: 30)
  --no-execute           generate the curl scripts but don't run them
  -h, --help             show this help

Examples:
  testo generate api-tests \\
        --url http://localhost:3000 --user admin@example.com --pass secret

  testo generate api-tests --no-execute        # generate scripts only
  testo generate api-tests --max-tests 5       # smoke run
`);
}
