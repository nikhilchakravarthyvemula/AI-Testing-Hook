// §D Run transparency — the honesty section (p0-08 §2 §D).
//
// Target/profile/mode; per-use-case engine spend reconciled with ledger.jsonl;
// budget spent vs cap; EVERY degradation (what fell back, why, what it means);
// the checkpoint record (incl. a --yes disclosure); stage timings. This is where
// a reader learns exactly how much to trust the rest of the report.

import { esc, join, section, empty, table, pill } from '../html.mjs';

export function renderTransparency(model) {
  const { run, ledger } = model;

  const meta = table(['Field', 'Value'], [
    ['Target', esc(run.target?.url ?? '—')],
    ['Profile', esc(model.profile)],
    ['Mode', pill(run.mode ?? '—', run.mode === 'full' ? 'bad' : 'ok')],
    ['Engine', esc(run.engine?.provider ?? '—')],
    ['Outcome', esc(run.outcome ?? '—')],
  ].map(([k, v]) => [esc(k), v]));

  return section('transparency', 'D · Run transparency', join([
    meta,
    renderEngineSpend(run, ledger),
    renderDegradations(run),
    renderCheckpoint(run),
    renderStageTimings(run),
    renderSources(run, model),
  ]));
}

// ── engine spend, reconciled with the ledger ─────────────────────────────────

function renderEngineSpend(run, ledger) {
  const byUse = {};
  let totalReq = 0, totalHits = 0, totalIn = 0, totalOut = 0;
  for (const l of ledger) {
    const u = (byUse[l.useCase] ??= { requests: 0, cacheHits: 0, inTok: 0, outTok: 0, degraded: 0 });
    u.requests += l.requests ?? 0; u.inTok += l.inputTokens ?? 0; u.outTok += l.outputTokens ?? 0;
    if (l.cacheHit) { u.cacheHits += 1; totalHits += 1; }
    if (l.degraded) u.degraded += 1;
    totalReq += l.requests ?? 0; totalIn += l.inputTokens ?? 0; totalOut += l.outputTokens ?? 0;
  }

  const rows = Object.entries(byUse).map(([u, v]) => [
    esc(u), String(v.requests), String(v.cacheHits), String(v.inTok), String(v.outTok),
    v.degraded ? pill(`${v.degraded} degraded`, 'warn') : '',
  ]);

  const cap = run.budget?.maxRequests;
  const budgetLine = cap != null
    ? `<p class="sec__note">Budget: <b>${totalReq}</b> of ${esc(cap)} request(s) spent` +
      `${totalReq > cap ? ' — <b>over cap</b>' : ''}. Cache hits: ${totalHits} (free). ` +
      `Tokens in/out: ${totalIn}/${totalOut}.</p>`
    : '';

  if (!rows.length) {
    return `<div class="sub">Engine spend</div>${empty('No engine calls recorded — a fully deterministic/degraded run.')}`;
  }
  rows.push([`<b>Total</b>`, `<b>${totalReq}</b>`, `<b>${totalHits}</b>`, `<b>${totalIn}</b>`, `<b>${totalOut}</b>`, '']);
  return `<div class="sub">Engine spend (reconciled with ledger.jsonl)</div>` +
    table(['Use case', 'Requests', 'Cache hits', 'Tokens in', 'Tokens out', ''], rows) + budgetLine;
}

// ── degradations — the load-bearing disclosure ───────────────────────────────

function renderDegradations(run) {
  const degraded = run.degraded ?? [];
  if (!degraded.length) {
    return `<div class="sub">Degradations</div>${empty('None — every stage ran at full fidelity.')}`;
  }
  const rows = degraded.map((d) => [
    esc(d.useCase ?? '—'), esc(d.stage ?? '—'), esc(d.reason ?? ''), esc(d.fallback ?? ''),
  ]);
  return `<div class="sub">Degradations (${degraded.length}) — what fell back, and why</div>` +
    table(['Use case', 'Stage', 'Reason', 'Fallback'], rows);
}

// ── checkpoint ───────────────────────────────────────────────────────────────

function renderCheckpoint(run) {
  const c = run.checkpoint ?? {};
  let body;
  if (c.approvedAt) {
    const viaYes = c.approvedBy === '--yes flag';
    body = `<p class="sec__note">Approved ${esc(c.approvedAt)} by <b>${esc(c.approvedBy ?? 'operator')}</b>.` +
      (viaYes ? ' <b>⚠ Auto-approved (--yes): no human reviewed this plan.</b>' : '') +
      (c.planHash ? ` <span class="mono">${esc(String(c.planHash).slice(0, 23))}…</span>` : '') + '</p>';
  } else if (c.declinedAt) {
    body = `<p class="sec__note">Declined ${esc(c.declinedAt)} — ${esc(c.reason ?? '')}. Nothing was executed.</p>`;
  } else {
    body = empty('No checkpoint decision recorded.');
  }
  return `<div class="sub">Checkpoint</div>${body}`;
}

// ── stage timings ────────────────────────────────────────────────────────────

function renderStageTimings(run) {
  const stages = run.stages ?? {};
  const rows = Object.entries(stages).map(([name, s]) => {
    const ms = s.startedAt && s.endedAt ? Date.parse(s.endedAt) - Date.parse(s.startedAt) : null;
    return [esc(name), pill(s.status ?? '—', s.status === 'done' ? 'ok' : s.status === 'failed' ? 'bad' : 'muted'),
      Number.isFinite(ms) ? `${ms} ms` : '—', s.degraded ? pill('degraded', 'warn') : ''];
  });
  if (!rows.length) return '';
  return `<div class="sub">Stage timings</div>` + table(['Stage', 'Status', 'Duration', ''], rows);
}

// ── sources consulted (and not) ──────────────────────────────────────────────

function renderSources(run, model) {
  const notes = [];
  if (!model.hasCodebase) notes.push('Codebase: not provided (url-only profile) — declared-vs-observed audit unavailable.');
  notes.push('Jira / Confluence: not consulted — S3 is deferred to P1 (no credentials provided).');
  const acquireFails = (run.degraded ?? []).filter((d) => d.stage === 'acquire');
  for (const d of acquireFails) notes.push(`Source "${d.useCase}": ${d.reason}`);
  return `<div class="sub">Sources consulted (and not)</div><ul class="sec__note">` +
    notes.map((n) => `<li>${esc(n)}</li>`).join('') + '</ul>';
}
