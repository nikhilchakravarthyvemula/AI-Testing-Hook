// testo scan — drives the context-layer end-to-end.
//
// Today the context layer has one sub-component (content-extractor).
// As gap-analyzer, knowledge-synthesizer, feature-extractor, and
// mind-map-builder come online, scan will run them in sequence as
// part of the same command.
//
// Inputs (all optional, but you want at least --url or --codebase):
//   --url <URL>           the live link to crawl (drives crawler)
//   --email <EMAIL>       login email/username (alias: --user)
//   --pass <PASSWORD>     login password
//   --codebase <PATH>     local repo path (drives graphify + per-framework extractors)
//   --backend <NAME>      LLM backend for graphify: gemini | local | auto (default: auto)
//                         'local' is shorthand for ollama (free, slower, JSON-flaky on small models)
//                         'auto' picks gemini if GEMINI_API_KEY is set, else local
//   --model <NAME>        override the default model for the chosen backend
//   --only <ids>          comma-separated extractor ids to limit to (defaults: see below)
//   --skip <ids>          comma-separated extractor ids to skip
//   --no-LLM              disable the crawler's LLM advisor (auth-detect, intent
//                         extraction). LLM is ON by default. Login then uses
//                         heuristic selectors; SSO/MFA auto-escalates to a headed
//                         browser (the crawler decides — no flag needed).
//
// Without --codebase: only the crawler runs (live discovery only).
// Without --url: codebase extractors only (no live crawl).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

// ── arg parsing ────────────────────────────────────────────────────────────

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  printHelp();
  process.exit(0);
}

if (!opts.url && !opts.codebase && !opts.docs && !opts.jira && !opts.confluence) {
  console.error('testo scan: need at least one input — --url, --codebase, --docs, --jira, or --confluence\n');
  printHelp();
  process.exit(2);
}

if (opts.codebase) {
  const abs = path.resolve(opts.codebase);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    console.error(`testo scan: --codebase ${abs} is not a directory`);
    process.exit(2);
  }
  opts.codebase = abs;
}

if (opts.docs) {
  const abs = path.resolve(opts.docs);
  if (!fs.existsSync(abs)) {
    console.error(`testo scan: --docs ${abs} does not exist`);
    process.exit(2);
  }
  opts.docs = abs;
}

// ── extractor selection ────────────────────────────────────────────────────
//
// When --codebase is set, we DO NOT pass an ONLY env var — the
// framework-extractor (which runs first) detects the codebase's
// languages/frameworks and writes `recommendedExtractors`. The
// content-extractor orchestrator reads that file and runs ONLY those.
// Hardcoding a Python-only list here (the original behaviour) defeated
// the whole point of having a smart detector — it stopped frontend
// extractors from running on polyglot repos like logtrim.
//
// The user can still pass `--only python-fastapi,nextjs-app` explicitly
// to override the auto-selection.

let pickedSources = [];
if (opts.only) {
  pickedSources = opts.only.split(',').map(s => s.trim()).filter(Boolean);
}
// else: leave pickedSources empty → orchestrator uses framework-detection
// to pick code-extractors; primary sources (crawler, graphify) run
// unconditionally based on which inputs (--url, --codebase) are provided.

// Crawler has no env-var gate (it'll fall through to BASE_URL default
// if we don't tell it otherwise), so SKIP it explicitly when there's
// nothing to crawl. graphify + framework-extractor are gated on
// TARGET_CODEBASE in the orchestrator already.
const autoSkip = [];
if (!opts.url) autoSkip.push('crawler');

// ── env for the orchestrator ───────────────────────────────────────────────

const env = { ...process.env };

if (opts.url) {
  // BASE_URL is what content-extractor/crawler/crawl.mjs reads.
  env.BASE_URL = opts.url;
}
if (opts.user) env.LOGIN_EMAIL = opts.user;
if (opts.pass) env.LOGIN_PASSWORD = opts.pass;
if (opts.codebase) env.TARGET_CODEBASE = opts.codebase;

