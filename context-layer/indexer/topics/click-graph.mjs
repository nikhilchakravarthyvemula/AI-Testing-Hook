// Topic: click-graph — intent-driven graph of pages, routes, intents,
// forms, and APIs.
//
// Inputs (every available source is folded in — nothing gets dropped):
//   * sources.crawler.facts.pages[]            page + clickables + forms + triggeredApis
//   * sources.crawler.facts.endpoints[]        live-observed APIs
//   * sources.crawler.facts.clickGraph         page→page transitions (if BFS recorded them)
//   * sources.codeExtractors[*].endpoints[]    backend-declared APIs (python-fastapi, etc.)
//   * sources.codeExtractors[*].routes[]       frontend-declared routes (nextjs-app, react-router, etc.)
//
// Output shape — seven node types, nine edge kinds:
//   nodes: { pages, routes, intents, forms, apis, states, controls }
//     state   = in-page change (modal/dropdown/tab) the walker observed
//     control = editable input / select / toggle / expander (with selector)
//   edges with `relation` ∈ { contains, contains-form, has-control, triggers,
//                             navigates_to, state, invokes, submits_to, realizes }
//
// Dedup rules:
//   * page    keyed by absolute URL (pathname+search collapsed, host preserved)
//   * route   keyed by `<framework>:<pattern>`
//   * intent  keyed by `<category>:<intent>` (so the same logical action across N
//             pages becomes ONE node with N incoming edges)
//   * form    keyed by `<page-url>#form-<idx>` (forms rarely repeat across pages)
//   * api     keyed by `<METHOD>:<path>`, union of code-declared + live-observed
//
// All edges must reference an existing node id. We synthesize "visited:false"
// placeholder page nodes for destinations the crawler never reached so that
// navigates_to edges don't dangle.

import { indexedItem, observation } from '../lib/models.mjs';

export const topicName = 'click-graph';


/** @param {import('../lib/sources.mjs').LoadedSources} sources */
export function build(sources) {
  const ctx = _makeCtx(sources);

  _addCrawledPages(ctx, sources);
  _addDeclaredRoutes(ctx, sources);
  _addAllApis(ctx, sources);
  _absorbClickablesAndForms(ctx, sources);
  _absorbInteractables(ctx, sources);
  _addLiveTriggeredApiEdges(ctx, sources);
  _addLiveClickGraphEdges(ctx, sources);

  const graph = {
    nodes: {
      pages:    [...ctx.pages.values()],
      routes:   [...ctx.routes.values()],
      intents:  [...ctx.intents.values()].sort((a, b) => b.occurrenceCount - a.occurrenceCount),
      forms:    [...ctx.forms.values()],
      apis:     [...ctx.apis.values()],
      states:   [...ctx.states.values()],
      controls: [...ctx.controls.values()],
    },
    edges: ctx.edges,
    summary: {
      pages:    ctx.pages.size,
      routes:   ctx.routes.size,
      intents:  ctx.intents.size,
      forms:    ctx.forms.size,
      apis:     ctx.apis.size,
      states:   ctx.states.size,
      controls: ctx.controls.size,
      edges:    ctx.edges.length,
      visitedPages:    [...ctx.pages.values()].filter(p =>  p.visited).length,
      unvisitedPages:  [...ctx.pages.values()].filter(p => !p.visited).length,
      apisWithCallers: [...ctx.apis.values()].filter(a => a.callerCount > 0).length,
    },
  };

  // Source attribution for the index summary's `sourcesContributing` line.
  const contributing = new Set();
  if (sources.crawler) contributing.add('crawler');
  for (const id of Object.keys(sources.codeExtractors)) {
    const b = sources.codeExtractors[id];
    if ((b.endpoints ?? []).length > 0 || (b.routes ?? []).length > 0) {
      contributing.add(id);
    }
  }
  const observations = [...contributing].map(sourceId => observation({
    sourceId,
    discoveryTier: sourceId === 'crawler' ? 'live_observed' : 'ast',
    fields: { contributedTo: 'click-graph' },
  }));

  return [indexedItem(topicName, 'click-graph', graph, observations)];
}


// ── builder context ────────────────────────────────────────────────────────


