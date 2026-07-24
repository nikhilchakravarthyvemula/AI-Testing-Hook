#!/usr/bin/env node
// testo — the deterministic device-local testing engine (Service 1, spec-16).
//
// Runs the Playwright crawl + the indexer, producing structured test context
// under output/. No LLM here — the host editor's model (via the BYOLLM skill)
// does the click-intent reasoning; the Python generate/execute lives in the
// web-app service.
//
//   testo scan  --url <URL> [--codebase <PATH>] [--reuse]
//   testo crawl --url <URL>
//   testo index
//
// Env passthrough: LOGIN_EMAIL/LOGIN_PASSWORD, INTERCEPT_MODE, HEADLESS, etc.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, '..', 'src');
const CRAWLER = path.join(SRC, 'crawler', 'extract.mjs');
const INDEXER = path.join(SRC, 'indexer', 'index.mjs');

function run(entry, env, label) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry], { env, stdio: 'inherit' });
    child.on('error', (e) => { console.error(`[testo] ${label} spawn error: ${e.message}`); resolve(1); });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

function parse(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') o.url = argv[++i];
    else if (a === '--codebase' || a === '--code') o.codebase = argv[++i];
    else if (a === '--reuse') o.reuse = true;
    else if (a.startsWith('-')) { console.error(`[testo] unknown option ${a}`); process.exit(2); }
    else o._.push(a);
  }
  return o;
}

function engineEnv(o) {
  const env = { ...process.env, CRAWLER_LLM: '0' };   // deterministic engine
  if (o.url) env.BASE_URL = o.url;
  if (o.codebase) env.TARGET_CODEBASE = path.resolve(o.codebase);
  return env;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const o = parse(rest);
  switch (cmd) {
    case 'crawl': {
      process.exit(await run(CRAWLER, engineEnv(o), 'crawl'));
    }
    case 'index': {
      process.exit(await run(INDEXER, engineEnv(o), 'index'));
    }
    case 'scan': {
      if (!o.url && !o.codebase) { console.error('[testo] scan needs --url or --codebase'); process.exit(2); }
      const env = engineEnv(o);
      if (o.reuse) env.SKIP_CRAWL = '1';
      const c1 = await run(CRAWLER, env, 'crawl');
      const c2 = await run(INDEXER, env, 'index');
      process.exit(c1 === 0 && c2 === 0 ? 0 : 1);
    }
    case 'help': case '-h': case '--help': case undefined:
      console.log('testo — deterministic crawl + index engine\n\n  testo scan --url <URL> [--codebase <PATH>] [--reuse]\n  testo crawl --url <URL>\n  testo index\n');
      break;
    default:
      console.error(`[testo] unknown command "${cmd}". Try: testo help`);
      process.exit(2);
  }
}
main();
