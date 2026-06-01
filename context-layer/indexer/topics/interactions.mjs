// Topic: interactions — UI actions and what they trigger.
//
// Sources:
//   * crawler.facts.clickGraph.edges  — page→page transitions via click
//   * crawler.facts.pages[].clickables — every interactive element seen
//   * frontend code-extractor interactions[] — declared button/link intents
//
// Dedup key: `${fromPage}::${elementSignature}`.

import { indexedItem, observation } from '../lib/models.mjs';


const FRONTEND_SOURCES = new Set([
  'nextjs-app', 'nextjs-pages', 'react-router', 'vue-router',
  'angular-router', 'sveltekit', 'nuxt', 'remix', 'ember',
  'qwik', 'astro', 'preact-router', 'solidstart',
]);


/** @param {import('../lib/sources.mjs').LoadedSources} sources */
export function build(sources) {
  /** @type {Map<string, {primary: Object, observations: import('../lib/models.mjs').Observation[]}>} */
  const byKey = new Map();

  // ── crawler click-graph: page→page edges ──────────────────────────────
  const cg = sources.crawler?.facts?.clickGraph;
  for (const edge of cg?.edges ?? []) {
    const sig = _edgeSignature(edge);
    const key = `${edge.fromUrl}::${sig}`;
    _add(byKey, key, {
      fromPage: edge.fromUrl,
      toPage: edge.toUrl,
      elementSignature: sig,
      elementText: edge.text,
      elementSelector: edge.selector,
      kind: 'page-transition',
    }, { sourceId: 'crawler', discoveryTier: 'live_observed' });
  }

  // ── crawler clickables: every interactive element on each page ─────────
  //
  // Crawler shape: page.clickables is { buttons: [...], links: [...] },
  // NOT a flat array. Each kind has its own element shape (buttons have
  // selector/text/role; links have href/text/target). Iterate both
  // sub-arrays and tag the kind.
  for (const page of sources.crawler?.facts?.pages ?? []) {
    const pageUrl = page.finalUrl || page.requestedUrl;
    const clickables = page.clickables ?? {};

    for (const button of (Array.isArray(clickables.buttons) ? clickables.buttons : [])) {
      const sig = button.selector || button.text || JSON.stringify(button).slice(0, 50);
      const key = `${pageUrl}::button:${sig}`;
      _add(byKey, key, {
        fromPage: pageUrl,
        elementSignature: sig,
        elementText: button.text,
        elementTag: 'button',
        elementSelector: button.selector,
        kind: 'clickable-button',
      }, { sourceId: 'crawler', discoveryTier: 'live_observed' });
    }
    for (const link of (Array.isArray(clickables.links) ? clickables.links : [])) {
      const sig = link.selector || link.href || link.text || JSON.stringify(link).slice(0, 50);
      const key = `${pageUrl}::link:${sig}`;
      _add(byKey, key, {
        fromPage: pageUrl,
        toPage: link.href ?? null,
        elementSignature: sig,
        elementText: link.text,
        elementTag: 'a',
        elementSelector: link.selector,
        kind: 'clickable-link',
      }, { sourceId: 'crawler', discoveryTier: 'live_observed' });
    }
  }

  // ── frontend extractor interactions: declared intent ──────────────────
  for (const [id, bundle] of Object.entries(sources.codeExtractors)) {
    if (!FRONTEND_SOURCES.has(id)) continue;
    for (const inter of bundle.interactions ?? []) {
      const sig = inter.element_text || inter.intent || JSON.stringify(inter).slice(0, 50);
      const key = `declared:${id}::${sig}`;
      _add(byKey, key, {
        fromPage: inter.containing_route ?? null,
        elementSignature: sig,
        elementTag: inter.element_tag,
        intent: inter.intent,
        action: inter.action,
        apiCallHint: inter.api_call_hint,
        isDestructive: inter.is_destructive,
        navigatesToPath: inter.navigates_to_path,
        kind: 'declared',
      }, {
        sourceId: id, discoveryTier: 'ast',
        sourceFile: inter.provenance?.source_file ?? null,
      });
    }
  }

  return [...byKey.entries()].map(([key, { primary, observations }]) =>
    indexedItem('interactions', key, primary, observations)
  );
}


function _add(map, key, fields, { sourceId, discoveryTier, sourceFile }) {
  let bucket = map.get(key);
  if (!bucket) {
    bucket = {
      primary: {
        fromPage: fields.fromPage,
        toPage: fields.toPage ?? null,
        kind: fields.kind,
        elementText: fields.elementText ?? fields.intent ?? null,
      },
      observations: [],
    };
    map.set(key, bucket);
  }
  bucket.observations.push(observation({ sourceId, discoveryTier, sourceFile, fields }));
  bucket.primary.toPage ??= fields.toPage;
}

function _edgeSignature(edge) {
  return edge.selector || edge.text || `link-${edge.toUrl}`;
}
