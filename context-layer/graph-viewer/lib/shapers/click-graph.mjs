// click-graph shaper — turns the indexed click-graph JSON into the
// {nodes, edges, meta} shape `render-html.mjs` knows how to draw.
//
// Five node types are rendered (each with a distinct shape + colour so the
// graph reads at a glance):
//
//   page    blue box        URL the crawler reached
//   page*   blue dashed     destination referenced but not crawled
//   route   purple box      frontend route declaration (Next.js / React Router / …)
//   intent  green ellipse   LLM-annotated user action (red if destructive)
//   form    yellow diamond  HTML form
//   api     orange diamond  HTTP endpoint (live + code-declared)
//   state   teal hexagon    in-page change (modal / dropdown / tab)
//   control magenta △/▢/▽   editable input / toggle / expander (Playwright selector)

const PALETTE = Object.freeze({
  pageVisited:   { background: '#4682b4', border: '#1f4d6e', highlight: { background: '#5a96c8', border: '#1f4d6e' } },
  pageUnvisited: { background: '#a8c5dc', border: '#4682b4', highlight: { background: '#bcd4e6', border: '#1f4d6e' } },
  route:         { background: '#7b68ee', border: '#3d3475', highlight: { background: '#9384ee', border: '#3d3475' } },
  intent:        { background: '#3cb371', border: '#1f6d44', highlight: { background: '#52c184', border: '#1f6d44' } },
  destructive:   { background: '#d9534f', border: '#8b2a26', highlight: { background: '#e07672', border: '#8b2a26' } },
  form:          { background: '#ffd964', border: '#a89139', highlight: { background: '#ffe592', border: '#a89139' } },
  api:           { background: '#f0ad4e', border: '#a76e1f', highlight: { background: '#f4be72', border: '#a76e1f' } },
  apiOrphan:     { background: '#f6d9b3', border: '#a76e1f', highlight: { background: '#fae3c5', border: '#a76e1f' } },
  state:         { background: '#20b2aa', border: '#0f5e5a', highlight: { background: '#3fc8c0', border: '#0f5e5a' } },
  control:       { background: '#e26fce', border: '#8a2d7e', highlight: { background: '#ec92db', border: '#8a2d7e' } },
});

// distinct symbol per control kind (vis-network shape names)
const CONTROL_SHAPE = Object.freeze({ edit: 'triangle', toggle: 'square', expand: 'triangleDown' });

const EDGE_STYLE = Object.freeze({
  contains:      { color: '#888888', dashes: false, width: 1 },
  'contains-form': { color: '#a89139', dashes: false, width: 1 },
  'has-control': { color: '#e26fce', dashes: false, width: 1 },
  navigates_to:  { color: '#4682b4', dashes: false, width: 2 },
  state:         { color: '#20b2aa', dashes: [2, 3], width: 1 },
  invokes:       { color: '#f0ad4e', dashes: false, width: 2 },
  triggers:      { color: '#cc8800', dashes: [4, 4], width: 1 },
  submits_to:    { color: '#a89139', dashes: false, width: 2 },
  realizes:      { color: '#7b68ee', dashes: [2, 4], width: 1 },
});

export const sourceFile = 'output/indexed_output/click-graph.json';
export const outputFile = 'click-graph.html';
export const title      = 'Click-Graph — pages × routes × intents × forms × APIs';


/**
 * @param {Object} bundle   the loaded click-graph.json bundle
 * @returns {{nodes: Array, edges: Array, meta: Object}}
 */
