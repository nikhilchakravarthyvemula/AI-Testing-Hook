# Spec 17 — Knowledge sources (Jira / Confluence / tribal) + context-layer completion

Status: **planned** (design agreed 2026-08-19; phased for the 30 Sep pilot)
Depends on: spec-12 (BYO-LLM delegation + write-back pattern), spec-13 (monorepo), spec-16 (three-service split — decides where these files land)
Informed by: the SDD (19 Jun 2026) — §2.3 Scan requirement, §5.1.1 Knowledge Management row, §6 precedence rule, §7.4 sequence steps 2–4

> **TL;DR** — The SDD requires scan to "index code, specifications, **tickets and documentation**
> into an application map". This spec adds the three missing sources (Jira, Confluence, a tribal-docs
> folder) as ordinary content-extractor sources, adds a deterministic **cross-linker** that joins
> tickets to code and endpoints, and finishes the **knowledge-synthesizer** so all sources merge
> into one `knowledge.json` under the schema.mjs provenance rules. Credentials follow the
> engine-holds-nothing model: PAT in the device keystore, fetched by the CLI itself at run time,
> never in an argument, config file, or log. The LLM half (semantic graph extraction over the
> fetched text) is a delegation + write-back exactly like `annotate-intents` — and it is
> **explicitly cuttable for the pilot**, because the deterministic cross-links carry most of the
> value. Ticket acceptance criteria flow into generation as the test-plan prioritiser; that is the
> pilot's actual payoff and it ships in the deterministic path.

## 1. Context

The engine already extracts from the live app (crawler), the codebase (AST extractors, graphify),
and specs (openapi). The SDD's source list adds tickets, documentation and tribal knowledge
(SDD §4, §5.1.1: "Ingest Jira / Confluence / tribal docs into a test knowledge base"), and the
pilot's two targets — the Fraud API and Inbound Payments — are exactly the kind of systems where
the useful truth (acceptance criteria, known edge cases, payment-state diagrams) lives in Jira and
Confluence, not in the code.

Constraints this design inherits and must not violate:

