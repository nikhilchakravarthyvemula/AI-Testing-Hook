// Topic: routes — UI routes declared in frontend frameworks.
//
// Sources: every frontend code-extractor (nextjs-app, nextjs-pages,
// react-router, vue-router, angular-router, sveltekit, nuxt, remix,
// ember, qwik, astro, preact-router, solidstart).
//
// Crawler-discovered live pages live under `pages` topic, NOT here —
// `routes` is "what the code declares should exist".
//
// Dedup key: normalised path.

import { indexedItem, observation, provenanceOf } from '../lib/models.mjs';


const FRONTEND_SOURCES = new Set([
  'nextjs-app', 'nextjs-pages', 'react-router', 'vue-router',
  'angular-router', 'sveltekit', 'nuxt', 'remix', 'ember',
  'qwik', 'astro', 'preact-router', 'solidstart',
]);


/** @param {import('../lib/sources.mjs').LoadedSources} sources */
export function build(sources) {
  /** @type {Map<string, {primary: Object, observations: import('../lib/models.mjs').Observation[]}>} */
  const byKey = new Map();

  for (const [id, bundle] of Object.entries(sources.codeExtractors)) {
    if (!FRONTEND_SOURCES.has(id)) continue;
    if (!bundle.routes?.length) continue;
    for (const route of bundle.routes) {
      const p = _normalisePath(route.path);
      if (!p) continue;
      const fields = {
        path: p,
        component: route.component ?? null,
        dynamicParams: route.dynamic_params ?? [],
        layoutChain: route.layout_chain ?? [],
        metaDescription: route.meta_description ?? null,
        ogDescription: route.og_description ?? null,
        authRequired: route.auth_required ?? null,
        framework: id,
      };
      let bucket = byKey.get(p);
      if (!bucket) {
        bucket = { primary: { path: p, frameworks: [] }, observations: [] };
        byKey.set(p, bucket);
      }
      bucket.observations.push(observation({
        sourceId: id,
        discoveryTier: 'ast',
        ...provenanceOf(route),
        fields,
      }));
      // Track which frameworks declare each path (a route can appear in
      // pages-router AND app-router during migration).
      if (!bucket.primary.frameworks.includes(id)) {
        bucket.primary.frameworks.push(id);
      }
      bucket.primary.component ??= fields.component;
      bucket.primary.authRequired ??= fields.authRequired;
    }
  }

  return [...byKey.entries()].map(([key, { primary, observations }]) =>
    indexedItem('routes', key, primary, observations, (a, b) => a.fields?.path === b.fields?.path)
  );
}


function _normalisePath(p) {
  if (!p || typeof p !== 'string') return null;
  let s = p.replace(/\/{2,}/g, '/');
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}
