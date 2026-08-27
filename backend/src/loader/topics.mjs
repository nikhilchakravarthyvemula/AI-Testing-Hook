// Per-topic upserts: indexed_output/<topic>.json items → typed scan_* rows.
// Every function is idempotent (ON CONFLICT ... DO UPDATE on the table's arbiter)
// and returns a map of natural-key → row uuid so observations can attach.
import { randomUUID } from 'node:crypto';

const jb = (v) => (v == null ? null : JSON.stringify(v));

// First non-null value of `key` across an item's observation fields.
function fromFields(item, key) {
  for (const obs of item.observations ?? []) {
    const v = obs?.fields?.[key];
    if (v !== undefined && v !== null) return v;
  }
  return null;
}

async function insertObservations(client, scanId, entityType, entityId, observations) {
  for (const o of observations ?? []) {
    await client.query(
      `INSERT INTO observation
         (id, scan_id, entity_type, entity_id, source_id, discovery_tier, confidence,
          source_file, line_start, line_end, content_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (scan_id, entity_type, entity_id, source_id,
                    coalesce(source_file,''), coalesce(line_start,-1))
       DO UPDATE SET confidence = EXCLUDED.confidence, content_hash = EXCLUDED.content_hash`,
      [randomUUID(), scanId, entityType, entityId, o.sourceId, o.discoveryTier ?? null,
       o.confidence ?? null, o.sourceFile ?? null, o.sourceLineStart ?? null,
       o.sourceLineEnd ?? null, o.contentHash ?? null]
    );
  }
}

export async function loadApis(client, scanId, items) {
  let n = 0;
  for (const item of items) {
    const p = item.primary ?? {};
    const { rows } = await client.query(
      `INSERT INTO scan_api (id, scan_id, natural_key, method, path, origin, framework,
         handler, operation_id, summary, tags, auth_required, observed_auth,
         status_counts, content_types, request_schema_ref, response_schemas, parameters,
         query_param_names, sample_count, avg_request_ms, avg_response_bytes,
         triggered_by_pages, consensus)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15::jsonb,
               $16,$17::jsonb,$18::jsonb,$19,$20,$21,$22,$23,$24)
       ON CONFLICT (scan_id, natural_key) DO UPDATE SET
         status_counts = EXCLUDED.status_counts, sample_count = EXCLUDED.sample_count,
         auth_required = EXCLUDED.auth_required, consensus = EXCLUDED.consensus,
         avg_request_ms = EXCLUDED.avg_request_ms,
         triggered_by_pages = EXCLUDED.triggered_by_pages
       RETURNING id`,
      [randomUUID(), scanId, item.id, p.method, p.path, p.origin ?? null,
       p.framework ?? null, p.handler ?? null, p.operationId ?? null, p.summary ?? null,
       p.tags ?? null, p.authRequired ?? null, jb(p.observedAuth), jb(p.statusCounts),
       jb(p.contentTypes), p.requestSchemaRef ?? null, jb(p.responseSchemas),
       jb(p.parameters), p.queryParamNames ?? null, p.sampleCount ?? null,
       p.avgRequestMs ?? null, p.avgResponseBytes ?? null, p.triggeredByPages ?? null,
       item.consensus ?? null]
    );
    await insertObservations(client, scanId, 'scan_api', rows[0].id, item.observations);
    n++;
  }
  return n;
}