function _makeCtx(sources) {
  return {
    pages:    new Map(),   // key=absolute URL → page node
    routes:   new Map(),   // key=`${framework}:${pattern}` → route node
    intents:  new Map(),   // key=`${category}:${intent}` → intent node
    forms:    new Map(),   // key=`${pageUrl}#form-${idx}` → form node
    apis:     new Map(),   // key=`${METHOD}:${path}` → api node
    states:   new Map(),   // key=`state:${url}#${key}` → state-change node (modal/dropdown/tab)
    controls: new Map(),   // key=`control:${url}#${sel}` → edit/toggle/expand interactable
    edges:    [],

    // Base URL for resolving relative destination paths to absolute URLs.
    // Falls back to the first crawled page's origin if no target is set.
    baseUrl: _detectBaseUrl(sources),
    sources,
  };
}


function _detectBaseUrl(sources) {
  const fromTarget = sources.crawler?.target?.baseUrl;
  if (fromTarget) return _stripTrailingSlash(fromTarget);
  const firstPage = sources.crawler?.facts?.pages?.[0];
  const u = firstPage?.finalUrl || firstPage?.requestedUrl;
  if (u) {
    try { return new URL(u).origin; } catch { /* ignore */ }
  }
  return null;
}


// ── node builders ──────────────────────────────────────────────────────────


function _addCrawledPages(ctx, sources) {
  for (const page of sources.crawler?.facts?.pages ?? []) {
    const url = _absoluteUrl(page.finalUrl || page.requestedUrl, ctx.baseUrl);
    if (!url) continue;
    _ensurePage(ctx, url, {
      title: page.title ?? null,
      section: page.section ?? null,
      visited: true,
    });
  }
}


