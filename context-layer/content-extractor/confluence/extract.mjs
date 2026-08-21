// Confluence extractor — pages → structured facts + text corpus (spec-17 §5).
//
// Deterministic fetch, no LLM. Two grades of output per page:
//   facts    page id/title, ancestor chain, labels, and STRUCTURAL links —
//            page→issue from jira macros / browse hrefs, page→page from
//            ac:link elements. No text parsing; the page↔ticket relation
//            comes from macro/link elements Confluence stores structurally.
//   corpus   storage-format XHTML → markdown (tables survive as markdown
//            tables), one file per page with YAML frontmatter — consumed by
//            the cross-linker (regex) and the enrich-graph delegation.
//
// Incremental: the cursor is the max `version.when` seen, persisted IN the
// bundle (no separate state file); each run fetches `lastmodified >= cursor`
// via CQL and merges over the previous bundle by page id. run.mjs must
// therefore NOT wipe output/confluence/.
//
// Credential flow: identical to the Jira extractor — PAT from the SecretStore
// (env CONFLUENCE_PAT wins, then the OS keystore), registered with the
// redactor before the first request. Unconfigured → clean skip. Configured
// but token missing/rejected → bundle carrying an `authRequired` block; the
// scan itself carries on.
//
// Config (.testo/sources.json → "confluence"):
//   { baseUrl, authMode, email?, spaces: ["FRAUD"],
//     cqlExtra?: "and label != skip-harness", cursorOverlapMinutes? }
//
// Standalone: node context-layer/content-extractor/confluence/extract.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient, whoami, AuthError } from '../_lib/atlassian-client.mjs';
import { getSecret } from '../_lib/secret-store.mjs';
import { loadSourceConfig, secretKeyFor } from '../_lib/source-config.mjs';
import { provenance, DiscoveryTier, contentHashOf } from '../../../knowledge-base/schema.mjs';
import { storageToMarkdown, extractJiraKeys, extractPageLinks } from './storage-to-markdown.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const OUT_DIR = path.join(REPO_ROOT, 'output', 'confluence');
const BUNDLE_FILE = path.join(OUT_DIR, 'bundle.json');
const CORPUS_DIR = path.join(OUT_DIR, 'corpus');

const EXPAND = 'body.storage,version,ancestors,metadata.labels,space';

const log = (msg) => console.log(`[confluence] ${msg}`);

async function main() {
  const cfg = loadSourceConfig().confluence;
  if (!cfg?.baseUrl || !(cfg.spaces?.length)) {
    log('not configured (.testo/sources.json needs confluence.baseUrl + confluence.spaces) — skipping');
    return;
  }

  const found = getSecret(secretKeyFor('confluence', cfg.baseUrl));
  if (!found) {
    log('no PAT available — writing authRequired bundle');
    return writeBundle(authRequiredBundle(cfg, 'no-token'));
  }

  const client = createClient({
    source: 'confluence', baseUrl: cfg.baseUrl, token: found.value,
    authMode: cfg.authMode ?? 'bearer', email: cfg.email ?? null,
  });

  let fetchedAs;
  try {
    fetchedAs = await whoami(client);
  } catch (e) {
    if (e instanceof AuthError) {
      log('token rejected — writing authRequired bundle');
      return writeBundle({ ...authRequiredBundle(cfg, 'token-rejected'), authRequired: e.authRequired });
    }
    throw e;
  }
  log(`authenticated as ${fetchedAs.displayName ?? fetchedAs.name} (token from ${found.from})`);

  const previous = readPrevious();
  const cql = buildCql(cfg, previous?.cursor);
  log(`CQL: ${cql}`);

  const origin = new URL(cfg.baseUrl).origin;
  const fetched = [];
  for await (const page of client.searchConfluence('rest/api/content/search', { cql, expand: EXPAND })) {
    fetched.push(normalizePage(page, origin));
    if (fetched.length % 50 === 0) log(`… ${fetched.length} pages`);
  }
  log(`fetched ${fetched.length} new/updated page(s) since ${previous?.cursor ?? 'the beginning'}`);

  // Incremental merge: updated pages replace their previous record by id.
  const byId = new Map((previous?.pages ?? []).map((p) => [p.id, p]));
  for (const page of fetched) byId.set(page.id, page);
  const pages = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  const cursor = pages.reduce(
    (max, p) => (p.updated && (!max || new Date(p.updated) > new Date(max)) ? p.updated : max),
    previous?.cursor ?? '');

  for (const page of fetched) writeCorpusFile(page);

  writeBundle({
    source: 'confluence',
    generatedAt: new Date().toISOString(),
    host: client.host,
    authMode: cfg.authMode ?? 'bearer',
    fetchedAs,                       // audit: which identity fetched this data
    tokenFrom: found.from,
    spaces: cfg.spaces,
    cursor,
    counts: { fetchedThisRun: fetched.length, total: pages.length },
    authRequired: null,
    pages,
    facts: buildFacts(pages),
  });
  log(`bundle: ${pages.length} page(s) total, cursor=${cursor || 'none'}`);
}

// ── normalization ──────────────────────────────────────────────────────────

