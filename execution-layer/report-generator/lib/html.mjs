// Tiny HTML helpers — the whole report is built from strings, so this is the
// one place that has to get escaping right. Everything user/engine-derived that
// lands in the page goes through esc(); nothing else does string interpolation
// of untrusted values.

export function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Join a list of html fragments; falsy entries are dropped. */
export function join(parts, sep = '\n') {
  return (parts ?? []).filter(Boolean).join(sep);
}

/** A small labelled tile (the summary row). `tone` shades it. */
export function tile(label, value, tone = 'neutral') {
  return `<div class="tile tile--${esc(tone)}"><div class="tile__num">${esc(value)}</div><div class="tile__label">${esc(label)}</div></div>`;
}

/** A section with an anchor + heading. `note` renders muted under the title. */
export function section(id, title, bodyHtml, note = null) {
  return `<section id="${esc(id)}" class="sec">
  <h2 class="sec__h">${esc(title)}</h2>
  ${note ? `<p class="sec__note">${esc(note)}</p>` : ''}
  ${bodyHtml}
</section>`;
}

/** An honest empty state — the report never drops a section, it explains it. */
export function empty(message) {
  return `<p class="empty">${esc(message)}</p>`;
}

/** Build a table from headers + rows (each row = array of pre-escaped html cells). */
export function table(headers, rows, { className = '' } = {}) {
  if (!rows.length) return '';
  const head = headers.map((h) => `<th>${esc(h)}</th>`).join('');
  const body = rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('\n');
  return `<table class="tbl ${esc(className)}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/** A status/severity pill. */
export function pill(text, tone) {
  return `<span class="pill pill--${esc(tone)}">${esc(text)}</span>`;
}

/** Map a result/severity to a tone class used by pills + tiles. */
export function toneFor(status) {
  return {
    passed: 'ok', failed: 'bad', error: 'bad', 'skipped-mutation': 'warn',
    'failed-generation': 'warn', high: 'bad', medium: 'warn', low: 'muted',
  }[status] ?? 'muted';
}
