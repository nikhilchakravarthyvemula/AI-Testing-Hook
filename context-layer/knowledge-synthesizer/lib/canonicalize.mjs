// Entity resolution — the heart of the synthesizer (spec §4).
//
// Turns the many spellings of one real entity into a single canonical identity
// so the indexer's exact-key duplicates collapse: `/users/{id}` (AST),
// `/users/:id` (spec) and `/users/123` (live) all resolve to the SAME factId.
//
// Everything here is deterministic. Conservatism is the rule: when unsure,
// leave paths distinct rather than over-merge (the optional LLM residue pass —
// §4.5, stubbed — is the only thing allowed to merge non-identical keys).

/** Topic → canonical fact kind. Endpoints arrive from three topics and merge. */
export const TOPIC_KIND = Object.freeze({
  apis:          'endpoint',
  'mock-data':   'endpoint',
  openapi:       'endpoint',
  routes:        'route',
  pages:         'page',
  models:        'model',
  redirects:     'redirect',
  'test-data':   'test-field',
  dependencies:  'dependency',
  interactions:  'interaction',
  'db-schema':   'db-table',
  'click-graph': 'interaction-graph',
});

/** @param {string} topic */
export function kindForTopic(topic) {
  return TOPIC_KIND[topic] ?? topic;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX8_RE = /^[0-9a-fA-F]{8,}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]{16,}$/;

/**
 * Does a long base64url-looking segment carry real ID entropy? (spec §4.1)
 *
 * The discriminator is **a digit OR mixed case**. Random IDs (Pulse tenant ids
 * `iM5XCHE5aF0r5pievMBJNQ`, `oz7f-vIm3vARa_YcLMhEeQ`) always have one or both;
 * hyphen-joined route names (`application-management`) have neither and are
 * preserved.
 *
 * NOTE — deliberate deviation from the spec §4.1 prose, which also lists `-`/`_`
 * as an entropy trigger. That clause contradicts acceptance criterion 6
 * (`application-management`, which contains a hyphen, MUST stay a route). Since
 * both real tenant ids already trip the digit/mixed-case test, dropping the
 * `-`/`_` trigger satisfies every criterion and preserves hyphenated route
 * names. A lowercase, digit-free, hyphenated slug that IS an id stays un-merged
 * — the conservative (never over-merge) default the spec itself mandates.
 */
export function hasIdEntropy(seg) {
  if (/\d/.test(seg)) return true;
  return /[a-z]/.test(seg) && /[A-Z]/.test(seg);   // mixed case
}

/** Rewrite a single path segment to `{id}` when it looks like an identifier. */
export function templateSegment(seg) {
  if (!seg) return seg;
  if (/^:/.test(seg)) return '{id}';               // :id
  if (/^\{.*\}$/.test(seg)) return '{id}';         // {id}, {tenantId}, …
  if (/^<.*>$/.test(seg)) return '{id}';           // <id>
  if (/^\d+$/.test(seg)) return '{id}';            // 123
  if (UUID_RE.test(seg)) return '{id}';
  if (HEX8_RE.test(seg)) return '{id}';            // 8+ hex chars
  if (BASE64URL_RE.test(seg) && hasIdEntropy(seg)) return '{id}';
  return seg;
}

/** Templatize every segment of a path (the leading '' before '/' is kept). */
export function templatePath(p) {
  return String(p).split('/').map((seg, i) => (i === 0 ? seg : templateSegment(seg))).join('/');
}

/** Strip query + hash, collapse `//`, drop trailing slash, keep leading '/'. */
export function normalizePath(p) {
  let s = String(p).split('#')[0].split('?')[0];
  s = s.replace(/\/{2,}/g, '/');
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s || '/';
}

/** Host of a URL or a bare `host[:port]` string; null when unparseable. */
export function hostOf(u) {
  if (!u || typeof u !== 'string') return null;
  try {
    return new URL(u).host;
  } catch {
    return /^[\w.-]+(:\d+)?$/.test(u) ? u : null;
  }
}