export function shape(bundle) {
  const graph = bundle.items?.[0]?.primary;
  if (!graph) {
    return { nodes: [], edges: [], meta: { empty: true, reason: 'no items[0].primary in bundle' } };
  }

  const nodes = [];
  const idToVisId = new Map();   // semantic id → numeric vis-network id

  const _assignId = (key) => {
    if (idToVisId.has(key)) return idToVisId.get(key);
    const id = idToVisId.size + 1;
    idToVisId.set(key, id);
    return id;
  };

  // ── pages (visited + unvisited) ───────────────────────────────────────
  for (const p of graph.nodes.pages ?? []) {
    const visited = p.visited !== false;
    nodes.push({
      id: _assignId(p.id),
      label: (visited ? '' : '↗ ') + _shortPath(p.url),
      title: _tooltipPage(p),
      group: visited ? 'page' : 'page-unvisited',
      color: visited ? PALETTE.pageVisited : PALETTE.pageUnvisited,
      shape: 'box',
      borderWidth: visited ? 2 : 1,
      shapeProperties: visited ? undefined : { borderDashes: [4, 4] },
      _kind: 'page', _raw: p,
    });
  }

  // ── routes (frontend declarations) ────────────────────────────────────
  for (const r of graph.nodes.routes ?? []) {
    nodes.push({
      id: _assignId(r.id),
      label: r.pattern,
      title: _tooltipRoute(r),
      group: 'route',
      color: PALETTE.route,
      shape: 'box',
      shapeProperties: { borderRadius: 12 },
      _kind: 'route', _raw: r,
    });
  }

  // ── intents (LLM-annotated clickables) ────────────────────────────────
  for (const i of graph.nodes.intents ?? []) {
    const isDestructive = !!i.destructive;
    nodes.push({
      id: _assignId(i.id),
      label: i.intent,
      title: _tooltipIntent(i),
      group: isDestructive ? 'intent-destructive' : 'intent',
      color: isDestructive ? PALETTE.destructive : PALETTE.intent,
      shape: 'ellipse',
      // Bigger circle for higher-occurrence intents — quick visual signal of "hot" actions.
      size: Math.min(45, 14 + (i.occurrenceCount ?? 1) * 1.2),
      _kind: 'intent', _raw: i,
    });
  }

  // ── forms ─────────────────────────────────────────────────────────────
  for (const f of graph.nodes.forms ?? []) {
    nodes.push({
      id: _assignId(f.id),
      label: `${f.method} form`,
      title: _tooltipForm(f),
      group: 'form',
      color: PALETTE.form,
      shape: 'diamond',
      size: 18,
      _kind: 'form', _raw: f,
    });
  }

  // ── apis ──────────────────────────────────────────────────────────────
  for (const a of graph.nodes.apis ?? []) {
    const orphan = (a.callerCount ?? 0) === 0;
    nodes.push({
      id: _assignId(a.id),
      label: `${a.method} ${_shortPath(a.path)}`,
      title: _tooltipApi(a),
      group: orphan ? 'api-orphan' : 'api',
      color: orphan ? PALETTE.apiOrphan : PALETTE.api,
      shape: 'diamond',
      size: orphan ? 14 : 18,
      _kind: 'api', _raw: a,
    });
  }

  // ── states (in-page changes: modal / dropdown / tab) ──────────────────
  for (const s of graph.nodes.states ?? []) {
    nodes.push({
      id: _assignId(s.id),
      label: _truncate(s.label || 'state', 22),
      title: _tooltipState(s),
      group: 'state',
      color: PALETTE.state,
      shape: 'hexagon',
      size: 13,
      _kind: 'state', _raw: s,
    });
  }

  // ── controls (editable inputs / toggles / expanders) ──────────────────
  for (const c of graph.nodes.controls ?? []) {
    nodes.push({
      id: _assignId(c.id),
      label: _truncate(c.label || c.controlKind || 'control', 20),
      title: _tooltipControl(c),
      group: `control-${c.controlKind || 'edit'}`,
      color: PALETTE.control,
      shape: CONTROL_SHAPE[c.controlKind] || 'triangle',
      size: 12,
      _kind: 'control', _raw: c,
    });
  }

  // ── edges ─────────────────────────────────────────────────────────────
  const edges = [];
  let dropped = 0;
  for (const e of graph.edges ?? []) {
    const fromId = idToVisId.get(e.from);
    const toId   = idToVisId.get(e.to);
    if (!fromId || !toId) { dropped++; continue; }  // dangling — node missing

    const relation = e.relation ?? (e.via ? 'contains' : 'related');
    const style = EDGE_STYLE[relation] ?? { color: '#aaa', dashes: false, width: 1 };
    edges.push({
      from: fromId,
      to: toId,
      label: relation === 'contains' && e.text ? _truncate(e.text, 30) : undefined,
      title: _tooltipEdge(e),
      arrows: 'to',
      color: { color: style.color, opacity: 0.65 },
      dashes: style.dashes,
      width: style.width,
      smooth: { type: 'dynamic' },
      _raw: e,
    });
  }

  const counts = graph.summary ?? {};
  const meta = {
    title: 'Click-Graph',
    subtitle: [
      `${counts.pages ?? 0} pages (${counts.visitedPages ?? 0} visited)`,
      `${counts.routes ?? 0} routes`,
      `${counts.intents ?? 0} intents`,
      `${counts.forms ?? 0} forms`,
      `${counts.apis ?? 0} APIs (${counts.apisWithCallers ?? 0} with callers)`,
      `${counts.states ?? 0} states`,
      `${counts.controls ?? 0} controls`,
      `${edges.length} edges`,
    ].join(' · '),
    generatedAt: bundle.generatedAt,
    target: bundle.target,
    counts: {
      pages: counts.pages ?? 0,
      visitedPages: counts.visitedPages ?? 0,
      routes: counts.routes ?? 0,
      intents: counts.intents ?? 0,
      forms: counts.forms ?? 0,
      apis: counts.apis ?? 0,
      apisWithCallers: counts.apisWithCallers ?? 0,
      states: counts.states ?? 0,
      controls: counts.controls ?? 0,
      edges: edges.length,
      droppedEdges: dropped,
    },
    // Each legend row carries the entity `kind` so render-html can render a
    // per-type filter toggle, a colour swatch, and a shape symbol.
    legend: [
      { kind: 'page',    color: PALETTE.pageVisited.background,   symbol: '▭', label: 'Page (crawled)' },
      { kind: 'page',    color: PALETTE.pageUnvisited.background, symbol: '▢', label: 'Page (referenced, not crawled)' },
      { kind: 'route',   color: PALETTE.route.background,         symbol: '▢', label: 'Frontend route declaration' },
      { kind: 'intent',  color: PALETTE.intent.background,        symbol: '⬭', label: 'Intent (safe)' },
      { kind: 'intent',  color: PALETTE.destructive.background,   symbol: '⬭', label: 'Intent (destructive)' },
      { kind: 'form',    color: PALETTE.form.background,          symbol: '◆', label: 'Form' },
      { kind: 'api',     color: PALETTE.api.background,           symbol: '◆', label: 'API (has callers)' },
      { kind: 'api',     color: PALETTE.apiOrphan.background,     symbol: '◇', label: 'API (no caller observed)' },
      { kind: 'state',   color: PALETTE.state.background,         symbol: '⬡', label: 'State change (modal/dropdown/tab)' },
      { kind: 'control', color: PALETTE.control.background,       symbol: '▲', label: 'Control: edit (△) · toggle (▢) · expand (▽)' },
    ],
  };
  return { nodes, edges, meta };
}


