// Topic: redirects — both server-side (3xx) and client-side (JS nav).
//
// Sources: crawler (serverRedirects[] + clientNavRedirects[]).
// Dedup key: `${from} → ${to}`.

import { indexedItem, observation } from '../lib/models.mjs';


/** @param {import('../lib/sources.mjs').LoadedSources} sources */
export function build(sources) {
  const out = [];
  const server = sources.crawler?.facts?.serverRedirects ?? [];
  const client = sources.crawler?.facts?.clientNavRedirects ?? [];

  for (const r of server) {
    out.push(_make({
      from: r.from, to: r.to,
      kind: 'server', status: r.status ?? null,
    }));
  }
  for (const r of client) {
    out.push(_make({
      from: r.from, to: r.to,
      kind: 'client', status: null,
    }));
  }
  return out;
}


function _make({ from, to, kind, status }) {
  const id = `${kind}:${from}→${to}`;
  return indexedItem(
    'redirects',
    id,
    { from, to, kind, status },
    [observation({
      sourceId: 'crawler',
      discoveryTier: 'live_observed',
      fields: { from, to, kind, status },
    })],
  );
}
