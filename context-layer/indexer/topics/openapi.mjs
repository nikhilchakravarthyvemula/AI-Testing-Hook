// Topic: openapi — live-served API spec parsed by the openapi-probe.
//
// One IndexedItem per endpoint. Carries the full resolved request schema,
// per-status response schemas, security, parameters — everything the
// generator needs to build a real body and assert the response.
//
// Source: sources.openapiSpec (output/openapi-probe/bundle.json).
//
// Consumers:
//   * api-test-generator → request body synthesis from JSON Schema
//   * future doc-gen     → real schemas + examples in docs
//   * future fuzzer      → schema-aware fuzzing

import { indexedItem, observation } from '../lib/models.mjs';

export const topicName = 'openapi';


/** @param {import('../lib/sources.mjs').LoadedSources} sources */
export function build(sources) {
  const bundle = sources.openapiSpec;
  if (!bundle) return [];

  const items = [];
  for (const ep of bundle.facts?.endpoints ?? []) {
    const id = `${ep.method}:${ep.path}`;
    const primary = {
      id,
      method: ep.method,
      path: ep.path,
      origin: ep.origin ?? null,
      operationId: ep.operationId ?? null,
      summary: ep.summary ?? null,
      tags: ep.tags ?? [],
      authRequired: !!ep.authRequired,
      requestContentType: ep.requestContentType ?? null,
      requestSchema: ep.requestSchema ?? null,
      requestExample: ep.requestExample ?? null,
      responseSchemas: ep.responseSchemas ?? {},
      parameters: ep.parameters ?? [],
      deprecated: !!ep.deprecated,
    };
    const obs = observation({
      sourceId: 'openapi-spec',
      discoveryTier: 'spec',
      fields: {
        description: ep.description ?? null,
        security: ep.security ?? [],
      },
    });
    items.push(indexedItem(topicName, id, primary, [obs]));
  }
  return items;
}