function _addDeclaredRoutes(ctx, sources) {
  for (const [extractorId, bundle] of Object.entries(sources.codeExtractors)) {
    const framework = bundle.extractor ?? extractorId;
    for (const r of bundle.routes ?? []) {
      const pattern = r.pattern ?? r.path ?? r.route ?? null;
      if (!pattern) continue;
      const id = `route:${framework}:${pattern}`;
      if (ctx.routes.has(id)) continue;
      ctx.routes.set(id, {
        id,
        pattern,
        framework,
        file: r.file ?? r.sourceFile ?? null,
        component: r.component ?? null,
      });
      // If the route pattern doesn't contain a parameter, also realize it as
      // a synthetic page node (so it shows up even if the crawler didn't visit).
      if (ctx.baseUrl && !/[{:*]/.test(pattern)) {
        const url = _absoluteUrl(pattern, ctx.baseUrl);
        if (url) {
          const pageId = _ensurePage(ctx, url, { visited: false });
          ctx.edges.push({ from: id, to: pageId, relation: 'realizes' });
        }
      }
    }
  }
}


function _addAllApis(ctx, sources) {
  // Live-observed (crawler) — only API-shaped endpoints (skip text/html navigations).
  for (const e of sources.crawler?.facts?.endpoints ?? []) {
    if (e.isApi === false) continue;
    _ensureApi(ctx, e.method, e.path, {
      observedBy: ['crawler'],
      samples: e.samples ?? 1,
      statusCounts: e.statusCounts ?? {},
    });
  }
  // Code-declared (every code-extractor with endpoints).
  for (const [extractorId, bundle] of Object.entries(sources.codeExtractors)) {
    for (const e of bundle.endpoints ?? []) {
      _ensureApi(ctx, e.method, e.path, {
        framework: e.framework ?? extractorId,
        handler: e.handler ?? null,
        observedBy: [extractorId],
        operationId: e.operationId ?? null,
      });
    }
  }
}


function _absorbClickablesAndForms(ctx, sources) {
  for (const page of sources.crawler?.facts?.pages ?? []) {
    const pageUrl = _absoluteUrl(page.finalUrl || page.requestedUrl, ctx.baseUrl);
    if (!pageUrl) continue;
    const pageId = `page:${pageUrl}`;

    // Buttons + links (carry LLM intent annotations from Part B of the crawler).
    for (const btn of page.clickables?.buttons ?? []) {
      _absorbOneClickable(ctx, pageId, pageUrl, btn, 'button');
    }
    for (const lnk of page.clickables?.links ?? []) {
      _absorbOneClickable(ctx, pageId, pageUrl, lnk, 'link');
    }

    // Forms — every form gets a node + a contains-form edge from the page.
    const forms = Array.isArray(page.forms) ? page.forms : [];
    forms.forEach((form, idx) => {
      const formId = `form:${pageUrl}#${idx}`;
      const action = form.action ? _absoluteUrl(form.action, pageUrl) : null;
      ctx.forms.set(formId, {
        id: formId,
        page: pageUrl,
        method: (form.method ?? 'POST').toUpperCase(),
        action,
        fields: Array.isArray(form.fields)
          ? form.fields.map(f => ({ name: f.name ?? null, type: f.type ?? null }))
          : [],
        purpose: form.purpose ?? null,
      });
      ctx.edges.push({ from: pageId, to: formId, relation: 'contains-form' });

      // form → api  (submit target)
      if (action && form.method) {
        const apiId = _ensureApi(ctx, form.method, _pathOf(action) ?? action, {
          observedBy: ['crawler-form'],
        });
        if (apiId) ctx.edges.push({ from: formId, to: apiId, relation: 'submits_to' });
      }
    });
  }
}


function _absorbOneClickable(ctx, pageId, pageUrl, clickable, kind) {
  const intent = clickable.intent;
  if (!intent || !intent.intent) return;   // un-annotated — skip in graph

  const intentId = `intent:${intent.category}:${intent.intent}`;
  if (!ctx.intents.has(intentId)) {
    ctx.intents.set(intentId, {
      id: intentId,
      intent: intent.intent,
      category: intent.category,
      destructive: !!intent.destructive,
      safeToClick: intent.safeToClick !== false,
      humanLabel: intent.humanLabel || intent.intent,
      expectedApiCall: intent.expectedApiCall ?? null,
      expectedDestination: intent.expectedDestination ?? null,
      occurrenceCount: 0,
    });
  }
  const node = ctx.intents.get(intentId);
  node.occurrenceCount += 1;
  if (intent.expectedApiCall && !node.expectedApiCall) node.expectedApiCall = intent.expectedApiCall;
  if (intent.expectedDestination && !node.expectedDestination) node.expectedDestination = intent.expectedDestination;

  // page → intent
  ctx.edges.push({
    from: pageId,
    to: intentId,
    via: kind,
    relation: 'contains',
    selector: clickable.selector ?? null,
    text: clickable.text ?? null,
    href: clickable.href ?? null,
  });

  // intent → page (navigation target)
  if (intent.expectedDestination) {
    const destUrl = _absoluteUrl(intent.expectedDestination, pageUrl) ??
                    _absoluteUrl(intent.expectedDestination, ctx.baseUrl);
    if (destUrl) {
      const destPageId = _ensurePage(ctx, destUrl, { visited: false });
      ctx.edges.push({ from: intentId, to: destPageId, relation: 'navigates_to' });
    }
  }

  // intent → api (LLM-predicted call) — use loose match to bridge {id}/:id/etc.
  if (intent.expectedApiCall) {
    const parsed = _parseExpectedApiCall(intent.expectedApiCall);
    if (parsed) {
      const matchedKey = _findApiKey(ctx, parsed.method, parsed.path);
      if (matchedKey) {
        ctx.apis.get(matchedKey).callerCount += 1;
        ctx.edges.push({ from: intentId, to: matchedKey, relation: 'invokes' });
      }
    }
  }
}


function _addLiveTriggeredApiEdges(ctx, sources) {
  // The crawler records `page.triggeredApis[]` — actual network calls that
  // fired while the page was loaded. This is the strongest "page → api" signal
  // we have; the LLM intent-extract only catches click-driven calls.
  //
  // Each entry is a STRING like "GET http://localhost:8000/app/v1/users".
  // We extract method + path (origin is dropped — APIs are keyed by path,
  // matching how code-extractors record them).
  for (const page of sources.crawler?.facts?.pages ?? []) {
    const pageUrl = _absoluteUrl(page.finalUrl || page.requestedUrl, ctx.baseUrl);
    if (!pageUrl) continue;
    const pageId = `page:${pageUrl}`;
    const seen = new Set();
    for (const entry of page.triggeredApis ?? []) {
      const parsed = _parseTriggeredApi(entry);
      if (!parsed) continue;
      const dedupKey = `${parsed.method}:${parsed.path}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      // Loose-match against existing APIs first; only create a new node if
      // nothing matches (so {id} declared paths absorb concrete /123 paths).
      const matchedKey = _findApiKey(ctx, parsed.method, parsed.path) ??
                         _ensureApi(ctx, parsed.method, parsed.path, { observedBy: ['crawler-live'] });
      if (matchedKey) {
        ctx.apis.get(matchedKey).callerCount += 1;
        ctx.edges.push({ from: pageId, to: matchedKey, relation: 'triggers' });
      }
    }
  }
}


function _parseTriggeredApi(entry) {
  // Accepts either an object {method, url|path} or a string "GET <url-or-path>".
  if (entry && typeof entry === 'object') {
    const method = (entry.method ?? 'GET').toUpperCase();
    const apiPath = entry.path ?? (entry.url ? _pathOf(entry.url) ?? entry.url : null);
    return apiPath ? { method, path: apiPath } : null;
  }
  if (typeof entry !== 'string') return null;
  const m = entry.trim().match(/^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+(\S+)/i);
  if (!m) return null;
  const method = m[1].toUpperCase();
  const target = m[2];
  // Strip origin if absolute; keep path+query.
  const apiPath = /^https?:\/\//i.test(target) ? (_pathOf(target) ?? target) : target;
  return { method, path: apiPath };
}


function _addLiveClickGraphEdges(ctx, sources) {
  // The walker records every interaction as an edge:
  //   { from, to, button, key, hadNav, kind: 'nav' | 'state', ... }
  // NAV edges are page→page transitions (`to` is a URL). STATE edges are
  // in-page changes — modal/dropdown/tab opens — where `to` is `url#key`
  // (NOT a real page). We must branch: nav → navigates_to (page→page),
  // state → a dedicated state node + a `state` edge. Treating state edges
  // as navigations (the old behaviour) fabricated bogus `url#sel:…` pages.
  const edges = sources.crawler?.facts?.clickGraph?.edges ?? [];
  for (const e of edges) {
    const from = _absoluteUrl(e.from ?? e.fromUrl, ctx.baseUrl);
    if (!from) continue;
    const fromId = _ensurePage(ctx, from, { visited: true });
    const isNav = e.kind ? e.kind === 'nav' : e.hadNav === true;

    if (isNav) {
      const to = _absoluteUrl(e.to ?? e.toUrl, ctx.baseUrl);
      if (!to) continue;
      const toId = _ensurePage(ctx, to, { visited: false });
      ctx.edges.push({
        from: fromId, to: toId, relation: 'navigates_to', via: 'click',
        label: e.button ?? null, selector: _selectorOf(e.key),
      });
    } else {
      // In-page state change → state node keyed by the raw `to` (`url#key`).
      const rawTo = e.to ?? e.toUrl;
      if (!rawTo) continue;
      const stateId = `state:${rawTo}`;
      if (!ctx.states.has(stateId)) {
        ctx.states.set(stateId, {
          id: stateId,
          page: from,
          label: e.button || '(state change)',
          key: e.key ?? null,
          selector: _selectorOf(e.key),
          triggeredBy: e.originalKind ?? 'click',
        });
      }
      ctx.edges.push({
        from: fromId, to: stateId, relation: 'state', via: 'click',
        label: e.button ?? null, selector: _selectorOf(e.key),
      });
    }
  }
}


function _absorbInteractables(ctx, sources) {
  // Editable inputs / selects / toggles / expanders the walker recorded per
  // page (`facts.clickGraph.interactables = { url: [items] }`). Each item is
  // `{ kind: 'edit'|'toggle'|'expand', tag, role, label, name, placeholder,
  //    inputType, testid, idAttr, selector }`. These are the form-field /
  // control selectors a test generator needs but that aren't nav/click — so
  // we surface them as `control` nodes with a `has-control` edge from the page.
  const byUrl = sources.crawler?.facts?.clickGraph?.interactables ?? {};
  for (const [rawUrl, items] of Object.entries(byUrl)) {
    const pageUrl = _absoluteUrl(rawUrl, ctx.baseUrl);
    if (!pageUrl || !Array.isArray(items)) continue;
    const pageId = _ensurePage(ctx, pageUrl, { visited: true });
    items.forEach((it, idx) => {
      const sel = it.selector || it.testid || it.idAttr || it.label || `idx-${idx}`;
      const id = `control:${pageUrl}#${sel}`;
      if (ctx.controls.has(id)) return;
      ctx.controls.set(id, {
        id,
        page: pageUrl,
        controlKind: it.kind ?? 'edit',       // edit | toggle | expand
        tag: it.tag ?? null,
        role: it.role ?? null,
        label: it.label ?? it.name ?? it.placeholder ?? null,
        name: it.name ?? null,
        inputType: it.inputType ?? null,
        selector: it.selector ?? null,
      });
      ctx.edges.push({ from: pageId, to: id, relation: 'has-control', via: it.kind ?? 'edit' });
    });
  }
}


// Pull the raw CSS selector out of a walker stable-key (`sel:<css>`); other
// key kinds (`id:`, `testid:`, `href:`, `label:`) aren't CSS selectors.
function _selectorOf(key) {
  if (typeof key !== 'string') return null;
  return key.startsWith('sel:') ? key.slice(4) : null;
}


// ── ensure helpers ─────────────────────────────────────────────────────────


function _ensurePage(ctx, absoluteUrl, fields) {
  const id = `page:${absoluteUrl}`;
  if (ctx.pages.has(absoluteUrl)) {
    // Upgrade visited: false → true if a later source proves we got there.
    const existing = ctx.pages.get(absoluteUrl);
    if (fields.visited) existing.visited = true;
    if (fields.title && !existing.title) existing.title = fields.title;
    if (fields.section && !existing.section) existing.section = fields.section;
    return id;
  }
  ctx.pages.set(absoluteUrl, {
    id,
    url: absoluteUrl,
    title: fields.title ?? null,
    section: fields.section ?? null,
    visited: !!fields.visited,
  });
  return id;
}


function _ensureApi(ctx, method, apiPath, fields) {
  if (!method || !apiPath) return null;
  const m = String(method).toUpperCase();
  const id = `api:${m}:${apiPath}`;
  if (!ctx.apis.has(id)) {
    ctx.apis.set(id, {
      id,
      method: m,
      path: apiPath,
      framework: fields.framework ?? null,
      handler: fields.handler ?? null,
      operationId: fields.operationId ?? null,
      samples: fields.samples ?? 0,
      statusCounts: fields.statusCounts ?? {},
      observedBy: [...new Set(fields.observedBy ?? [])],
      callerCount: 0,
    });
  } else {
    // Merge — keep first non-null framework/handler, accumulate observedBy.
    const existing = ctx.apis.get(id);
    if (fields.framework && !existing.framework) existing.framework = fields.framework;
    if (fields.handler && !existing.handler) existing.handler = fields.handler;
    for (const tag of fields.observedBy ?? []) {
      if (!existing.observedBy.includes(tag)) existing.observedBy.push(tag);
    }
    if (fields.samples) existing.samples = (existing.samples ?? 0) + fields.samples;
  }
  return id;
}


// ── URL + match utilities ──────────────────────────────────────────────────


function _absoluteUrl(input, base) {
  if (!input) return null;
  const s = String(input).trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return _stripTrailingSlash(s);
  if (!base) return null;
  try {
    return _stripTrailingSlash(new URL(s, base).toString());
  } catch {
    return null;
  }
}


function _pathOf(url) {
  try {
    const u = new URL(url);
    return u.pathname + (u.search || '');
  } catch {
    return null;
  }
}


function _stripTrailingSlash(s) {
  if (s.length > 1 && s.endsWith('/')) return s.slice(0, -1);
  return s;
}


function _parseExpectedApiCall(s) {
  if (typeof s !== 'string') return null;
  const m = s.trim().match(/^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+(\S+)/i);
  if (!m) return null;
  return { method: m[1].toUpperCase(), path: m[2] };
}


function _findApiKey(ctx, method, wantPath) {
  // Exact match first.
  const exactKey = `api:${method}:${wantPath}`;
  if (ctx.apis.has(exactKey)) return exactKey;

  // Loose match: collapse path-params on both sides and compare.
  const wantPattern = _collapseParams(wantPath);
  for (const key of ctx.apis.keys()) {
    if (!key.startsWith(`api:${method}:`)) continue;
    const havePath = key.slice(`api:${method}:`.length);
    if (_collapseParams(havePath) === wantPattern) return key;
  }
  return null;
}


function _collapseParams(p) {
  return p
    .replace(/\{[^}]+\}/g, '*')   // {id}  → *
    .replace(/:[a-zA-Z_]+/g, '*') // :id   → *
    .replace(/\/$/, '');
}
