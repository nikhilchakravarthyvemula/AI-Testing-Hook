// Topic: mock-data — real request/response samples observed by the crawler,
// distilled into per-endpoint records by the mock-data-extractor.
//
// Source: sources.mockData (output/mock-data/bundle.json).
//
// One IndexedItem per endpoint. The `primary` carries the canonical
// METHOD/path/origin + a count summary; each sample (request + response
// pair, or response-only) lives under `samples`.
//
// Consumers — anything that needs concrete payloads:
//   * api-test-generator   — body synthesis + login templates + response fixtures
//   * future UI test gen   — fixture data for filling forms
//   * future doc gen       — real example bodies in API docs

import { indexedItem, observation } from '../lib/models.mjs';

export const topicName = 'mock-data';


/** @param {import('../lib/sources.mjs').LoadedSources} sources */
export function build(sources) {
  const bundle = sources.mockData;
  if (!bundle) return [];

  const items = [];
  for (const ep of bundle.facts?.endpoints ?? []) {
    const id = `${ep.method}:${ep.path}`;
    const primary = {
      id,
      method: ep.method,
      path: ep.path,
      origin: ep.origin ?? null,
      contentTypes: ep.contentTypes ?? {},
      statusCounts: ep.statusCounts ?? {},
      sampleCount: ep.sampleCount ?? { request: 0, response: 0 },
      samples: ep.samples ?? [],
      // Convenience: surface the first 200 response body at the top, since
      // it's the most-used field. (Consumers can still scan `samples` if
      // they want non-200s or want all of them.)
      firstSuccessResponseBody: _firstSuccessBody(ep.samples ?? []),
      firstRequestBody: _firstRequestBody(ep.samples ?? []),
    };
    const obs = observation({
      sourceId: 'mock-data',
      discoveryTier: 'live_observed',
      fields: {
        sampleRequestHeaders: ep.sampleRequestHeaders ?? {},
        sampleResponseHeaders: ep.sampleResponseHeaders ?? {},
      },
    });
    items.push(indexedItem(topicName, id, primary, [obs]));
  }
  return items;
}


function _firstSuccessBody(samples) {
  for (const s of samples) {
    if (s.response?.body != null && s.status && s.status < 400) return s.response.body;
  }
  return null;
}


function _firstRequestBody(samples) {
  for (const s of samples) {
    if (s.request?.body != null) return s.request.body;
  }
  return null;
}
