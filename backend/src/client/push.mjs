// Push a locally-produced scan run to a remote backend over HTTP(S).
//
//   node backend/src/client/push.mjs --backend http://localhost:8080 \
//     --run-dir output --app-id demo-app --instance staging-e2e
//
// Packs only what the loader reads (run-summary.json, indexed_output/,
// synthesized/, features/, gaps/) — never bodies/screenshots — and POSTs it
// as a tar.gz to /api/scans/upload. Auth: set API_KEY in the environment.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

const execFileP = promisify(execFile);

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : dflt;
};

const backend = arg('backend', 'http://localhost:8080');
const runDir = arg('run-dir', 'output');
const appId = arg('app-id', 'demo-app');
const instance = arg('instance', 'staging-e2e');

const WANTED = ['run-summary.json', 'indexed_output', 'synthesized', 'features', 'gaps'];

const entries = WANTED.filter((e) => existsSync(join(runDir, e)));
if (!entries.includes('run-summary.json')) {
  console.error(`[push] no run-summary.json in ${runDir} — is the scan complete?`);
  process.exit(1);
}

const archive = join(runDir, '.push.tar.gz');
await execFileP('tar', ['-czf', archive, '-C', runDir, ...entries]);
const body = await readFile(archive);
await rm(archive, { force: true });
console.error(`[push] ${entries.join(', ')} → ${(body.length / 1024).toFixed(0)} KB`);

const url = `${backend.replace(/\/$/, '')}/api/scans/upload` +
  `?appId=${encodeURIComponent(appId)}&instance=${encodeURIComponent(instance)}`;
const headers = { 'Content-Type': 'application/gzip' };
if (process.env.API_KEY) headers['X-API-Key'] = process.env.API_KEY;

const res = await fetch(url, { method: 'POST', headers, body });
const text = await res.text();
if (!res.ok) {
  console.error(`[push] backend returned ${res.status}: ${text}`);
  process.exit(1);
}
console.log(text);
