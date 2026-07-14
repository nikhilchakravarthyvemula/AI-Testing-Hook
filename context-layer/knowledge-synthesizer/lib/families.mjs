// Source-family classification (spec §5.1).
//
// Confidence fusion must not double-count correlated evidence. Two AST passes
// over the SAME file are one family (their agreement is not independent); the
// crawler and mock-data both watch the SAME live system, so they are always the
// single `runtime` family. Independence lives BETWEEN families, and only there
// does noisy-OR apply.

const RUNTIME_SOURCES = new Set(['crawler', 'mock-data']);
const SPEC_SOURCES = new Set(['openapi-spec', 'openapi-file', 'markdown-apispec']);
const DOCS_SOURCES = new Set(['docs', 'docs-extracted', 'diagram', 'user-answered', 'user']);

/**
 * Classify a sourceId into one of the four family classes. Anything not
 * explicitly runtime/spec/docs is `code` (AST + framework extractors + graphify
 * + db-schema). Matching is prefix-tolerant so decorated ids like
 * `db-schema (deterministic)` still classify as code.
 *
 * @param {string} sourceId
 * @returns {'runtime'|'spec'|'docs'|'code'}
 */
export function classify(sourceId) {
  const id = String(sourceId ?? '');
  const root = id.split(' ')[0];   // "db-schema (deterministic)" → "db-schema"
  if (RUNTIME_SOURCES.has(root)) return 'runtime';
  if (SPEC_SOURCES.has(root)) return 'spec';
  if (DOCS_SOURCES.has(root)) return 'docs';
  return 'code';
}

/**
 * The family an observation belongs to. `runtime` collapses to a single key
 * regardless of file (correlated live views); code/spec/docs are keyed by
 * sourceFile so same-file extractors share a family and different-file ones
 * stay independent. NEVER keyed by contentHash (spec §5.1).
 *
 * @param {import('../../indexer/lib/models.mjs').Observation} obs
 * @returns {{class: 'runtime'|'spec'|'docs'|'code', key: string}}
 */
export function familyOf(obs) {
  const cls = classify(obs.sourceId);
  if (cls === 'runtime') return { class: 'runtime', key: 'runtime' };
  const file = obs.sourceFile || '(no-file)';
  return { class: cls, key: `${cls}:${file}` };
}
