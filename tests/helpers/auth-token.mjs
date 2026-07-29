// Bearer-token header for the generated API specs.
//
// OIDC / Firebase backends authenticate with a Bearer token the app mints in
// its own JS — it rides neither the cookies nor the localStorage that
// Playwright's storageState restores, so `context.request` alone 401s. Before
// the suite runs, `ctx execute` harvests a live token into
// output/crawler/auth-token.json (see testo/src/crawler/harvest-token.mjs);
// the API specs read it here and attach it explicitly.
//
// Only the API specs import this. Auth-gate specs must NOT — their whole point
// is to prove an anonymous request is rejected, so they stay header-less.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.resolve(__dirname, '..', '..', 'output', 'crawler', 'auth-token.json');

let _cache;
function readToken() {
  if (_cache !== undefined) return _cache;
  try {
    const t = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    _cache = (t && typeof t.token === 'string' && t.token) ? t : null;
  } catch { _cache = null; }
  return _cache;
}

// Returns { Authorization: 'Bearer <jwt>' } when a token was harvested, else {}.
// Spread into a Playwright request's `headers` option:
//   await request.get(url, { headers: bearerHeaders() })
export function bearerHeaders() {
  const t = readToken();
  if (!t) return {};
  return { Authorization: `${t.scheme || 'Bearer'} ${t.token}` };
}

// True when a token is available — lets a spec annotate/skip meaningfully.
export function hasBearer() {
  return readToken() != null;
}
