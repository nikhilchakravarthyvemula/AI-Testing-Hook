// The `claude` agent-session provider — the A1 touchpoint (C2b).
//
// This is the ONE agentic path in the whole project: a bounded, tool-using
// session that reads context through MCP and writes test files into the run
// workspace. It is driven by the SAME `claude` CLI the single-shot connector
// uses — proven by the OQ-4 spike (p0-02 §Open Questions), which is why C2b is
// Node and not Python: the CLI hosts MCP servers (`--mcp-config`) and runs full
// agent loops, so no second runtime / Agent SDK / OpenHarness is needed.
//
// The provider is deliberately dumb: it spawns the session and reports what the
// CLI said. The honesty rule, budget, ledger, and "what files appeared" checks
// live in session.mjs, exactly as complete.mjs wraps the single-shot providers.
//
// Safety posture in P0 (no sandbox yet — E2B is deferred):
//   • cwd = workspace, and --add-dir = workspace: file tools operate there.
//   • --allowedTools is an ALLOWLIST: Write/Edit/Read + the MCP server tools.
//     Bash is NOT on it, so the session cannot run shell commands.
//   • --permission-mode acceptEdits makes edits non-interactive (headless) while
//     keeping non-edit tools gated. True filesystem confinement is the sandbox's
//     job (p0-06), deferred; the allowlist is the P0 guard.

import { spawnSync } from 'node:child_process';

/**
 * @param {object} [opts] { bin }
 * @returns {import('../session.mjs').SessionProvider}
 */
export function createClaudeSessionProvider(opts = {}) {
  const bin = opts.bin || process.env.CLAUDE_BIN || 'claude';

  return {
    id: 'claude',

    runSession({ workspace, system, prompt, model, mcpConfigPath, allowedTools, maxTurns, timeoutMs, permissionMode }) {
      const args = [
        '--print',
        '--output-format', 'json',
        '--add-dir', workspace,
        '--permission-mode', permissionMode || process.env.SESSION_PERMISSION_MODE || 'acceptEdits',
        '--max-turns', String(maxTurns),
      ];
      if (system) args.push('--append-system-prompt', system);
      if (model) args.push('--model', model);
      if (mcpConfigPath) args.push('--mcp-config', mcpConfigPath, '--strict-mcp-config');
      if (allowedTools?.length) args.push('--allowedTools', ...allowedTools);

      let r;
      try {
        r = spawnSync(bin, args, {
          cwd: workspace,               // the session writes relative to here
          input: prompt,
          encoding: 'utf8',
          timeout: timeoutMs,
          maxBuffer: 64 * 1024 * 1024,
        });
      } catch (e) {
        return unavailable(`failed to spawn ${bin}: ${e.message}`);
      }

      if (r.error) {
        const why = r.error.code === 'ETIMEDOUT' ? `timed out after ${timeoutMs}ms` : r.error.message;
        return unavailable(`${bin} ${why}`);
      }
      if (r.status !== 0) {
        return unavailable(`${bin} exited ${r.status}: ${truncate(r.stderr)}`);
      }

      let out;
      try {
        out = JSON.parse(r.stdout);
      } catch (e) {
        return unavailable(`could not parse ${bin} session output: ${e.message}`);
      }
      if (out.is_error || out.subtype !== 'success') {
        return unavailable(`${bin} session error: ${out.subtype ?? 'unknown'}` +
          (out.api_error_status ? ` (${out.api_error_status})` : ''));
      }

      return {
        ok: true,
        model: primaryModel(out) || model || 'claude',
        finalText: typeof out.result === 'string' ? out.result : '',
        usage: {
          // A session is several model requests; count the turns it took so the
          // budget reflects real work, not one flat "session = 1".
          turns: out.num_turns ?? 1,
          inputTokens: out.usage?.input_tokens ?? 0,
          outputTokens: out.usage?.output_tokens ?? 0,
        },
      };
    },
  };
}

function unavailable(detail) {
  return { ok: false, error: 'engine-unavailable', detail };
}

function primaryModel(out) {
  const keys = Object.keys(out.modelUsage ?? {});
  return keys.find((k) => !/\d{8}$/.test(k)) || keys[0] || null;
}

function truncate(s, n = 300) {
  const t = String(s ?? '').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}
