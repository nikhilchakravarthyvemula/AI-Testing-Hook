// Feature-key derivation (spec §5.1). Each fact gets exactly one feature key by
// the first structural rule that matches, then well-known segments fold into a
// canonical key via the synonym map. Pure and deterministic.

/** Built-in synonym map: segment → canonical feature key. Data, not code. */
export const BUILTIN_SYNONYMS = Object.freeze({
  login: 'auth', logout: 'auth', signin: 'auth', signout: 'auth',
  'sign-in': 'auth', 'sign-out': 'auth', sso: 'auth', session: 'auth', auth: 'auth',
});

/** Display labels for canonical keys whose Title-Case wouldn't be right. */
export const DISPLAY_LABELS = Object.freeze({ auth: 'Authentication' });

/** Per-fact signal names — strong = structural (rules 1–3). */
export const STRONG_SIGNALS = new Set(['api-path', 'route-fragment', 'redirect-to']);

const API_MARKERS = new Set(['api', 'rest', 'graphql']);
const isMarker = (seg) => API_MARKERS.has(seg) || /^v\d+$/i.test(seg);

/** Lowercase to a safe featureId slug (`[a-z0-9-]`). */
export function slugify(seg) {
  return String(seg).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Fold a raw segment through the synonym map (case-insensitive). */
export function applySynonym(seg, synonyms) {
  const lower = String(seg).toLowerCase();
  return synonyms[lower] ?? seg;
}

/** Split a path into non-empty segments (query/hash already handled by caller). */
function pathSegments(p) {
  return String(p ?? '').split('#')[0].split('?')[0].split('/').filter(Boolean);
}

/**
 * The feature segment of an API-ish path: the segment(s) immediately after the
 * API base marker (`/api/`, `/rest/`, `/graphql`, `/v{n}/`), else the first
 * path segment. `depth` segments are joined with `-`.
 */
export function apiPathSegment(pathTemplate, depth = 1) {
  const segs = pathSegments(pathTemplate);
  if (!segs.length) return null;

  let start = 0;
  const markerIdx = segs.findIndex(isMarker);
  if (markerIdx !== -1) {
    // Skip a run of markers (e.g. api → v1) and start at the first non-marker.
    start = markerIdx;
    while (start < segs.length && isMarker(segs[start])) start += 1;
  }
  const picked = segs.slice(start, start + Math.max(1, depth)).filter(s => !isMarker(s));
  return picked.length ? picked.join('-') : null;
}

/** The first hash-fragment segment of a URL-ish string, else null. */
export function routeFragment(urlish) {
  const s = String(urlish ?? '');
  if (!s.includes('#')) return null;
  const frag = s.split('#')[1] ?? '';
  return frag.split('/').filter(Boolean)[0] ?? null;
}

/**
 * Derive `{key, signal}` for one fact by the §5.1 precedence, or `{key:null}`
 * when no structural rule matches (co-occurrence, then _unassigned, handled by
 * the caller). The synonym map is applied to the raw segment.
 *
 * @param {Object} fact  a CanonicalFact
 * @param {{apiSegmentDepth: number, synonyms: Object}} cfg
 * @returns {{key: string|null, signal: string|null}}
 */
export function featureKey(fact, cfg) {
  const { apiSegmentDepth, synonyms } = cfg;
  let raw = null;
  let signal = null;

  if (fact.kind === 'endpoint' || fact.kind === 'route') {
    raw = apiPathSegment(fact.key?.pathTemplate, apiSegmentDepth);
    signal = 'api-path';
  } else if (fact.kind === 'page' || fact.kind === 'interaction') {
    const urlish = fact.attributes?.fromPage ?? fact.key?.pathTemplate ?? fact.key?.id ?? fact.factId;
    raw = routeFragment(urlish);
    signal = 'route-fragment';
  } else if (fact.kind === 'redirect') {
    const to = fact.attributes?.to ?? fact.key?.to ?? null;
    raw = pathSegments(to)[0] ?? null;
    signal = 'redirect-to';
  }

  if (!raw) return { key: null, signal: null };
  const canonical = slugify(applySynonym(raw, synonyms));
  return canonical ? { key: canonical, signal } : { key: null, signal: null };
}