- **The engine makes no model calls** (SDD §3.1 constraint; spec-12's whole premise). Every step
  below is deterministic except one clearly-marked delegation.
- **Credentials never leave the device** (SDD §2.4, TRM-SEC-VLT). HSBC access is via individual
  PATs against Jira/Confluence **Data Center** (Bearer auth), 90-day expiry typical.
- **The host is Copilot Chat, chat-surface only.** No model API, no `vscode.lm`, no custom VS Code
  extension (org policy, confirmed 2026-08). The reasoning half runs as Copilot agent-mode
  following a prompt file, driving CLI verbs in the terminal — the Copilot analogue of SKILL.md.
- **No new service.** Everything here is `testo scan` growing three sources and two pipeline
  steps. In the spec-16 split these files are Node and need device-local network + the PAT, so
  they belong to **testo (npm)**, not web-app.

## 2. What gets built

```
context-layer/content-extractor/
├── _lib/atlassian-client.mjs   🆕  shared HTTP client: auth, retry, cursor, redaction
├── jira/extract.mjs            🆕  tickets → structured facts + text corpus
├── confluence/extract.mjs      🆕  pages   → hierarchy facts + text corpus
├── tribal/extract.mjs          🆕  local docs folder → text corpus
context-layer/cross-linker/     🆕  deterministic joins (runs after extraction, before synthesis)
context-layer/knowledge-synthesizer/   ⬆ finished: precedence merge → knowledge.json
generation-layer/…              ⬆ test-plan builder reads ticket facts (acceptance criteria, priority)
bin: testo auth <source>        🆕  PAT capture → keystore
     testo sync jira|confluence 🆕  fetch-only convenience verb (scan calls the same code)
     testo enrich-graph         🆕  write-back for the delegated KG extraction (phase 2)
```

The extractors are auto-discovered by `run.mjs` like every other source (any folder with an
`extract.mjs` is picked up — `content-extractor/run.mjs:84-99`), so `testo scan` needs no
orchestration change beyond a stage entry: jira/confluence/tribal join **stage 1** (independent
inputs, network-bound, run in parallel with the crawler so they finish "for free" inside the
crawl's wall-clock).

## 3. Credentials — capture, storage, use, failure

> **Scope note (2026-08-19):** this section describes the *pilot* model — individual PAT +
> device keystore. The agreed *target* model for the dashboard era (config + secret references
> backend-side, values in Google Secret Manager, server-side sync, scanner ingests data only) is documented
> in [secrets-and-credentials-architecture.md](secrets-and-credentials-architecture.md); the
> provider-chain design below is what makes that migration a config change.

**Capture.** `testo auth jira --url https://jira.<host>` prompts for the PAT with echo off,
validates it immediately (`GET /rest/api/2/myself`; Confluence: `/rest/api/user/current`), and
refuses to store a token that doesn't authenticate. Keyed per host, so multiple instances coexist.

**Storage.** OS-native keystore via a small `SecretStore` interface with three providers, tried in
order and reported by `testo status`:

1. **keychain** — Windows Credential Manager / macOS Keychain (`@napi-rs/keyring` or equivalent;
   the native module must come from the internal registry — packaging spike, §8 phase 0).
2. **env** — `JIRA_PAT` / `CONFLUENCE_PAT` set by the user; documented fallback for locked-down
   machines where the keystore is unreachable.
3. **prompt** — interactive per-run entry; last resort, never persisted.

**Use.** The extractor asks `SecretStore` at run time. The token lives in one closure inside
`atlassian-client.mjs`, goes into the `Authorization` header, and nowhere else. It is **never** a
CLI argument (process lists), never written to any config or output file, and the client
registers the token string with the run-log redactor before the first request so it cannot appear
in `output/tool-runs/*.log` or the JSON envelope (spec-12 B2 discipline).

**Failure.** A 401/403 mid-run does not abort the scan — the source reports
`authRequired: { source: 'jira', reason: 'token-rejected', fix: 'testo auth jira --url …' }` in
its bundle and the envelope surfaces it, same shape as the crawler's SSO-wall block
(`byo-llm-poc/ctx.mjs:220`). The prompt file tells the host to stop and show the fix command
verbatim, mirroring the existing login-wall behaviour. Expired-PAT re-auth is therefore a
routine loop, not an error path.

**Cloud/DC portability.** DC uses `Authorization: Bearer <pat>`; Jira Cloud (home dev) uses
Basic with email + API token. `testo auth` detects which by probing, stores the mode alongside
the host key. One client, both worlds.

## 4. The Jira extractor

Scope comes from project config (`jiraProjects: ["FRAUD", "PAY"]`, plus optional extra JQL).
Fetch is incremental: `updated >= <cursor>` where the cursor is the max `updated` seen in the
previous bundle (persisted in the bundle itself, not a separate state file).

Each issue produces facts in **two distinct grades**:

| Output | Content | Tier (schema.mjs) |
|---|---|---|
| **Structured facts** | key, type, status, priority, components, labels, epic link, issue links, fix versions, **acceptance-criteria field**, reporter/assignee, updated | `SPEC` for workflow-structural fields (they are authoritative statements of intent), `DOCS_EXTRACTED` for anything parsed out of free text |
| **Corpus** | description + comments rendered to one markdown file per issue, YAML frontmatter: `source_url`, `captured_at`, `author`, `issue_key` | consumed later by cross-linker (regex) and the phase-2 delegation |

The bundle goes to `output/sources/jira.json` with standard provenance; corpus files to
`output/sources/jira-corpus/<KEY>.md`.

**Acceptance criteria is a custom field.** On DC it is almost certainly `customfield_XXXXX` and
the ID differs per instance. Day-one task on the HSBC network:
`GET /rest/api/2/issue/<any-key>?expand=names` and put the discovered ID in project config
(`jiraFields.acceptanceCriteria`). The extractor hard-fails its own bundle (not the scan) with a
clear message if the configured field is absent — silent loss of AC would silently gut the
test-plan mapping, which is the pilot's core value.

## 5. The Confluence extractor

Space-scoped (`confluenceSpaces: ["FRAUD"]`), incremental on `version.when`. Per page:

- **Structured facts**: page id/title, ancestor chain (hierarchy), labels, outgoing links —
  including Jira issue links, which Confluence stores structurally (macro/link elements), so the
  page↔ticket relation is `EXTRACTED`-grade without any text parsing.
- **Corpus**: storage-format XHTML → markdown, same frontmatter scheme, to
  `output/sources/confluence-corpus/<id>.md`. Tables survive as markdown tables (payment-state
  matrices in Confluence tables are prime test-plan input).

Jira and Confluence share `atlassian-client.mjs` (auth, paging, 429/backoff, cursor, redaction);
the two `extract.mjs` files stay thin.

## 6. The tribal extractor

A configured local folder (`tribalDocsPath`) of md/txt/pdf notes → same corpus treatment,
`DOCS_EXTRACTED` tier, frontmatter `author` from git blame when the folder is a repo. Trivial by
design; it exists because the SDD lists tribal knowledge as a source and the marginal cost over
the corpus pipeline is near zero.

## 7. Cross-linker — the highest-value edges, no LLM

Runs after extraction, before synthesis. All joins are deterministic and `EXTRACTED` (1.0):

1. **Issue keys in git** — `git log` messages + code comments in `TARGET_CODEBASE` grepped for
   configured project keys (`FRAUD-\d+`) → `code-file ↔ issue` edges with commit provenance.
2. **Endpoints in ticket text** — corpus scanned for the route/path literals already in the KB
   (crawler + AST + openapi endpoints) → `issue ↔ endpoint` edges. Match against the *known*
   endpoint list only — never invent an endpoint from ticket text (that direction becomes a gap,
   not a fact).
3. **Confluence ↔ Jira** — the structural links from §5, plus Jira remote-links back to pages.

Output: `output/sources/cross-links.json`. These edges are what generation actually consumes:
"which tickets touch this endpoint" is a lookup, not an inference.

## 8. Knowledge synthesizer — finishing the planned component

The synthesizer (already scaffolded in `context-layer/knowledge-synthesizer/`) becomes the single
merge point for all source bundles:

- **Entity resolution**: endpoints keyed by normalised method+path; pages by URL; tickets by key;
  code entities by file+symbol. The schema.mjs `factHash` is the identity.
- **Precedence** (SDD §6: "a weaker source never overwrites a directly observed one"): the
  existing tier table in `knowledge-base/schema.mjs` is the ordering; no new table anywhere else.
- **Fusion**: when independent source families agree on a fact, confidence combines by noisy-OR
  `1−∏(1−cᵢ)`; observations derived from the same underlying source keep MAX (no double-count) —
  per the 2026-06-29 research decision.
- **Conflicts → gaps**: spec says an endpoint exists, live never saw it (or vice versa) →
  emitted as a gap for the gap-analyzer, never averaged away.

Output stays `knowledge.json` + the indexer topics; nothing downstream changes shape.

## 9. Phase-2 delegation: semantic KG over the corpus (`enrich-graph`)

The only LLM step, and it follows spec-12's three moves exactly:

1. Scan emits a delegation: corpus file paths chunked (~20 files), plus a schema file — the
   **graphify node/edge JSON shape** (nodes, edges with `relation`,
   `EXTRACTED|INFERRED|AMBIGUOUS`, `confidence_score`) so the doc-graph is directly mergeable
   with graphify's code graph and exportable to the future graph store via graphify's existing
   Cypher path.
2. The prompt file instructs the host (Copilot agent mode / Claude Code) to produce fragments
   per chunk, treating all fetched text as untrusted data (same injection guard wording as the
   intent step).
3. `testo enrich-graph <dir> --json` validates fragments, drops malformed ones with a warning,
   merges accepted nodes/edges at `GRAPH_EXTRACTED` (0.65), re-runs the indexer.

Per-chunk results are cached by content hash so a second session never re-spends host requests on
unchanged files — with a chat-only host, resumability across sessions is the difference between
"works on a real space" and "works in the demo".

**Pilot stance: cut this if week 5 is tight.** Cross-linker edges plus structured facts deliver
the ticket-aware test plan without it. This section exists so the cut is a deferral, not a
redesign.

## 10. Generation: ticket-aware test plan

The test-plan builder gains one input: for each endpoint in scope, the linked tickets' acceptance
criteria, priority, and status. Concretely —

- AC lines become candidate scenario descriptions attached to the endpoint's plan entry, tagged
  with the issue key (traceability lands in the report and the audit trail for free — SDD's
  Risk & Audit row wants exactly this linkage).
- Ticket priority raises scenario rank (risk-based ordering, SDD Fig 4 "Build risk-based test
  plan").
- Closed-ticket AC ≈ regression candidates; open-ticket AC ≈ new-coverage candidates. The plan
  records which, generation treats both the same.

No model call: the AC text is carried as data into the plan the host model already reasons over
during generation.

## 11. CLI / envelope surface

| Verb | New? | Notes |
|---|---|---|
| `testo auth jira\|confluence` | 🆕 | capture + validate + store; `--url` per instance |
| `testo sync jira\|confluence` | 🆕 | fetch-only (same code path scan uses); useful for cron-less refresh |
| `testo scan` | ⬆ | runs the new sources in stage 1; envelope gains per-source `authRequired` and the new delegation type |
| `testo enrich-graph` | 🆕 | phase-2 write-back, mirrors `annotate-intents` |
| `testo status` | ⬆ (proposed→built) | reports SecretStore provider, token validity + age per host, cursors, last sync |

Envelope rules unchanged from spec-12: one JSON object on stdout, humans on stderr + run log,
secrets redacted everywhere.

## 12. Phasing — six weeks to the pilot

| Wk | Deliverable | Verify gate |
|---|---|---|
| 0/1 | Packaging spike (installable testo, Python-optional, Chromium mirror) + `testo auth` with SecretStore chain | clean-machine `npm i -g` → `testo auth` → `testo status` shows provider + valid token; PAT absent from every file under `output/` (grep gate) |
| 2 | `atlassian-client` + Jira extractor (structured + corpus + cursor + AC field config) | against real DC: bundle has AC text for a known ticket; second run fetches only issues updated since; kill token mid-run → `authRequired` in envelope, exit 0 for other sources |
| 3 | Confluence + tribal extractors, wired into `testo scan` stage 1 | scan of Fraud project + space completes; corpus files carry frontmatter; page↔ticket links present as EXTRACTED |
| 4 | Cross-linker + synthesizer merge | `knowledge.json` holds ticket↔endpoint edges; a spec-vs-live conflict shows as a gap, not a merged fact; noisy-OR only across independent families (unit test) |
| 5 | Ticket-aware test plan in generation + `testo status` | generated plan for one Fraud endpoint cites issue keys; plan order shifts when ticket priority changes (fixture test) |
| 6 | Pilot dry-run on Fraud API / Inbound Payments QA; prompt-file polish; enrich-graph **only if green** | end-to-end scan→plan→generate→execute→report with ticket traceability in the report |

## 13. Risks & day-one asks

1. **Egress allow-list** — Jira/Confluence base URLs must be requested **now**; SDD flags this as
   the longest lead-time item. Blocked network in week 2 kills the schedule.
2. **AC field ID unknown** — §4; one API call on day one, config not code.
3. **Native keystore module on locked-down Windows** — the env-var fallback is the contingency;
   `testo status` makes which mode is live visible so support isn't guesswork.
4. **Copilot policy drift** — prompt files / agent-mode terminal access have their own org
   toggles; re-verify on the HSBC machine before week 5 (the deterministic path through week 4
   has zero Copilot dependency, so this risk only threatens generation UX, not the pipeline).
5. **PII in ticket text** — corpus files hold whatever the ticket holds. They stay device-local
   in `output/` (SDD local working store) and are **not** part of the published run bundle in
   phase 1; publishing any corpus-derived artefact needs the DLP conversation first (spec-12 M1).

## 14. Decisions locked by this spec

| # | Decision | Rationale |
|---|---|---|
| 1 | Jira/Confluence are content-extractor sources inside `testo scan`, not a separate tool | SDD §2.3 defines scan as indexing tickets+docs; auto-discovery makes it free |
| 2 | PAT in OS keystore, fetched by the CLI at run time; never arg/config/log | SDD TRM-SEC-VLT; engine and secret-holder are the same process, so no handoff surface at all |
| 3 | kg-gen dropped | needs a model API the org will never provide; graphify-shape delegation covers the same ground host-side |
| 4 | Graphify node/edge JSON is the canonical graph interchange | merges doc-graph with code-graph; Cypher export already exists for the deferred graph store |
| 5 | Structured Jira workflow fields carry `SPEC` tier; free-text-derived facts `DOCS_EXTRACTED` | API-structured fields are authoritative intent, not prose inference |
| 6 | Cross-linker before synthesizer, matches against known endpoints only | high-confidence edges cheaply; unknown endpoint mentions become gaps, never facts |
| 7 | enrich-graph is cuttable for the pilot | deterministic path alone delivers the ticket-aware plan |
