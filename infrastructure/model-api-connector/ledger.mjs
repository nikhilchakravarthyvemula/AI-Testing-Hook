// The engine-call ledger — one append-only line per engine call.
//
// This is the single source of truth for "what did the engine cost this run".
// Two readers depend on it agreeing with itself: the checkpoint shows the
// operator "N requests of M remaining", and the connector REFUSES a call once
// the budget is spent. If those two computed `requestsSpent` differently, the
// human would approve against one number while enforcement used another — so
// both go through this module. (The run spine's workspace.mjs re-exports these.)
//
// Format (docs/specs/p0-00-overview.md §5), one JSON object per line:
//   { ts, useCase, caller, engine, model, requests, inputTokens, outputTokens,
//     cacheHit, degraded, durationMs, note }
//
// The ledger lives at <workspace>/ledger.jsonl — part of the run-workspace
// contract (p0-00 §3). The connector writes; the report and the budget read.

import fs from 'node:fs';
import path from 'node:path';

/** The ledger path for a run workspace. Contract: <workspace>/ledger.jsonl. */
export function ledgerPath(workspace) {
  return path.join(workspace, 'ledger.jsonl');
}

/**
 * Append one engine-call record. Append-only, never rewritten — a run killed
 * mid-write loses at most the line in flight, never the history.
 *
 * @param {string} workspace  run workspace dir
 * @param {object} entry      partial record; ts is stamped here
 */
export function appendLedger(workspace, entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
  fs.appendFileSync(ledgerPath(workspace), line);
}

/**
 * Read every valid ledger line. Malformed lines are skipped, not thrown on:
 * a corrupt line must never make the budget check or the report crash.
 */
export function readLedger(workspace) {
  const p = ledgerPath(workspace);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

/**
 * Engine requests spent so far this run — the budget quantity.
 *
 * Cache hits contribute 0 (they carry `requests: 0`), so re-asking a cached
 * question is always free against the budget.
 */
export function requestsSpent(workspace) {
  return readLedger(workspace).reduce((sum, e) => sum + (e.requests ?? 0), 0);
}