export async function loadPages(client, scanId, items) {
  let n = 0;
  for (const item of items) {
    const p = item.primary ?? {};
    const { rows } = await client.query(
      `INSERT INTO scan_page (id, scan_id, url, requested_urls, title, lang, section,
         nav_status, phase, visited, form_count, clickable_count, iframe_count,
         image_count, headings, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb)
       ON CONFLICT (scan_id, md5(url)) DO UPDATE SET
         title = EXCLUDED.title, form_count = EXCLUDED.form_count,
         nav_status = EXCLUDED.nav_status, clickable_count = EXCLUDED.clickable_count
       RETURNING id`,
      [randomUUID(), scanId, p.url,
       fromFields(item, 'requestedUrl') ? [fromFields(item, 'requestedUrl')] : null,
       p.title ?? null, p.lang ?? null, fromFields(item, 'section'),
       fromFields(item, 'navStatus'), fromFields(item, 'phase'),
       fromFields(item, 'visited'), p.formCount ?? null,
       fromFields(item, 'clickableCount'), fromFields(item, 'iframeCount'),
       fromFields(item, 'imageCount'), jb(fromFields(item, 'headings')),
       jb(fromFields(item, 'meta'))]
    );
    await insertObservations(client, scanId, 'scan_page', rows[0].id, item.observations);
    n++;
  }
  return n;
}

export async function loadRoutes(client, scanId, items) {
  let n = 0;
  for (const item of items) {
    const p = item.primary ?? {};
    const { rows } = await client.query(
      `INSERT INTO scan_route (id, scan_id, path, frameworks, component, auth_required)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (scan_id, path) DO UPDATE SET
         frameworks = EXCLUDED.frameworks, auth_required = EXCLUDED.auth_required
       RETURNING id`,
      [randomUUID(), scanId, p.path, p.frameworks ?? null, p.component ?? null,
       p.authRequired ?? null]
    );
    await insertObservations(client, scanId, 'scan_route', rows[0].id, item.observations);
    n++;
  }
  return n;
}

export async function loadInteractions(client, scanId, items) {
  let n = 0;
  for (const item of items) {
    const p = item.primary ?? {};
    const intent = fromFields(item, 'intent');
    const { rows } = await client.query(
      `INSERT INTO scan_interaction (id, scan_id, natural_key, from_page, to_page, kind,
         element_text, element_selector, element_tag, intent, api_call_hint,
         navigates_to_path, is_destructive)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13)
       ON CONFLICT (scan_id, natural_key) DO UPDATE SET
         to_page = EXCLUDED.to_page, intent = EXCLUDED.intent,
         is_destructive = EXCLUDED.is_destructive
       RETURNING id`,
      [randomUUID(), scanId, item.id, p.fromPage ?? null, p.toPage ?? null,
       p.kind ?? null, p.elementText ?? null, fromFields(item, 'elementSelector'),
       fromFields(item, 'elementTag'),
       jb(typeof intent === 'string' ? { intent } : intent),
       fromFields(item, 'apiCallHint'), fromFields(item, 'navigatesToPath'),
       fromFields(item, 'isDestructive')]
    );
    await insertObservations(client, scanId, 'scan_interaction', rows[0].id, item.observations);
    n++;
  }
  return n;
}

export async function loadRedirects(client, scanId, items) {
  let n = 0;
  for (const item of items) {
    const p = item.primary ?? {};
    await client.query(
      `INSERT INTO scan_redirect (id, scan_id, from_url, to_url, kind, status)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (scan_id, kind, md5(from_url), md5(to_url))
       DO UPDATE SET status = EXCLUDED.status`,
      [randomUUID(), scanId, p.from, p.to, p.kind, p.status ?? null]
    );
    n++;
  }
  return n;
}

export async function loadModels(client, scanId, items) {
  let n = 0;
  for (const item of items) {
    const p = item.primary ?? {};
    const { rows } = await client.query(
      `INSERT INTO scan_model (id, scan_id, name, kind, source_file, fields, bases)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
       ON CONFLICT (scan_id, name, source_file) DO UPDATE SET
         kind = EXCLUDED.kind, fields = EXCLUDED.fields
       RETURNING id`,
      [randomUUID(), scanId, p.name, p.kind ?? null, p.sourceFile ?? 'unknown',
       jb(p.fields), p.bases ?? null]
    );
    await insertObservations(client, scanId, 'scan_model', rows[0].id, item.observations);
    n++;
  }
  return n;
}

