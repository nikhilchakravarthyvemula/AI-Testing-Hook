// testo run — execute an already-generated test suite.
//
// Maps onto the execution layer. The generation layer writes a self-contained
// suite (curls + _login.sh + run-all.sh); this command runs it and normalizes
// the outcome into output/execution/results.json. Use `testo pipeline` to do
// scan → generate → execute in one shot; use `testo run` to re-run the last
// generated suite (e.g. after the target changes) without regenerating.
//
// Examples:
//   testo run --user admin@example.com --pass secret
//   testo run --suite output/generation/api-tests --url http://localhost:8000

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const opts = parseArgs(process.argv.slice(2));
if (opts.help) { printHelp(); process.exit(0); }

const env = { ...process.env };
if (opts.url) env.BASE_URL = opts.url;
if (opts.user) env.LOGIN_EMAIL = opts.user;
if (opts.pass) env.LOGIN_PASSWORD = opts.pass;
if (opts.suite) env.SUITE_DIR = opts.suite;
if (opts.output) env.EXEC_OUTPUT_DIR = opts.output;
if (opts.keepGoing) env.EXEC_KEEP_GOING = '1';

const executor = path.join(REPO_ROOT, 'execution-layer', 'test-executor', 'run.mjs');
const child = spawn('node', [executor], { env, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));

function parseArgs(argv) {
  const out = { help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '-h':
      case '--help':       out.help = true; break;
      case '--url':        out.url = next(); break;
      case '--email':
      case '--user':
      case '--username':   out.user = next(); break;
      case '--pass':
      case '--password':   out.pass = next(); break;
      case '--suite':
      case '--suite-dir':  out.suite = next(); break;
      case '--output':
      case '--output-dir': out.output = next(); break;
      case '--keep-going': out.keepGoing = true; break;
      default:
        console.error(`testo run: unknown option "${a}"`);
        process.exit(2);
    }
  }
  return out;
}

function printHelp() {
  console.log(`testo run — execute the generated test suite

Usage:
  testo run [--user U --pass P] [--suite DIR] [--url URL]

Options:
  --suite <DIR>      suite to run (default: output/generation/api-tests)
  --url <URL>        override target base URL (else uses the suite's config.sh)
  --user / --pass    login creds for a fresh token
  --output <DIR>     where results.json lands (default: output/execution)
  --keep-going       exit 0 even if some tests fail
  -h, --help         show this help

The suite must already exist — create it with \`testo generate api-tests\`
or \`testo pipeline --no-execute\`.
`);
}
