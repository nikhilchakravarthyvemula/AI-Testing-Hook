export const meta = {
  name: 'progress',
  description: 'Summarized build progress per spec doc, ground-truthed against the actual code',
  whenToUse: 'Run anytime to get a fresh, per-category progress report (one row per docs/spec-*.md), verified against the working tree rather than the specs’ own stale status claims.',
  phases: [
    { title: 'Discover', detail: 'list docs/spec-*.md categories' },
    { title: 'Assess', detail: 'one agent per spec, verify built vs planned in code' },
    { title: 'Report', detail: 'compact progress table + roll-up' },
  ],
}

const REPO = '/Users/superalign/Documents/testing Harness'

const DISCOVERY_SCHEMA = {
  type: 'object',
  required: ['categories'],
  properties: {
    categories: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'path', 'title'],
        properties: {
          id: { type: 'string', description: 'short id, e.g. "spec-09"' },
          path: { type: 'string', description: 'repo-relative path to the spec doc' },
          title: { type: 'string', description: 'the spec’s title / one-line subject' },
        },
      },
    },
  },
}

const PROGRESS_SCHEMA = {
  type: 'object',
  required: ['id', 'title', 'status', 'percent', 'summary'],
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    status: { type: 'string', enum: ['not-started', 'doc-only', 'partial', 'mostly-done', 'done'] },
    percent: { type: 'integer', description: '0-100 estimate of built vs planned' },
    summary: { type: 'string', description: 'one sentence: where it stands, grounded in code' },
    done: { type: 'array', items: { type: 'string' }, description: 'concrete built items (with a file marker each)' },
    pending: { type: 'array', items: { type: 'string' }, description: 'concrete not-yet-built items' },
    blockers: { type: 'array', items: { type: 'string' }, description: 'prerequisites/blockers, if any' },
  },
}

// ── Phase 1: discover the categories (auto-adapts as specs are added) ──
phase('Discover')
const disc = await agent(
  `List every spec doc under ${REPO}/docs/spec-*.md (glob it). For each return {id (e.g. "spec-09"), path (repo-relative), title (the "# Spec NN — ..." heading text)}. Sort by spec number ascending. Do not read the bodies — just the filenames + first heading line.`,
  { schema: DISCOVERY_SCHEMA, phase: 'Discover', label: 'discover' }
)
const cats = (disc?.categories || []).filter(Boolean)
if (!cats.length) return { report: 'No spec docs found under docs/spec-*.md.' }
log(`tracking ${cats.length} spec categories`)

// ── Phase 2: assess each spec against the actual code (barrier: report needs all) ──
phase('Assess')
const records = await parallel(cats.map(c => () =>
  agent(
    `Assess the REAL build progress of ${REPO}/${c.path} (id ${c.id}) against the working tree — do NOT trust the spec’s own "build status" claims; verify in code.

Steps: (1) read the spec’s phases/work-packages/"Files to change" and its named target files/symbols; (2) grep/ls the repo (exclude .venv/node_modules/.git/output/__pycache__) for the concrete markers that prove each deliverable exists (files present, functions/rows/flags added, folders created/moved); (3) estimate percent built vs planned.

Return: status (not-started | doc-only | partial | mostly-done | done), an integer percent, a one-sentence summary grounded in what you found, up to 5 concrete "done" items each with a file marker, up to 5 concrete "pending" items, and any blockers/prerequisites. Notes: a design/remediation doc with zero code applied is "doc-only" or "not-started" (e.g. a review backlog whose fixes aren’t in the tree). Be terse and evidence-based.`,
    { schema: PROGRESS_SCHEMA, phase: 'Assess', label: `assess:${c.id}` }
  )
))
const clean = records.filter(Boolean)

// ── Phase 3: compact per-category report + overall roll-up ──
phase('Report')
const avg = clean.length ? Math.round(clean.reduce((s, r) => s + (r.percent || 0), 0) / clean.length) : 0
const report = await agent(
  `Write a SHORT progress report for the user from these per-spec records (JSON). Format:
1. A one-line overall roll-up (how many done / mostly-done / partial / doc-only / not-started; the mean built% is ${avg}%).
2. A compact markdown table: | Spec | Title | Status | % | Where it stands |  — one row per spec, ordered by spec number, "% " as a short bar or number, "Where it stands" = the one-sentence summary.
3. A "Next unblock" line: the 1–3 highest-leverage items to move the needle, drawn from the records’ pending/blockers.
Keep it tight and scannable — this is a recurring status check, not a deep dive. Do not invent anything beyond the records.

RECORDS:
${JSON.stringify(clean, null, 1)}`,
  { phase: 'Report', label: 'report' }
)

return { report, meanPercent: avg, records: clean }