export async function loadDbSchema(client, scanId, items) {
  let n = 0;
  for (const item of items) {
    const p = item.primary ?? {};
    const { rows } = await client.query(
      `INSERT INTO scan_db_table (id, scan_id, table_name, class_name, source_file,
         framework, pk_columns, fk, relationships)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)
       ON CONFLICT (scan_id, table_name) DO UPDATE SET
         class_name = EXCLUDED.class_name, fk = EXCLUDED.fk
       RETURNING id`,
      [randomUUID(), scanId, p.table ?? item.id, p.className ?? null,
       p.sourceFile ?? null, p.framework ?? null, p.primaryKeyColumns ?? null,
       jb(p.foreignKeys), jb(p.relationships)]
    );
    const tableId = rows[0].id;
    for (const col of p.columns ?? []) {
      await client.query(
        `INSERT INTO scan_db_column (id, table_id, name, column_type, primary_key,
           nullable, is_unique, indexed, foreign_keys, autoincrement)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
         ON CONFLICT (table_id, name) DO UPDATE SET column_type = EXCLUDED.column_type`,
        [randomUUID(), tableId, col.name, col.type ?? col.columnType ?? null,
         col.primaryKey ?? null, col.nullable ?? null,
         col.unique ?? col.isUnique ?? null, col.indexed ?? null,
         jb(col.foreignKeys), col.autoincrement ?? null]
      );
    }
    await insertObservations(client, scanId, 'scan_db_table', tableId, item.observations);
    n++;
  }
  return n;
}

export async function loadDependencies(client, scanId, items) {
  let n = 0;
  for (const item of items) {
    const p = item.primary ?? {};
    await client.query(
      `INSERT INTO scan_dependency (id, scan_id, name, ecosystem, version, kind)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (scan_id, ecosystem, name) DO UPDATE SET version = EXCLUDED.version`,
      [randomUUID(), scanId, p.name, p.ecosystem, p.version ?? null, p.kind ?? null]
    );
    n++;
  }
  return n;
}

export async function loadFormFields(client, scanId, items) {
  let n = 0;
  for (const item of items) {
    const p = item.primary ?? {};
    const fieldType = p.fieldType ?? null;
    const autocomplete = fromFields(item, 'autocomplete');
    const secret =
      fieldType === 'password' ||
      ['current-password', 'new-password', 'one-time-code'].includes(autocomplete ?? '');
    const { rows } = await client.query(
      `INSERT INTO scan_form_field (id, scan_id, natural_key, page, form_id, form_action,
         form_method, form_intent, field_name, field_type, required, placeholder,
         default_value, autocomplete)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (scan_id, natural_key) DO UPDATE SET
         required = EXCLUDED.required, placeholder = EXCLUDED.placeholder
       RETURNING id`,
      [randomUUID(), scanId, item.id, p.page ?? null, fromFields(item, 'formId'),
       fromFields(item, 'formAction'), fromFields(item, 'formMethod'),
       p.formIntent ?? null, p.fieldName ?? null, fieldType,
       fromFields(item, 'required'), secret ? null : fromFields(item, 'placeholder'),
       secret ? null : fromFields(item, 'defaultValue'), autocomplete]
    );
    await insertObservations(client, scanId, 'scan_form_field', rows[0].id, item.observations);
    n++;
  }
  return n;
}

// Full-fidelity envelope per topic (items included), for anything the typed
// tables don't carry.
export async function loadIndexedTopic(client, scanId, topic, envelope) {
  await client.query(
    `INSERT INTO indexed_topic (id, scan_id, topic, item_count, sources_contributing, payload)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb)
     ON CONFLICT (scan_id, topic) DO UPDATE SET
       item_count = EXCLUDED.item_count, payload = EXCLUDED.payload`,
    [randomUUID(), scanId, topic, envelope.itemCount ?? envelope.items?.length ?? 0,
     envelope.sourcesContributing ?? null, JSON.stringify(envelope)]
  );
}
