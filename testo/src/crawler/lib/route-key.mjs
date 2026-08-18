// route-key.mjs — canonical route-template identity for the whole harness.
//
// The coverage unit of a scan is the route TEMPLATE, not the URL: an app's
// URL space is unbounded (/inventory/{id} × 5000 assets, /policies?rule=X
// × 45 rules) but its template space is bounded by the code. Everything that
// groups, dedups, samples or diffs routes must agree on ONE definition of
// "same template" — this module is that definition. The walker's list-cap
// grouping, the feature-slicer's tagging (generation-layer/feature-slice/
// tag.mjs re-exports templatizePath from here) and the coming per-template
// sampling all import from this file.
//
//   routeKey('https://a.com/inventory/8f3ab129e4?tab=2')
//     → 'https://a.com/inventory/{id}?tab=*'
//   routeKey('https://a.com/app#/case/123?view=full')      (hash-routed SPA)
//     → 'https://a.com/app#/case/{id}?view=*'
//
// Segment heuristics err toward keeping words: only digit-bearing or
// hex/uuid-shaped segments become {id}; 'v2', 'audit-log', 'oauth2' survive.

// OAuth/OIDC callback hashes carry one-time state, not routes — strip before
// deriving identity (same pattern the discovery phase strips before enqueue).
const OAUTH_HASH_RE = /#(?=.*(?:state|session_state|code|iss)=)[^#]*$/;

export function templatizeSegment(seg) {
  if (!seg) return seg;
  if (/^\d+$/.test(seg)) return '{id}';                                  // 123
  if (/^[0-9a-fA-F]{8,}$/.test(seg)) return '{id}';                      // 8f3ab129e4
  if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-/.test(seg)) return '{id}';  // uuid
  if (/\d/.test(seg) && seg.length >= 8) return '{id}';                  // sdk-gIwyr3jR5GjHi6HA
  return seg;
}

export function templatizePath(pathname) {
  let decoded = pathname;
  try { decoded = decodeURIComponent(pathname); } catch { /* keep raw */ }
  const t = decoded.split('/').map(templatizeSegment).join('/');
  return t.length > 1 ? t.replace(/\/+$/, '') : t;
}

// Sorted param-NAME signature: values never distinguish templates.
//   '?rule=hooks-disk-wipe&tab=2' → '?rule=*&tab=*'
function querySignature(search) {
  if (!search) return '';
  const names = [...new Set([...new URLSearchParams(search).keys()])].sort();
  return names.length ? '?' + names.map((n) => `${n}=*`).join('&') : '';
}

/**
 * Effective route parts, hash-SPA aware. For '#/'-routed URLs the ROUTE lives
 * in the fragment, so `path` embeds it ('/app#/case/123') and `search` is the
 * fragment's query — pathname-based consumers (route-tree, synthesize,
 * analyze) use this instead of new URL(u).pathname, which collapses every
 * hash route into one. Returns null when the URL doesn't parse.
 */
export function effectiveParts(url, base) {
  let u;
  try { u = new URL(String(url).replace(OAUTH_HASH_RE, ''), base); }
  catch { return null; }
  if (u.hash.startsWith('#/')) {
    const [hashPath, hashQuery = ''] = u.hash.slice(1).split('?');
    return {
      origin: u.origin,
      path: `${u.pathname}#${hashPath}`,
      search: hashQuery ? `?${hashQuery}` : '',
      hashRouted: true,
    };
  }
  return { origin: u.origin, path: u.pathname, search: u.search, hashRouted: false };
}

/**
 * Canonical template key for a URL. `base` resolves relative hrefs.
 * Falls back to the raw string when the URL doesn't parse.
 */
export function routeKey(url, base) {
  let u;
  try { u = new URL(String(url).replace(OAUTH_HASH_RE, ''), base); }
  catch { return String(url); }
  
  // Hash-routed SPA: the real route lives in the fragment ('#/case/123?x=1').
  // Pathname-based identity would collapse EVERY route into one key there —
  // the exact fan-out killer seen on hash-routed apps (HSBC pulseviews).
  if (u.hash.startsWith('#/')) {
    const [hashPath, hashQuery = ''] = u.hash.slice(1).split('?');
    return `${u.origin}${templatizePath(u.pathname)}#${templatizePath(hashPath)}${querySignature(hashQuery)}`;
  }

  return `${u.origin}${templatizePath(u.pathname)}${querySignature(u.search)}`;
}