// ── tooltip HTML builders ──────────────────────────────────────────────────


function _tooltipPage(p) {
  return [
    `<b>Page</b>: ${_escape(p.url)}`,
    p.title    ? `<i>${_escape(p.title)}</i>` : null,
    p.section  ? `Section: ${_escape(p.section)}` : null,
    p.visited === false ? '<span style="color:#999">[referenced; not crawled]</span>' : null,
  ].filter(Boolean).join('<br/>');
}

function _tooltipRoute(r) {
  return [
    `<b>Route</b>: ${_escape(r.pattern)}`,
    r.framework ? `Framework: <b>${_escape(r.framework)}</b>` : null,
    r.component ? `Component: <code>${_escape(r.component)}</code>` : null,
    r.file ? `File: <code>${_escape(r.file)}</code>` : null,
  ].filter(Boolean).join('<br/>');
}

function _tooltipIntent(i) {
  return [
    `<b>Intent</b>: ${_escape(i.intent)}`,
    `Category: <b>${_escape(i.category)}</b>${i.destructive ? '  <span style="color:#d9534f">[destructive]</span>' : ''}`,
    i.humanLabel       ? _escape(i.humanLabel) : null,
    `Observed on <b>${i.occurrenceCount}</b> page(s)`,
    i.expectedApiCall  ? `API: <code>${_escape(i.expectedApiCall)}</code>` : null,
    i.expectedDestination ? `Destination: <code>${_escape(i.expectedDestination)}</code>` : null,
  ].filter(Boolean).join('<br/>');
}

