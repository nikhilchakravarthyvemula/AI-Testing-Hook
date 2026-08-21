// Source config — the NON-secret half of a knowledge-source connection.
//
// `.testo/sources.json` at the repo root holds base URLs, auth modes, project /
// space scoping and instance-specific field IDs. The PAT itself lives in the
// SecretStore (secret-store.mjs), keyed "<source>:<host>". Gitignored because
// internal hostnames are confidential, not because it holds secrets — it never
// does.
//
// Shape:
// {
//   "jira":       { "baseUrl", "authMode": "bearer"|"basic", "email"?,
//                   "projects": ["FRAUD"], "fields": { "acceptanceCriteria": "customfield_10500" } },
//   "confluence": { "baseUrl", "authMode", "email"?, "spaces": ["FRAUD"] },
//   "tribal":     { "path": "docs/tribal" }
// }

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const CONFIG_PATH = path.join(REPO_ROOT, '.testo', 'sources.json');

export function loadSourceConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch { return {}; }
}

/** Shallow-merge one source's config and persist. Returns the full config. */
export function saveSourceConfig(source, patch) {
  const cfg = loadSourceConfig();
  cfg[source] = { ...(cfg[source] ?? {}), ...patch };
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
  return cfg;
}

export function secretKeyFor(source, baseUrl) {
  return `${source}:${new URL(baseUrl).host}`;
}
