// The child-process runner backend (p0-07 §3).
//
// Runs one test file as a child process and returns { status, durationMs,
// artifacts }. The backend is an interface on purpose — swap this for a
// Docker/E2B backend later without touching the executor — but it has to get the
// one hard thing right here and now: NO ORPHANS. A UI test launches Chromium; if
// the test hangs and we kill only the node process, Chromium leaks. So the child
// is spawned `detached` (its own process group) and a timeout kills the whole
// GROUP (`kill(-pid)`), taking every descendant with it. This is the E2B lesson,
// applied locally.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HARNESS = path.join(__dirname, 'harness.mjs');

/**
 * @param {object} entry   manifest entry ({ scenarioId, file, ... })
 * @param {object} config  { workspace, baseUrl, timeoutMs, env }
 * @returns {Promise<{ status, durationMs, artifacts, reason? }>}
 *   status: 'passed' | 'failed' | 'error'
 */
export function runChildProcess(entry, config) {
  return new Promise((resolve) => {
    const startedAt = Date.now();

    const rawDir = path.join(config.workspace, 'results', 'raw');
    const shotRel = path.join('results', 'shots', safe(entry.scenarioId));
    const shotAbs = path.join(config.workspace, shotRel);
    fs.mkdirSync(rawDir, { recursive: true });
    fs.mkdirSync(shotAbs, { recursive: true });
    const logRel = path.join('results', 'raw', `${safe(entry.scenarioId)}.log`);
    const logAbs = path.join(config.workspace, logRel);

    const testAbs = path.join(config.workspace, entry.file);
    if (!fs.existsSync(testAbs)) {
      fs.writeFileSync(logAbs, `test file missing: ${entry.file}\n`);
      return resolve({ status: 'error', durationMs: Date.now() - startedAt, reason: 'missing-file',
        artifacts: { log: logRel, screenshots: [] } });
    }

    let child;
    try {
      child = spawn(process.execPath, [HARNESS, testAbs], {
        cwd: config.workspace,
        env: { ...process.env, ...config.env, BASE_URL: config.baseUrl ?? '', SHOT_DIR: shotAbs },
        detached: true,          // new process group ⇒ we can kill the whole tree
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      fs.writeFileSync(logAbs, `spawn failed: ${e.message}\n`);
      // 'spawn' reason marks an INFRASTRUCTURE error the executor may retry once.
      return resolve({ status: 'error', durationMs: Date.now() - startedAt, reason: `spawn: ${e.message}`,
        artifacts: { log: logRel, screenshots: [] } });
    }

    let buf = '';
    const cap = (d) => { buf += d; };
    child.stdout.on('data', cap);
    child.stderr.on('data', cap);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid);       // the WHOLE group, not just the node process
    }, config.timeoutMs);

    child.on('error', (e) => {
      clearTimeout(timer);
      fs.writeFileSync(logAbs, buf + `\nchild error: ${e.message}\n`);
      resolve({ status: 'error', durationMs: Date.now() - startedAt, reason: `spawn: ${e.message}`,
        artifacts: { log: logRel, screenshots: [] } });
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      fs.writeFileSync(logAbs, buf);
      const durationMs = Date.now() - startedAt;
      const artifacts = { log: logRel, screenshots: listShots(shotAbs, shotRel) };

      if (timedOut) {
        return resolve({ status: 'error', durationMs, reason: 'timeout', artifacts });
      }
      if (code === 0) return resolve({ status: 'passed', durationMs, artifacts });
      // exit 2 = the harness couldn't run the file (no run() export) — a
      // generation/contract error, not a behavioural failure.
      if (code === 2) return resolve({ status: 'error', durationMs, reason: 'no-run-export', artifacts });
      return resolve({ status: 'failed', durationMs, reason: `exit ${code}${signal ? `/${signal}` : ''}`, artifacts });
    });
  });
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Kill the child's whole process group; fall back to the pid if that fails. */
function killGroup(pid) {
  if (!pid) return;
  try {
    process.kill(-pid, 'SIGKILL');     // negative pid = the process GROUP
  } catch {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

function listShots(absDir, relDir) {
  try {
    return fs.readdirSync(absDir)
      .filter((f) => /\.(png|jpg|jpeg|webp)$/i.test(f))
      .map((f) => path.join(relDir, f));
  } catch {
    return [];
  }
}

function safe(id) {
  return String(id).replace(/[^a-zA-Z0-9._-]+/g, '-');
}
