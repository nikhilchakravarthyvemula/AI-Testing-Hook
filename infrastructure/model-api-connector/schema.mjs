// Minimal JSON-Schema handling for single-shot completions.
//
// The CLI engine returns free text, not API-native structured output, so schema
// conformance is enforced here in two places: we tell the model exactly what
// shape to return (renderSchemaInstruction), then we check what came back
// (validate) and, on a miss, hand the errors back for one retry (complete.mjs).
//
// This is a DELIBERATE SUBSET, in the spirit of plan-schema.mjs: it validates
// the constructs P0's schemas actually use (type, properties, required, items,
// enum, const, additionalProperties:false) and ignores the rest rather than
// pulling in a full JSON-Schema dependency. Unknown keywords are not enforced —
// they neither pass nor fail; they're simply not checked. Keep P0 schemas within
// this subset, or extend this file.

/** The prompt suffix that instructs the model to emit conforming JSON. */
export function renderSchemaInstruction(schema) {
  return [
    'Respond with ONLY a single JSON value that conforms to this JSON Schema.',
    'No prose, no explanation, no markdown code fences — just the JSON.',
    '',
    'Schema:',
    JSON.stringify(schema, null, 2),
  ].join('\n');
}

/**
 * Parse `text` as JSON and validate it against `schema`.
 *
 * Tolerant of the two things models do even when told not to: a leading/trailing
 * ``` fence, and surrounding whitespace. Anything past that is a real failure.
 *
 * @returns {{ ok: true, value: any } | { ok: false, errors: string[] }}
 */
export function parseAndValidate(text, schema) {
  const stripped = stripFence(text);
  let value;
  try {
    value = JSON.parse(stripped);
  } catch (e) {
    return { ok: false, errors: [`response was not valid JSON: ${e.message}`] };
  }
  const errors = validate(value, schema, '$');
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

// ── validator ──────────────────────────────────────────────────────────────

/** @returns {string[]} human-readable errors, empty if valid. */
export function validate(value, schema, path = '$') {
  const errors = [];

  if (schema.const !== undefined && !deepEqual(value, schema.const)) {
    errors.push(`${path}: must equal ${JSON.stringify(schema.const)}`);
    return errors;
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((e) => deepEqual(e, value))) {
    errors.push(`${path}: must be one of ${JSON.stringify(schema.enum)}`);
    return errors;
  }

  if (schema.type && !typeMatches(value, schema.type)) {
    errors.push(`${path}: expected ${schema.type}, got ${jsonType(value)}`);
    return errors;   // no point checking sub-constraints against the wrong type
  }

  if (schema.type === 'object' || (schema.properties && isObject(value))) {
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${path}.${key}: required property is missing`);
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in value) errors.push(...validate(value[key], sub, `${path}.${key}`));
    }
    if (schema.additionalProperties === false && schema.properties) {
      const allowed = new Set(Object.keys(schema.properties));
      for (const key of Object.keys(value)) {
        if (!allowed.has(key)) errors.push(`${path}.${key}: unexpected property`);
      }
    }
  }

  if (schema.type === 'array' && Array.isArray(value) && schema.items) {
    value.forEach((item, i) => errors.push(...validate(item, schema.items, `${path}[${i}]`)));
  }

  return errors;
}

// ── predicates ───────────────────────────────────────────────────────────────

function typeMatches(value, type) {
  switch (type) {
    case 'object':  return isObject(value);
    case 'array':   return Array.isArray(value);
    case 'string':  return typeof value === 'string';
    case 'number':  return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null':    return value === null;
    default:        return true;   // unknown type keyword — not enforced
  }
}

function jsonType(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function stripFence(text) {
  const t = String(text).trim();
  const fenced = t.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
  return fenced ? fenced[1].trim() : t;
}