/**
 * Collapse the target's own origin to the literal `same-origin`; keep any
 * cross-origin host verbatim so CDN / auth / backend endpoints never merge
 * with app endpoints (spec §4.3). No origin ⇒ code-declared ⇒ same-origin.
 */
export function originKeyFor(origin, targetHost) {
  const h = hostOf(origin);
  if (!h) return 'same-origin';
  if (!targetHost) return 'same-origin';
  return h === targetHost ? 'same-origin' : h;
}

/** Best-effort {method, path, origin} for an endpoint-ish item. */
function endpointIdentity(item) {
  const p = item.primary ?? {};
  let method = p.method;
  let path = p.path ?? p.route ?? p.url ?? null;
  let origin = p.origin ?? p.host ?? null;
  if (!method || !path) {
    for (const o of item.observations ?? []) {
      const f = o.fields ?? {};
      method ??= f.method;
      path ??= f.path ?? f.route ?? f.url;
      origin ??= f.origin ?? f.host ?? null;
      if (method && path) break;
    }
  }
  // A full URL in the path field: split host out so it feeds originKey, not the template.
  if (typeof path === 'string' && /^https?:\/\//i.test(path)) {
    try { const u = new URL(path); origin ??= u.host; path = u.pathname; } catch { /* keep raw */ }
  }
  return { method: String(method ?? 'GET').toUpperCase(), path: path ?? '/', origin };
}

/**
 * Templatize a page/route identity. A full URL is reduced to its pathname
 * (+ hash) so scheme/host don't pollute the identity — e.g.
 * `https://app.example.com/home` → `/home`, not `https:/app.example.com/home`.
 * Path and hash-fragment segments are both templatized; the `#` boundary is
 * preserved so hash-routed SPAs still cluster by fragment.
 */
function templateUrlish(raw) {
  let s = String(raw ?? '').split('?')[0];
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s.split('#')[0]);
      const frag = s.includes('#') ? '#' + s.split('#').slice(1).join('#') : '';
      s = u.pathname + frag;
    } catch { /* not a parseable URL — fall through with the raw string */ }
  }
  return s.split('#').map(part => templatePath(part.replace(/\/{2,}/g, '/'))).join('#') || '/';
}

/**
 * Resolve one IndexedItem to its canonical identity.
 *
 * @param {string} kind
 * @param {import('../../indexer/lib/models.mjs').IndexedItem} item
 * @param {{targetHost: string|null}} ctx
 * @returns {{factId: string, kind: string, key: Object, blockKey: string}}
 */
export function canonicalize(kind, item, ctx) {
  if (kind === 'endpoint') {
    const { method, path, origin } = endpointIdentity(item);
    const pathTemplate = templatePath(normalizePath(path));
    const originKey = originKeyFor(origin, ctx.targetHost);
    const segs = pathTemplate.split('/').filter(Boolean);
    return {
      factId: `endpoint::${method}::${originKey}::${pathTemplate}`,
      kind,
      key: { method, originKey, pathTemplate },
      blockKey: `endpoint|${method}|${originKey}|seg=${segs.length}|first=${segs[0] ?? ''}`,
    };
  }

  if (kind === 'route' || kind === 'page') {
    const raw = item.primary?.path ?? item.primary?.url ?? item.id ?? '/';
    const pathTemplate = kind === 'page' ? templateUrlish(raw) : templatePath(normalizePath(raw));
    return {
      factId: `${kind}::${pathTemplate}`,
      kind,
      key: { pathTemplate },
      blockKey: `${kind}::${pathTemplate}`,
    };
  }

  // Every other kind: the indexer's stable id is already the canonical identity.
  // Keeping it verbatim is the conservative choice — no cross-item merging
  // beyond what the indexer already did.
  const id = String(item.id ?? '');
  return {
    factId: `${kind}::${id}`,
    kind,
    key: { id },
    blockKey: `${kind}::${id}`,
  };
}
