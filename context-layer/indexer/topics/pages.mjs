// Topic: pages — actual pages discovered live by the crawler.
//
// Each item carries the rich page snapshot the crawler captured:
// clickables, forms, headings, console messages, failed requests.
// This is what the test-generator + test-data topics build on.
//
// Sources: crawler only. (Frontend declarations live under `routes`.)
// Dedup key: finalUrl (post-redirect URL).

import { indexedItem, observation } from '../lib/models.mjs';


/** @param {import('../lib/sources.mjs').LoadedSources} sources */
export function build(sources) {
  const pages = sources.crawler?.facts?.pages ?? [];
  if (!pages.length) return [];

  /** @type {Map<string, {primary: Object, observations: import('../lib/models.mjs').Observation[]}>} */
  const byKey = new Map();
  for (const page of pages) {
    const url = page.finalUrl || page.requestedUrl;
    if (!url) continue;
    const key = _stripQuery(url);

    const fields = {
      finalUrl: page.finalUrl,
      requestedUrl: page.requestedUrl,
      navStatus: page.navStatus,
      phase: page.phase,
      lang: page.lang,
      title: page.dom?.title,
      headings: page.headings,
      meta: page.meta,
      clickableCount: page.clickables?.length ?? 0,
      formCount: page.forms?.length ?? 0,
      iframeCount: page.iframes?.length ?? 0,
      imageCount: page.images?.length ?? 0,
      actionsTaken: page.actions ?? [],
      failedRequests: page.failedRequests ?? [],
      consoleMessages: (page.consoleMessages ?? []).slice(0, 10), // cap noise
      // Embed the rich nested data so consumers don't need to read
      // crawler/data/pages.json directly:
      clickables: page.clickables ?? [],
      forms: page.forms ?? [],
    };

    const bucket = byKey.get(key) ?? { primary: { url: key, title: null }, observations: [] };
    bucket.primary.url = key;
    bucket.primary.title ??= fields.title;
    bucket.primary.lang ??= fields.lang;
    bucket.primary.formCount = (bucket.primary.formCount ?? 0) + fields.formCount;
    bucket.observations.push(observation({
      sourceId: 'crawler',
      discoveryTier: 'live_observed',
      fields,
    }));
    byKey.set(key, bucket);
  }

  return [...byKey.entries()].map(([key, { primary, observations }]) =>
    indexedItem('pages', key, primary, observations)
  );
}


function _stripQuery(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}${u.hash}`;
  } catch {
    return String(url).split('?')[0];
  }
}
