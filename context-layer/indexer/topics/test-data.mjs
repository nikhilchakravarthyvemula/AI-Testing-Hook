// Topic: test-data — form fields + their semantic intent.
//
// Goal: drive the test-data generator. Each item answers "if a test
// needs to fill this form, what values should it use?".
//
// Sources:
//   * crawler.facts.pages[].forms   — live HTML form structure
//   * nextjs-app / nextjs-pages / ... formFields[]  — declared form intent
//
// Dedup key: `${page}#${formId-or-action}::${fieldName}`.

import { indexedItem, observation, provenanceOf } from '../lib/models.mjs';


/** @param {import('../lib/sources.mjs').LoadedSources} sources */
export function build(sources) {
  /** @type {Map<string, {primary: Object, observations: import('../lib/models.mjs').Observation[]}>} */
  const byKey = new Map();

  // ── crawler-observed forms (DOM-level truth) ─────────────────────────
  for (const page of sources.crawler?.facts?.pages ?? []) {
    const pageUrl = page.finalUrl || page.requestedUrl || 'unknown';
    for (const form of page.forms ?? []) {
      const formKey = form.id || form.action || form.name || `form-${Object.keys(form).join(',')}`;
      for (const field of form.fields ?? []) {
        const fieldName = field.name || field.id || field.type || 'unknown';
        const key = `${pageUrl}#${formKey}::${fieldName}`;
        _add(byKey, key, {
          page: pageUrl,
          formId: formKey,
          formAction: form.action,
          formMethod: form.method,
          fieldName,
          fieldType: field.type,
          required: field.required ?? false,
          placeholder: field.placeholder ?? null,
          defaultValue: field.value ?? null,
          autocomplete: field.autocomplete ?? null,
        }, { sourceId: 'crawler', discoveryTier: 'live_observed' });
      }
    }
  }

  // ── code-extractor formFields[] (intent-level annotation) ──────────────
  for (const [id, bundle] of Object.entries(sources.codeExtractors)) {
    if (!bundle.formFields?.length) continue;
    for (const f of bundle.formFields) {
      // formFields don't always have a containing page; key by intent + name
      const formKey = f.form_intent || 'form';
      const fieldName = f.name || f.field_type || 'unknown';
      const key = `intent:${formKey}::${fieldName}`;
      _add(byKey, key, {
        formIntent: f.form_intent,
        fieldName,
        fieldType: f.field_type,
        defaultValue: f.default_value,
        accept: f.accept,
        autocomplete: f.autocomplete,
        isDisabled: f.is_disabled,
      }, {
        sourceId: id, discoveryTier: 'ast', ...provenanceOf(f),
      });
    }
  }

  return [...byKey.entries()].map(([key, { primary, observations }]) =>
    indexedItem('test-data', key, primary, observations)
  );
}


function _add(map, key, fields, prov) {
  let bucket = map.get(key);
  if (!bucket) {
    bucket = {
      primary: {
        fieldName: fields.fieldName,
        fieldType: fields.fieldType,
        formIntent: fields.formIntent ?? null,
        page: fields.page ?? null,
      },
      observations: [],
    };
    map.set(key, bucket);
  }
  bucket.observations.push(observation({ ...prov, fields }));
  bucket.primary.fieldType ??= fields.fieldType;
  bucket.primary.formIntent ??= fields.formIntent;
}
