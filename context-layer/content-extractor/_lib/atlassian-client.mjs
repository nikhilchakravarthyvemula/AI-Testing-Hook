// Atlassian client — the one HTTP path to Jira and Confluence.
//
// Both extractors go through this: auth header construction (DC Bearer PAT or
// Cloud Basic email:token), retry with backoff on 429/5xx honouring
// Retry-After, offset paging for both API families, and typed auth failure.
// The token is registered with the redactor before the first request, so it
// cannot appear in any log line or envelope this process writes.
//
// A 401/403 throws AuthError carrying a ready-made `authRequired` block in the
// same shape the crawler uses for SSO walls (byo-llm-poc/ctx.mjs cmdScan) —
// the extractor puts it in its bundle and the scan carries on with the other
// sources.
//
// See docs/spec-17-knowledge-sources-and-context-layer.md §3–5.

import { registerSecret } from './redact.mjs';

const MAX_TRIES = 4;
const RETRYABLE = new Set([429, 502, 503, 504]);

export class AuthError extends Error {
  constructor(source, host, status) {
    super(`${source} rejected the token (HTTP ${status})`);
    this.name = 'AuthError';
    this.authRequired = {
      source,
      host,
      reason: status === 401 ? 'token-rejected' : 'token-forbidden',
      fix: `node byo-llm-poc/ctx.mjs auth ${source} --url https://${host}`,
    };
  }
}

/**
 * @param {{ source: 'jira'|'confluence', baseUrl: string, token: string,
 *           authMode?: 'bearer'|'basic', email?: string }} cfg
 */
export function createClient({ source, baseUrl, token, authMode = 'bearer', email = null }) {
  registerSecret(token);
  const host = new URL(baseUrl).host;
  const authHeader = authMode === 'basic'
    ? 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64')
    : `Bearer ${token}`;

  async function get(pathname, params = {}) {
    const url = new URL(pathname.replace(/^\//, ''), baseUrl.replace(/\/?$/, '/'));
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    let lastErr;
    for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
      let res;
      try {
        res = await fetch(url, { headers: { Authorization: authHeader, Accept: 'application/json' } });
      } catch (e) {              // DNS / TLS / connection reset — retryable
        lastErr = e;
        await backoff(attempt, null);
        continue;
      }
      if (res.status === 401 || res.status === 403) throw new AuthError(source, host, res.status);
      if (RETRYABLE.has(res.status)) {
        lastErr = new Error(`HTTP ${res.status} from ${url.pathname}`);
        await backoff(attempt, res.headers.get('retry-after'));
        continue;
      }
      if (!res.ok) throw new Error(`${source} HTTP ${res.status} on ${url.pathname}`);
      return res.json();
    }
    throw new Error(`${source} unreachable after ${MAX_TRIES} tries: ${lastErr?.message}`);
  }

  /** Jira search paging: yields issues across startAt windows. */
  async function* searchJira(jql, { fields = [], expand = null, pageSize = 100 } = {}) {
    let startAt = 0;
    for (;;) {
      const page = await get('rest/api/2/search', {
        jql, startAt, maxResults: pageSize,
        fields: fields.join(',') || undefined,
        expand: expand ?? undefined,
      });
      for (const issue of page.issues ?? []) yield issue;
      startAt += (page.issues ?? []).length;
      if (startAt >= (page.total ?? 0) || (page.issues ?? []).length === 0) return;
    }
  }

  /** Confluence content paging: yields results across start windows. */
  async function* searchConfluence(pathname, params = {}, pageSize = 50) {
    let start = 0;
    for (;;) {
      const page = await get(pathname, { ...params, start, limit: pageSize });
      for (const item of page.results ?? []) yield item;
      if (!(page._links?.next) || (page.results ?? []).length === 0) return;
      start += page.results.length;
    }
  }

  return { source, host, get, searchJira, searchConfluence };
}

/** Identity probe — validates a token at capture time and in `auth --check`. */
export async function whoami(client) {
  if (client.source === 'jira') {
    const me = await client.get('rest/api/2/myself');
    return { name: me.name ?? me.accountId, displayName: me.displayName };
  }
  const me = await client.get('rest/api/user/current');
  return { name: me.username ?? me.accountId, displayName: me.displayName };
}

function backoff(attempt, retryAfterHeader) {
  const hinted = retryAfterHeader ? parseInt(retryAfterHeader, 10) * 1000 : 0;
  const ms = Math.max(hinted, 500 * 2 ** (attempt - 1));
  return new Promise((r) => setTimeout(r, ms));
}
