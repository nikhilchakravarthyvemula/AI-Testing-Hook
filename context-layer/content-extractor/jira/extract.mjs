// Jira extractor — tickets → structured facts + text corpus (spec-17 §4).
//
// Deterministic fetch, no LLM. Two grades of output per issue:
//   facts    workflow-structural fields (status, priority, links, epic
//            containment, acceptance criteria) — SPEC-tier provenance:
//            authoritative statements of intent, straight from the API
//   corpus   description + comments rendered to one markdown file per issue
//            with YAML frontmatter — consumed later by the cross-linker
//            (deterministic regex) and the enrich-graph delegation (LLM half)
//
// Incremental: the cursor is the max `updated` seen, persisted IN the bundle
// (no separate state file); each run fetches `updated >= cursor` and merges
// over the previous bundle. run.mjs must therefore NOT wipe output/jira/.
//
// Credential flow: PAT from the SecretStore at run time (env JIRA_PAT wins,
// then the OS keystore). Never an argument, never logged — the client
// registers it with the redactor before the first request. Unconfigured →
// clean skip (exit 0, nothing written). Configured but token missing/rejected
// → bundle carrying an `authRequired` block (same shape as the crawler's SSO
// wall) so the scan envelope surfaces the fix; the scan itself carries on.
//
// Config (.testo/sources.json → "jira"):
//   { baseUrl, authMode, email?, projects: ["FRAUD"],
//     fields: { acceptanceCriteria: "customfield_10500", epicLink: "customfield_10100" },
//     jqlExtra?: "and labels != skip-harness" }
//
// Standalone: node context-layer/content-extractor/jira/extract.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient, whoami, AuthError } from '../_lib/atlassian-client.mjs';
import { getSecret } from '../_lib/secret-store.mjs';
import { loadSourceConfig, secretKeyFor } from '../_lib/source-config.mjs';
import { provenance, DiscoveryTier, contentHashOf } from '../../../knowledge-base/schema.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const OUT_DIR = path.join(REPO_ROOT, 'output', 'jira');
const BUNDLE_FILE = path.join(OUT_DIR, 'bundle.json');
const CORPUS_DIR = path.join(OUT_DIR, 'corpus');

// Base fields every fetch asks for; instance-specific custom fields (AC, epic
// link) are appended from config.
const BASE_FIELDS = [
  'summary', 'description', 'issuetype', 'status', 'priority', 'labels',
  'components', 'fixVersions', 'issuelinks', 'reporter', 'assignee',
  'created', 'updated', 'comment',
];

const log = (msg) => console.log(`[jira] ${msg}`);

