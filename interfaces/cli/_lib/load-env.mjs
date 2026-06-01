// Tiny dotenv-style loader.
//
// Reads <repoRoot>/.env once at CLI startup and copies any vars NOT
// already in process.env. Shell-exported vars always win (standard
// dotenv semantics).
//
// We don't shell out to `dotenv` or add a dependency: the format we
// support is a deliberate subset — KEY=VALUE, optional surrounding
// quotes, # comments, blank lines. No interpolation, no multi-line
// strings, no `export` prefix. If we ever need more, swap in `dotenv`.

import fs from 'node:fs';
import path from 'node:path';

const LINE_RE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/;

export function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return { loaded: 0, path: envPath, found: false };

  let loaded = 0;
  const text = fs.readFileSync(envPath, 'utf8');
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = LINE_RE.exec(line);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    // Strip wrapping quotes (single or double).
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    // Shell-exported wins.
    if (process.env[key] !== undefined) continue;
    process.env[key] = val;
    loaded += 1;
  }
  return { loaded, path: envPath, found: true };
}

/** Load the testing-harness repo's root .env. Called from testo dispatch. */
export function loadRepoEnv(repoRoot) {
  return loadEnvFile(path.join(repoRoot, '.env'));
}