// Doc / knowledge sources (gate the new content-extractor sources).
if (opts.docs) env.TEXT_KG_SOURCE = opts.docs;
if (opts.jira) env.JIRA_BASE_URL = opts.jira;
if (opts.jiraProject) env.JIRA_PROJECT = opts.jiraProject;
if (opts.jiraToken) env.JIRA_TOKEN = opts.jiraToken;
if (opts.jiraEmail) env.JIRA_EMAIL = opts.jiraEmail;
if (opts.confluence) env.CONFLUENCE_BASE_URL = opts.confluence;
if (opts.confluenceSpace) env.CONFLUENCE_SPACE = opts.confluenceSpace;
if (opts.confluenceToken) env.CONFLUENCE_TOKEN = opts.confluenceToken;
if (opts.confluenceEmail) env.CONFLUENCE_EMAIL = opts.confluenceEmail;

if (pickedSources.length) env.ONLY = pickedSources.join(',');

// Combine user --skip with auto-skip (sources for which we have no input).
const skipList = [...autoSkip];
if (opts.skip) skipList.push(...opts.skip.split(',').map(s => s.trim()).filter(Boolean));
if (skipList.length) env.SKIP = [...new Set(skipList)].join(',');

// ── graphify backend selection ─────────────────────────────────────────────
//
// `auto`  → let scripts/graphify/tool.py decide (uses Gemini if its key is
//            set in env, else falls back to local ollama).
// `gemini` → force Gemini 2.5 Flash. Requires GEMINI_API_KEY in env.
// `local`  → force local ollama (free, slower, JSON-flaky on small models).
// Any other value is forwarded verbatim (lets advanced users pass
// `openai`, `claude`, `kimi` — graphify supports them too).
let resolvedBackend = 'auto';
if (opts.backend) {
  const b = opts.backend.toLowerCase();
  resolvedBackend = b;
  if (b === 'gemini') {
    // Deliberately disabled — user opted out 2026-05-20 to avoid
    // accidental paid Gemini calls. Re-enable by removing this block AND
    // the matching guard in scripts/graphify/tool.py (_assert_backend_allowed).
    console.error(
      'testo scan: --backend gemini is disabled in this checkout.\n' +
      '  To re-enable: edit interfaces/cli/commands/scan.mjs + scripts/graphify/tool.py\n' +
      '  Currently allowed: minimax, local, auto'
    );
    process.exit(2);
  } else if (b === 'minimax') {
    if (!env.MINIMAX_API_KEY) {
      console.error('testo scan: --backend minimax needs MINIMAX_API_KEY in your environment');
      process.exit(2);
    }
    env.GRAPHIFY_BACKEND = 'minimax';
  } else if (b === 'local' || b === 'ollama') {
    env.GRAPHIFY_BACKEND = 'ollama';
    resolvedBackend = 'local';
  } else if (b === 'auto') {
    delete env.GRAPHIFY_BACKEND;     // let tool.py auto-detect
  } else {
    env.GRAPHIFY_BACKEND = b;
  }
}
if (opts.model) env.GRAPHIFY_MODEL = opts.model;

// LLM is on by default (crawler advisor reads CRAWLER_LLM ?? '1'); --no-LLM disables it.
if (opts.noLLM) env.CRAWLER_LLM = '0';

// ── banner ─────────────────────────────────────────────────────────────────

const authMode = (opts.user || opts.pass)
  ? `creds (LLM ${opts.noLLM ? 'off' : 'on'}; auto-escalates to headed for MFA)`
  : 'none';

console.log('━━━━━━━━━━ testo scan ━━━━━━━━━━');
console.log(`  url       ${opts.url ?? '(none)'}`);
console.log(`  codebase  ${opts.codebase ?? '(none)'}`);
console.log(`  auth      ${authMode}`);
console.log(`  email     ${opts.user ? '✓ set' : '(none)'}`);
console.log(`  pass      ${opts.pass ? '✓ set' : '(none)'}`);
console.log(`  backend   ${resolvedBackend}${opts.model ? `  (model: ${opts.model})` : ''}`);
console.log(`  sources   ${pickedSources.length
  ? `(--only ${pickedSources.join(', ')})`
  : '(auto: framework-extractor picks code-extractors)'}`);