function _tooltipForm(f) {
  const fieldLine = (f.fields ?? []).slice(0, 6)
    .map(x => x.name ? `${_escape(x.name)}${x.type ? `:${_escape(x.type)}` : ''}` : '?').join(', ');
  return [
    `<b>Form</b>: ${_escape(f.method)} ${f.action ? _escape(f.action) : '(no action)'}`,
    `Page: ${_escape(f.page)}`,
    fieldLine ? `Fields: ${fieldLine}${f.fields?.length > 6 ? ', …' : ''}` : null,
    f.purpose ? `Purpose: <b>${_escape(f.purpose)}</b>` : null,
  ].filter(Boolean).join('<br/>');
}

function _tooltipApi(a) {
  return [
    `<b>API</b>: ${_escape(a.method)} <code>${_escape(a.path)}</code>`,
    a.framework   ? `Framework: <b>${_escape(a.framework)}</b>` : null,
    a.operationId ? `Op: <code>${_escape(a.operationId)}</code>` : null,
    a.handler?.file && a.handler?.function
      ? `Handler: <code>${_escape(a.handler.function)}</code> @ ${_escape(a.handler.file)}` : null,
    a.observedBy?.length ? `Observed by: ${(a.observedBy ?? []).join(', ')}` : null,
    `Callers observed: <b>${a.callerCount ?? 0}</b>`,
    a.samples ? `Live samples: ${a.samples}` : null,
  ].filter(Boolean).join('<br/>');
}

function _tooltipState(s) {
  return [
    `<b>State change</b>: ${_escape(s.label || '(state)')}`,
    `On page: ${_escape(s.page)}`,
    s.triggeredBy ? `Triggered by: ${_escape(s.triggeredBy)}` : null,
    s.selector ? `Selector: <code>${_escape(s.selector)}</code>` : null,
  ].filter(Boolean).join('<br/>');
}

function _tooltipControl(c) {
  return [
    `<b>Control</b> (${_escape(c.controlKind || 'edit')}): ${_escape(c.label || '(unnamed)')}`,
    `On page: ${_escape(c.page)}`,
    c.tag ? `Tag: <code>${_escape(c.tag)}</code>${c.inputType ? ` type=${_escape(c.inputType)}` : ''}${c.role ? ` role=${_escape(c.role)}` : ''}` : null,
    c.name ? `Name: <code>${_escape(c.name)}</code>` : null,
    c.selector ? `Selector: <code>${_escape(c.selector)}</code>` : null,
  ].filter(Boolean).join('<br/>');
}

function _tooltipEdge(e) {
  const rel = e.relation ?? (e.via ? 'contains' : 'related');
  const lines = [`<b>${_escape(rel)}</b>`];
  if (e.via) lines.push(`via: ${_escape(e.via)}`);
  if (e.text) lines.push(`text: "${_escape(_truncate(e.text, 80))}"`);
  if (e.selector) lines.push(`selector: <code>${_escape(e.selector)}</code>`);
  if (e.href) lines.push(`href: <code>${_escape(e.href)}</code>`);
  return lines.join('<br/>');
}


// ── small utilities ────────────────────────────────────────────────────────


function _shortPath(url) {
  if (typeof url !== 'string') return String(url ?? '');
  // Already a path/pattern.
  if (!/^https?:\/\//i.test(url)) {
    return url.length > 36 ? url.slice(0, 35) + '…' : url;
  }
  try {
    const u = new URL(url);
    const path = u.pathname + (u.search || '');
    return path.length > 36 ? path.slice(0, 35) + '…' : (path || u.host);
  } catch {
    return _truncate(url, 36);
  }
}

function _truncate(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }

function _escape(s) {
  if (typeof s !== 'string') return String(s ?? '');
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
