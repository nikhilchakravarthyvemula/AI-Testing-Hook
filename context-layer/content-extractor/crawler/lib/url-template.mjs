// Shared URL/path templating — was copy-pasted across analyze.mjs, spec.mjs,
// route-tree.mjs, synthesize-urls.mjs. Three DISTINCT vocabularies (kept
// separate on purpose; do not collapse):
//
//   templatePath(pathname)   path segments: numeric / uuid / long-hex → "{id}"
//                            (used by analyze.mjs + spec.mjs — REGRESSION
//                            CRITICAL: must stay byte-identical or apis.json
//                            dedup ids shift).
//   classifyIdShape(value)   id-shape CLASS: "uuid" | "int" | "hex" | null
//                            (used by synthesize-urls.mjs).
//   templateQueryVal(value)  query-value tokens: {id}/{n}/{assetId}/{host}/{hash}
//                            keeping short enums (used by route-tree.mjs).

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const HEX_RE  = /^[0-9a-f]{16,}$/i;
export const INT_RE  = /^\d{1,18}$/;

/** Collapse numeric / uuid / long-hex path segments to `{id}`. */
export function templatePath(p) {
  return p.split('/').map(seg => {
    if (!seg) return seg;
    if (/^\d+$/.test(seg)) return '{id}';
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return '{id}';
    if (/^[0-9a-f]{16,}$/i.test(seg)) return '{id}';
    return seg;
  }).join('/');
}

/** id-shape class of a value, or null if not id-shaped. */
export function classifyIdShape(v) {
  if (typeof v === 'number' && Number.isInteger(v)) return 'int';
  if (typeof v !== 'string') return null;
  if (UUID_RE.test(v)) return 'uuid';
  if (INT_RE.test(v))  return 'int';
  if (HEX_RE.test(v))  return 'hex';
  return null;
}

/** Templatize a query-string VALUE (keeps short enums like tab=overview). */
export function templateQueryVal(v) {
  if (UUID_RE.test(v)) return '{id}';
  if (/^\d+$/.test(v)) return '{n}';
  if (/^(application|ide_ext|skill|mcp|model|unknown|api|prompt):/i.test(v)) return '{assetId}';
  if (/\.local$|^[a-z0-9-]+\.[a-z]{2,}$/i.test(v)) return '{host}';
  if (/[0-9a-f]{16,}/i.test(v)) return '{hash}';
  return v;
}
