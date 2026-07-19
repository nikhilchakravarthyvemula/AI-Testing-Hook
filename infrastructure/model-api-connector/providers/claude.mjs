// The `claude` single-shot provider — Claude Code headless.
//
// One prompt in, one text answer out, via `claude -p --output-format json`. No
// tools, no session, no MCP — that is the AGENT seam's job (C2b). This is the
// Tier-1 path for S1/S2/S4 (docs/harness-use-cases.md): stateless calls the
// deterministic pipeline makes in-process.
//
// Auth rides the machine's existing Claude Code login — the connector holds no
// API key and constructs no credentials. On this dev machine that's the
// enterprise subscription; at work it'll be whatever `claude` is logged into.
//
// Why --system-prompt (replace, not --append-system-prompt): Claude Code's
// default system prompt is large (~17k cached tokens observed on a one-word
// reply). For a "classify these two endpoints" call that overhead is pure
// waste, so we REPLACE it with a minimal instruction. See p0-02 §Open Questions.

import { spawnSync } from 'node:child_process';

const DEFAULT_SYSTEM =
  'You are a precise completion service. Follow the instructions exactly and ' +
  'return only what is asked for. Do not use tools. Do not add commentary.';

/**
 * @param {object} [opts] { bin, defaultModel }
 * @returns {import('../complete.mjs').SingleShotProvider}
 */
export function createClaudeProvider(opts = {}) {
  const bin = opts.bin || process.env.CLAUDE_BIN || 'claude';

  return {
    id: 'claude',

    singleShot({ system, prompt, model, timeoutMs }) {
      const args = [
        '--print',
        '--output-format', 'json',
        '--system-prompt', system || DEFAULT_SYSTEM,
      ];
      if (model) args.push('--model', model);

      let r;
      try {
        r = spawnSync(bin, args, {
          input: prompt,
          encoding: 'utf8',
          timeout: timeoutMs,
          maxBuffer: 32 * 1024 * 1024,   // generation prompts can return a lot
        });
      } catch (e) {
        return unavailable(`failed to spawn ${bin}: ${e.message}`);
      }

      if (r.error) {
        const why = r.error.code === 'ETIMEDOUT'
          ? `timed out after ${timeoutMs}ms`
          : r.error.message;
        return unavailable(`${bin} ${why}`);
      }
      if (r.status !== 0) {
        return unavailable(`${bin} exited ${r.status}: ${truncate(r.stderr)}`);
      }

      let out;
      try {
        out = JSON.parse(r.stdout);
      } catch (e) {
        return unavailable(`could not parse ${bin} output as JSON: ${e.message}`);
      }

      // The CLI reports a model/API failure in-band (HTTP 200 with is_error),
      // not via exit code — so this must be checked explicitly.
      if (out.is_error || out.subtype !== 'success' || typeof out.result !== 'string') {
        return unavailable(`${bin} reported an error: ${out.subtype ?? 'unknown'}` +
          (out.api_error_status ? ` (${out.api_error_status})` : ''));
      }

      return {
        ok: true,
        text: out.result,
        model: primaryModel(out) || model || 'claude',
        usage: {
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

/** The concrete model id the CLI actually used, from its per-model usage map. */
function primaryModel(out) {
  const keys = Object.keys(out.modelUsage ?? {});
  // Prefer the alias form (no date suffix) when both are present.
  return keys.find((k) => !/\d{8}$/.test(k)) || keys[0] || null;
}

function truncate(s, n = 300) {
  const t = String(s ?? '').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}