console.log(`  skipping  ${skipList.length ? skipList.join(', ') : '(none)'}`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

// Login is now intelligent + automatic inside the crawl: the crawler's
// ensureAuthenticated() classifies the page (LLM) and fills/SSO headlessly,
// auto-escalating to a headed browser only when a human is needed (MFA /
// CAPTCHA / consent). No --sso flag, no separate pre-step.

// ── handoff: context-layer ─────────────────────────────────────────────────
// scan ALWAYS goes through the context-layer entrypoint, never directly
// to a sub-component. The context layer decides what to run.

const contextRunner = path.join(REPO_ROOT, 'context-layer', 'scan.mjs');
const child = spawn('node', [contextRunner], { env, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));

// ── helpers ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '-h':
      case '--help':     out.help = true; break;
      case '--url':      out.url = next(); break;
      case '--no-llm':
      case '--no-LLM':   out.noLLM = true; break;
      case '--email':
      case '--user':
      case '--username': out.user = next(); break;
      case '--pass':
      case '--password': out.pass = next(); break;
      case '--codebase':
      case '--code':     out.codebase = next(); break;
      case '--docs':     out.docs = next(); break;                 // local md/txt/pdf folder or file
      case '--jira':     out.jira = next(); break;                 // Jira base URL
      case '--jira-project':     out.jiraProject = next(); break;
      case '--jira-token':       out.jiraToken = next(); break;
      case '--jira-email':       out.jiraEmail = next(); break;
      case '--confluence':       out.confluence = next(); break;   // Confluence base URL
      case '--confluence-space': out.confluenceSpace = next(); break;
      case '--confluence-token': out.confluenceToken = next(); break;
      case '--confluence-email': out.confluenceEmail = next(); break;
      case '--only':     out.only = next(); break;
      case '--skip':     out.skip = next(); break;
      case '--backend':  out.backend = next(); break;
      case '--model':    out.model = next(); break;
      default:
        console.error(`testo scan: unknown option "${a}"`);
        process.exit(2);
    }
  }
  return out;
}

function printHelp() {
  console.log(`testo scan — discover everything about a target

Usage:
  testo scan --url <URL> [--email E --pass P] [--codebase PATH] [--no-LLM]

Options:
  --url <URL>           live link to crawl (drives the crawler)
  --email <EMAIL>       login email/username (alias: --user)
  --pass <PASS>         login password
                        Login is automatic + intelligent: the crawler's LLM
                        classifies the page (SSO vs normal) and fills it; it
                        auto-opens a headed browser only when a human is needed
                        (MFA/CAPTCHA/consent), then saves the session.
  --no-LLM              disable the LLM advisor (heuristic login + no intent
                        extraction). LLM is on by default.
  --codebase <PATH>     local repo path (drives graphify + per-framework extractors)
  --backend <NAME>      LLM backend for graphify (default: auto)
                          auto    — picks minimax → … → local based on keys present
                          minimax — MiniMax-M2.7 via Token Plan (default, fast, ~2.5 min/run)
                          local   — local ollama (free, slow, JSON-flaky on small models)
                        (gemini is intentionally disabled in this checkout)
  --model <NAME>        override the model for the chosen backend
  --only <ids>          comma-separated extractor ids to run
  --skip <ids>          comma-separated extractor ids to skip
  -h, --help            show this help

Examples:
  # Code-only scan with MiniMax (default — fast, Token Plan)
  testo scan --codebase /Users/me/myrepo

  # Force local ollama (no API cost, slow)
  testo scan --codebase /Users/me/myrepo --backend local

  # Crawl only — no source code available
  testo scan --url http://localhost:3000 --user admin --pass secret

  # Deployed app behind SSO (Keycloak/Google/Okta…) — login is automatic;
  # a browser opens only if MFA/CAPTCHA needs you.
  testo scan --url https://console-preview.superalign.ai \\
             --email you@example.com --pass 'your-password'

  # Full scan: live crawl + code analysis (MiniMax auto-picked)
  testo scan --url http://localhost:3000 --user admin --pass secret \\
             --codebase /Users/me/myrepo
`);
}