function normalizePage(raw, origin) {
  const storage = raw.body?.storage?.value ?? '';
  return {
    id: String(raw.id),
    title: raw.title ?? '',
    spaceKey: raw.space?.key ?? null,
    url: raw._links?.webui ? origin + raw._links.webui
                           : `${origin}/pages/viewpage.action?pageId=${raw.id}`,
    ancestors: (raw.ancestors ?? []).map((a) => ({ id: String(a.id), title: a.title ?? '' })),
    labels: (raw.metadata?.labels?.results ?? []).map((l) => l.name),
    version: raw.version?.number ?? null,
    author: raw.version?.by?.displayName ?? null,
    updated: raw.version?.when ?? null,
    issueKeys: extractJiraKeys(storage),        // structural: macros + /browse/ hrefs
    pageLinks: extractPageLinks(storage),       // structural: ac:link targets, by title
    markdown: storageToMarkdown(storage),
  };
}

// ── facts (structural, straight from the API — spec-17 §5) ────────────────

function buildFacts(pages) {
  // spec-17 calls these links "EXTRACTED-grade"; SPEC is the closest schema
  // tier (structural elements, zero text parsing) and matches how the Jira
  // extractor grades its workflow-structural fields.
  const prov = (page) => provenance({
    sourceId: 'confluence',
    tier: DiscoveryTier.SPEC,
    extractedBy: 'confluence-extractor',
    sourceFile: page.url,
    contentHash: contentHashOf({ id: page.id, updated: page.updated }),
  });

  const pageFacts = pages.map((p) => ({
    id: p.id, title: p.title, spaceKey: p.spaceKey, labels: p.labels,
    ancestors: p.ancestors, url: p.url, updated: p.updated,
    provenance: prov(p),
  }));

  const links = [];
  for (const p of pages) {
    for (const key of p.issueKeys) {
      links.push({ kind: 'page-issue', from: p.id, fromTitle: p.title, to: key, provenance: prov(p) });
    }
    for (const title of p.pageLinks) {
      links.push({ kind: 'page-page', from: p.id, fromTitle: p.title, toTitle: title, provenance: prov(p) });
    }
  }
  return { pages: pageFacts, links };
}

// ── corpus (frontmatter format graphify/enrich-graph already understands) ──

function writeCorpusFile(page) {
  fs.mkdirSync(CORPUS_DIR, { recursive: true });
  const fm = [
    '---',
    `page_id: ${page.id}`,
    `title: ${JSON.stringify(page.title)}`,
    `space: ${page.spaceKey ?? ''}`,
    `source_url: ${page.url}`,
    `captured_at: ${page.updated ?? ''}`,
    `author: ${JSON.stringify(page.author ?? '')}`,
    ...(page.labels.length ? [`labels: ${JSON.stringify(page.labels)}`] : []),
    '---',
  ];
  const crumb = page.ancestors.map((a) => a.title).filter(Boolean).join(' › ');
  const body = [
    `# ${page.title}`,
    ...(crumb ? ['', `_${crumb}_`] : []),
    '',
    page.markdown,
  ];
  fs.writeFileSync(path.join(CORPUS_DIR, `${page.id}.md`), fm.concat(body).join('\n') + '\n');
}

// ── bundle I/O ─────────────────────────────────────────────────────────────

function readPrevious() {
  try { return JSON.parse(fs.readFileSync(BUNDLE_FILE, 'utf8')); }
  catch { return null; }
}

function writeBundle(bundle) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(BUNDLE_FILE, JSON.stringify(bundle, null, 2) + '\n');
}

function authRequiredBundle(cfg, reason) {
  const host = new URL(cfg.baseUrl).host;
  return {
    source: 'confluence',
    generatedAt: new Date().toISOString(),
    host,
    counts: { fetchedThisRun: 0, total: readPrevious()?.pages?.length ?? 0 },
    authRequired: {
      source: 'confluence', host, reason,
      fix: `node byo-llm-poc/ctx.mjs auth confluence --url ${cfg.baseUrl}`,
    },
    pages: readPrevious()?.pages ?? [],
    facts: readPrevious()?.facts ?? { pages: [], links: [] },
  };
}

function buildCql(cfg, cursor) {
  const spaces = `space in (${cfg.spaces.map((s) => `"${s}"`).join(', ')})`;
  // Overlap window (default 60 min) so a page updated near the cursor cannot
  // slip between runs; the merge-by-id makes any re-fetch harmless. Same
  // timezone caveat as the Jira extractor: CQL datetimes are read in the
  // CONFLUENCE USER's profile timezone and we format in the machine's local
  // timezone — for a tester on their own PAT these match. Otherwise set
  // confluence.cursorOverlapMinutes to at least the offset.
  const overlapMs = (cfg.cursorOverlapMinutes ?? 60) * 60_000;
  const since = cursor ? ` and lastmodified >= "${cqlDate(new Date(new Date(cursor).getTime() - overlapMs))}"` : '';
  const extra = cfg.cqlExtra ? ` ${cfg.cqlExtra}` : '';
  return `${spaces} and type = page${since}${extra} order by lastmodified asc`;
}

function cqlDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

main().catch((e) => { console.error(`[confluence] FAILED: ${e.message}`); process.exit(1); });