async function main() {
  const cfg = loadSourceConfig().jira;
  if (!cfg?.baseUrl || !(cfg.projects?.length)) {
    log('not configured (.testo/sources.json needs jira.baseUrl + jira.projects) — skipping');
    return;
  }

  const found = getSecret(secretKeyFor('jira', cfg.baseUrl));
  if (!found) {
    log('no PAT available — writing authRequired bundle');
    return writeBundle(authRequiredBundle(cfg, 'no-token'));
  }

  const client = createClient({
    source: 'jira', baseUrl: cfg.baseUrl, token: found.value,
    authMode: cfg.authMode ?? 'bearer', email: cfg.email ?? null,
  });

  let fetchedAs;
  try {
    fetchedAs = await whoami(client);
  } catch (e) {
    if (e instanceof AuthError) {
      log(`token rejected — writing authRequired bundle`);
      return writeBundle({ ...authRequiredBundle(cfg, 'token-rejected'), authRequired: e.authRequired });
    }
    throw e;
  }
  log(`authenticated as ${fetchedAs.displayName ?? fetchedAs.name} (token from ${found.from})`);

  const previous = readPrevious();
  const jql = buildJql(cfg, previous?.cursor);
  log(`JQL: ${jql}`);

  const fields = [...BASE_FIELDS];
  if (cfg.fields?.acceptanceCriteria) fields.push(cfg.fields.acceptanceCriteria);
  if (cfg.fields?.epicLink) fields.push(cfg.fields.epicLink);

  const fetched = [];
  try {
    const origin = new URL(cfg.baseUrl).origin;
    for await (const issue of client.searchJira(jql, { fields })) {
      fetched.push(normalizeIssue(issue, cfg, origin));
      if (fetched.length % 100 === 0) log(`… ${fetched.length} issues`);
    }
  } catch (e) {
    // A bad custom-field id comes back as HTTP 400. Losing acceptance criteria
    // silently would gut the ticket-aware test plan, so fail THIS source loudly
    // (the orchestrator logs it; other sources continue).
    if (/HTTP 400/.test(e.message) && cfg.fields?.acceptanceCriteria) {
      throw new Error(
        `Jira rejected the query (HTTP 400) — check jira.fields.acceptanceCriteria ` +
        `("${cfg.fields.acceptanceCriteria}") against GET /rest/api/2/issue/<key>?expand=names`);
    }
    throw e;
  }
  log(`fetched ${fetched.length} new/updated issue(s) since ${previous?.cursor ?? 'the beginning'}`);

  // Incremental merge: updated issues replace their previous record by key.
  const byKey = new Map((previous?.issues ?? []).map((i) => [i.key, i]));
  for (const issue of fetched) byKey.set(issue.key, issue);
  const issues = [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
  const cursor = issues.reduce((max, i) => (i.updated > max ? i.updated : max), previous?.cursor ?? '');

  // AC-field sanity: configured but absent from every fetched issue (null is
  // fine — the field exists, just empty) means the id is stale. Loud flag.
  const acField = cfg.fields?.acceptanceCriteria ?? null;
  const acSeen = acField ? fetched.some((i) => i.acceptanceCriteria !== undefined) : false;
  if (acField && fetched.length > 0 && !acSeen) {
    log(`WARNING: acceptance-criteria field ${acField} came back on zero issues — id likely stale`);
  }

  for (const issue of fetched) writeCorpusFile(issue);

  writeBundle({
    source: 'jira',
    generatedAt: new Date().toISOString(),
    host: client.host,
    authMode: cfg.authMode ?? 'bearer',
    fetchedAs,                       // audit: which identity fetched this data
    tokenFrom: found.from,
    projects: cfg.projects,
    cursor,
    counts: { fetchedThisRun: fetched.length, total: issues.length },
    acField: { id: acField, seenThisRun: acSeen },
    authRequired: null,
    issues,
    facts: buildFacts(issues, cfg),
  });
  log(`bundle: ${issues.length} issue(s) total, cursor=${cursor || 'none'}`);
}

// ── normalization ──────────────────────────────────────────────────────────

function normalizeIssue(raw, cfg, origin) {
  const f = raw.fields ?? {};
  const acField = cfg.fields?.acceptanceCriteria;
  const epicField = cfg.fields?.epicLink;
  return {
    key: raw.key,
    url: `${origin}/browse/${raw.key}`,
    summary: f.summary ?? '',
    type: f.issuetype?.name ?? null,
    status: f.status?.name ?? null,
    statusCategory: f.status?.statusCategory?.key ?? null,   // new|indeterminate|done
    priority: f.priority?.name ?? null,
    labels: f.labels ?? [],
    components: (f.components ?? []).map((c) => c.name),
    fixVersions: (f.fixVersions ?? []).map((v) => v.name),
    reporter: f.reporter?.displayName ?? null,
    assignee: f.assignee?.displayName ?? null,
    created: f.created ?? null,
    updated: f.updated ?? null,
    epicKey: epicField ? (f[epicField] ?? null) : null,
    ...(acField ? { acceptanceCriteria: f[acField] ?? null } : {}),
    description: f.description ?? '',
    comments: (f.comment?.comments ?? []).map((c) => ({
      author: c.author?.displayName ?? null, created: c.created, body: c.body ?? '',
    })),
    links: (f.issuelinks ?? []).map((l) => ({
      type: l.type?.name ?? 'relates',
      direction: l.outwardIssue ? 'outward' : 'inward',
      otherKey: (l.outwardIssue ?? l.inwardIssue)?.key ?? null,
    })).filter((l) => l.otherKey),
  };
}

// ── facts (SPEC tier — structured, authoritative; spec-17 decision 5) ─────

function buildFacts(issues, cfg) {
  const prov = (issue) => provenance({
    sourceId: 'jira',
    tier: DiscoveryTier.SPEC,
    extractedBy: 'jira-extractor',
    sourceFile: issue.url,
    contentHash: contentHashOf({ key: issue.key, updated: issue.updated }),
  });

  const tickets = issues.map((i) => ({
    key: i.key, summary: i.summary, type: i.type, status: i.status,
    statusCategory: i.statusCategory, priority: i.priority, labels: i.labels,
    components: i.components, fixVersions: i.fixVersions,
    acceptanceCriteria: i.acceptanceCriteria ?? null,
    url: i.url, updated: i.updated,
    provenance: prov(i),
  }));

  const links = [];
  for (const i of issues) {
    if (i.epicKey) {
      links.push({ kind: 'epic-contains', from: i.epicKey, to: i.key, provenance: prov(i) });
    }
    for (const l of i.links) {
      // Emit outward only — the inward mirror on the other issue would
      // duplicate every edge.
      if (l.direction === 'outward') {
        links.push({ kind: 'issue-link', linkType: l.type, from: i.key, to: l.otherKey, provenance: prov(i) });
      }
    }
  }
  return { tickets, links };
}

// ── corpus (frontmatter format graphify/enrich-graph already understands) ──

function writeCorpusFile(issue) {
  fs.mkdirSync(CORPUS_DIR, { recursive: true });
  const fm = [
    '---',
    `issue_key: ${issue.key}`,
    `source_url: ${issue.url}`,
    `captured_at: ${issue.updated ?? ''}`,
    `author: ${JSON.stringify(issue.reporter ?? '')}`,
    '---',
  ];
  const body = [
    `# ${issue.key} — ${issue.summary}`,
    '',
    `Type: ${issue.type} · Status: ${issue.status} · Priority: ${issue.priority}`,
    '',
    issue.description,
    ...(issue.acceptanceCriteria
      ? ['', '## Acceptance criteria', '', issue.acceptanceCriteria] : []),
    ...(issue.comments.length ? ['', '## Comments'] : []),
    ...issue.comments.flatMap((c) => ['', `**${c.author}** (${c.created}):`, '', c.body]),
  ];
  fs.writeFileSync(path.join(CORPUS_DIR, `${issue.key}.md`), fm.concat(body).join('\n') + '\n');
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
    source: 'jira',
    generatedAt: new Date().toISOString(),
    host,
    counts: { fetchedThisRun: 0, total: readPrevious()?.issues?.length ?? 0 },
    authRequired: {
      source: 'jira', host, reason,
      fix: `node byo-llm-poc/ctx.mjs auth jira --url ${cfg.baseUrl}`,
    },
    issues: readPrevious()?.issues ?? [],
    facts: readPrevious()?.facts ?? { tickets: [], links: [] },
  };
}

function buildJql(cfg, cursor) {
  const projects = `project in (${cfg.projects.map((p) => `"${p}"`).join(', ')})`;
  // Overlap window (default 60 min) so an issue updated near the cursor cannot
  // slip between runs; the merge-by-key makes any re-fetch harmless.
  //
  // Timezone caveat: JQL datetimes are interpreted in the JIRA USER's profile
  // timezone, and we format in the MACHINE's local timezone. For a tester
  // using their own PAT these match (the pilot case). For a service account
  // whose profile TZ differs from the machine, set jira.cursorOverlapMinutes
  // in .testo/sources.json to at least the offset (e.g. 330 for UTC↔IST).
  const overlapMs = (cfg.cursorOverlapMinutes ?? 60) * 60_000;
  const since = cursor ? ` AND updated >= "${jqlDate(new Date(new Date(cursor).getTime() - overlapMs))}"` : '';
  const extra = cfg.jqlExtra ? ` ${cfg.jqlExtra}` : '';
  return `${projects}${since}${extra} ORDER BY updated ASC`;
}

function jqlDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

main().catch((e) => { console.error(`[jira] FAILED: ${e.message}`); process.exit(1); });
