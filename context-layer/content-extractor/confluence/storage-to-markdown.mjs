// Confluence storage-format XHTML → markdown, and structural link extraction.
//
// Deterministic, dependency-free. Not a general HTML parser — it targets the
// storage format Confluence actually emits (well-formed XHTML with ac:/ri:
// namespaced elements), which is regular enough for staged regex passes.
// Priorities, in order:
//   1. tables survive as markdown tables (payment-state matrices in
//      Confluence tables are prime test-plan input — spec-17 §5)
//   2. code macros survive as fenced blocks
//   3. issue links come from STRUCTURAL elements (jira macros, /browse/
//      hrefs), never from free-text scanning — that is the cross-linker's job
//
// See docs/spec-17-knowledge-sources-and-context-layer.md §5.

const ISSUE_KEY = /[A-Z][A-Z0-9]+-\d+/;

/** Structural Jira issue references: single-issue jira macros (the `key`
 *  parameter — JQL-table macros have no key and are skipped) plus anchors to
 *  /browse/<KEY>. Returns unique keys, sorted. */
export function extractJiraKeys(storage) {
  const keys = new Set();
  const macros = storage.matchAll(/<ac:structured-macro[^>]*ac:name="jira"[\s\S]*?<\/ac:structured-macro>/g);
  for (const [macro] of macros) {
    const key = macro.match(new RegExp(`<ac:parameter[^>]*ac:name="key"[^>]*>(${ISSUE_KEY.source})</ac:parameter>`));
    if (key) keys.add(key[1]);
  }
  for (const [, key] of storage.matchAll(new RegExp(`href="[^"]*/browse/(${ISSUE_KEY.source})[^"]*"`, 'g'))) {
    keys.add(key);
  }
  return [...keys].sort();
}

/** Structural page→page links (<ac:link><ri:page ri:content-title="…"/>).
 *  Returns unique target page titles in document order. */
export function extractPageLinks(storage) {
  const titles = [];
  for (const [, title] of storage.matchAll(/<ri:page[^>]*ri:content-title="([^"]+)"/g)) {
    const decoded = decodeEntities(title);
    if (!titles.includes(decoded)) titles.push(decoded);
  }
  return titles;
}

export function storageToMarkdown(storage) {
  // Finished blocks (code fences, tables) are swapped out behind NUL-framed
  // sentinels until the end — NUL is illegal in XML, so no collision.
  const stash = [];
  const protect = (md) => `\x00${stash.push(md) - 1}\x00`;
  let s = storage;

  // Code macros → fenced blocks, protected from every later pass.
  s = s.replace(/<ac:structured-macro[^>]*ac:name="(?:code|noformat)"[\s\S]*?<\/ac:structured-macro>/g, (macro) => {
    const lang = macro.match(/<ac:parameter[^>]*ac:name="language"[^>]*>([^<]*)<\/ac:parameter>/)?.[1] ?? '';
    const body = macro.match(/<ac:plain-text-body><!\[CDATA\[([\s\S]*?)\]\]><\/ac:plain-text-body>/)?.[1] ?? '';
    return protect(`\n\`\`\`${lang}\n${body}\n\`\`\`\n`);
  });

  // Single-issue jira macros → the bare key (the JQL-table variant has no key
  // parameter and collapses to nothing — it is a query, not content).
  s = s.replace(/<ac:structured-macro[^>]*ac:name="jira"[\s\S]*?<\/ac:structured-macro>/g, (macro) =>
    macro.match(new RegExp(`<ac:parameter[^>]*ac:name="key"[^>]*>(${ISSUE_KEY.source})</ac:parameter>`))?.[1] ?? '');

  // Page links → their target title (explicit link body wins when present).
  s = s.replace(/<ac:link[\s\S]*?<\/ac:link>|<ac:link[^>]*\/>/g, (link) => {
    const body = link.match(/<ac:plain-text-link-body><!\[CDATA\[([\s\S]*?)\]\]><\/ac:plain-text-link-body>/)?.[1];
    const title = link.match(/ri:content-title="([^"]+)"/)?.[1];
    return body ?? (title ? decodeEntities(title) : '');
  });

  // Remaining macros (info/warning/toc/attachments…): keep any rich body text,
  // drop the wrapper. Images contribute nothing to a text corpus.
  s = s.replace(/<ac:structured-macro[\s\S]*?ac:rich-text-body>([\s\S]*?)<\/ac:rich-text-body>[\s\S]*?<\/ac:structured-macro>/g, '$1');
  s = s.replace(/<ac:structured-macro[\s\S]*?<\/ac:structured-macro>|<ac:structured-macro[^>]*\/>/g, '');
  s = s.replace(/<ac:image[\s\S]*?<\/ac:image>|<ac:image[^>]*\/>/g, '');

  // Tables → markdown tables, protected so list/paragraph passes can't touch them.
  s = s.replace(/<table[\s\S]*?<\/table>/g, (table) => protect(tableToMarkdown(table)));

  s = blockAndInline(s);

  // Strip whatever tags remain, decode entities, restore protected blocks.
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  s = s.replace(/\x00(\d+)\x00/g, (_, i) => stash[Number(i)]);
  return s.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

// ── passes ─────────────────────────────────────────────────────────────────

function tableToMarkdown(table) {
  const rows = [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(([, row]) =>
    [...row.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map(([, cell]) =>
      decodeEntities(blockAndInline(cell).replace(/<[^>]+>/g, ''))
        .replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim()));
  if (!rows.length) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const line = (cells) => `| ${[...cells, ...Array(width - cells.length).fill('')].join(' | ')} |`;
  return ['', line(rows[0]), line(Array(width).fill('---')), ...rows.slice(1).map(line), ''].join('\n');
}

/** Headings, lists, paragraphs, inline styles, anchors. Used on the whole
 *  document AND inside table cells (where the results are then flattened). */
function blockAndInline(s) {
  return s
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/g, (_, n, t) => `\n\n${'#'.repeat(Number(n))} ${t.trim()}\n\n`)
    .replace(/<li[^>]*>/g, '\n- ').replace(/<\/li>/g, '')
    .replace(/<\/?[ou]l[^>]*>/g, '\n')
    .replace(/<blockquote[^>]*>/g, '\n> ').replace(/<\/blockquote>/g, '\n')
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g, (_, href, text) =>
      text.trim() ? `[${text.trim()}](${href})` : href)
    .replace(/<(?:strong|b)>([\s\S]*?)<\/(?:strong|b)>/g, '**$1**')
    .replace(/<(?:em|i)>([\s\S]*?)<\/(?:em|i)>/g, '*$1*')
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/g, '`$1`')
    .replace(/<p[^>]*>/g, '\n\n').replace(/<\/p>/g, '')
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<hr\s*\/?>/g, '\n\n---\n\n');
}

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');   // last, so &amp;lt; cannot double-decode
}
