// MiniMax chat-completion client.
//
// Targets MiniMax's V2 chat-completion endpoint:
//   POST {base}/text/chatcompletion_v2
//   Authorization: Bearer $MINIMAX_API_KEY
//
// Why V2 and not the older chatcompletion endpoint:
//   * GroupId is bound to the API key on V2 — no awkward query param
//   * Cleaner response shape (matches OpenAI chat completions roughly)
//   * Supported by the current generation of models (MiniMax-Text-01,
//     MiniMax-M1, abab6.5s-chat)
//
// Reference: https://www.minimaxi.com/document/guides/chat-model/V2

import { CONNECTOR_SCHEMA_VERSION } from '../types.mjs';

const REGION_BASE_URLS = {
  global: 'https://api.minimaxi.chat/v1',
  cn:     'https://api.minimax.chat/v1',
};

const DEFAULT_MODEL    = 'MiniMax-Text-01';
const DEFAULT_TIMEOUT  = 60_000;
const ENDPOINT_PATH    = '/text/chatcompletion_v2';

/**
 * Build a MiniMax client.
 *
 * @param {object} [opts]
 * @param {string} [opts.apiKey]      defaults to process.env.MINIMAX_API_KEY
 * @param {string} [opts.region]      "global" (default) | "cn"
 * @param {string} [opts.baseUrl]     full override (wins over region)
 * @param {string} [opts.defaultModel] defaults to process.env.MINIMAX_MODEL or "MiniMax-Text-01"
 */
export function createMiniMaxClient(opts = {}) {
  const apiKey = opts.apiKey ?? process.env.MINIMAX_API_KEY;
  if (!apiKey) {
    throw new Error(
      'MiniMax client: missing API key. Set MINIMAX_API_KEY in env ' +
      'or pass { apiKey } to createMiniMaxClient().'
    );
  }
  const region = opts.region ?? process.env.MINIMAX_REGION ?? 'global';
  const baseUrl = opts.baseUrl
    ?? REGION_BASE_URLS[region]
    ?? REGION_BASE_URLS.global;
  const defaultModel = opts.defaultModel
    ?? process.env.MINIMAX_MODEL
    ?? DEFAULT_MODEL;

  return {
    provider: 'minimax',
    defaultModel,
    schemaVersion: CONNECTOR_SCHEMA_VERSION,

    /** @param {import('../types.mjs').ChatRequest} req */
    async chat(req) {
      if (!req?.messages?.length) {
        throw new Error('MiniMax.chat: `messages` is required and must be non-empty');
      }

      const body = {
        model: req.model ?? defaultModel,
        messages: req.messages.map(_normaliseMessage),
        // MiniMax accepts the same names as OpenAI for these
        temperature: req.temperature,
        top_p: req.topP,
        max_tokens: req.maxTokens,
        stop: req.stop,
        stream: false, // streaming intentionally not implemented yet
      };
      // Strip undefineds so the wire payload stays minimal.
      for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];

      const url = baseUrl.replace(/\/+$/, '') + ENDPOINT_PATH;
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        req.timeoutMs ?? DEFAULT_TIMEOUT,
      );

      let res;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (e) {
        if (e.name === 'AbortError') {
          throw new Error(`MiniMax request timed out after ${req.timeoutMs ?? DEFAULT_TIMEOUT}ms`);
        }
        throw new Error(`MiniMax network error: ${e.message}`);
      } finally {
        clearTimeout(timer);
      }

      const raw = await _safeJson(res);

      // MiniMax-specific failure pattern: HTTP 200 but base_resp.status_code != 0.
      // Surface that as an explicit error so callers don't silently swallow
      // an "I'm sorry, the request was throttled" non-response.
      const baseResp = raw?.base_resp;
      if (!res.ok || (baseResp && baseResp.status_code !== 0)) {
        const detail = baseResp?.status_msg
          ?? raw?.error?.message
          ?? `HTTP ${res.status}`;
        throw new Error(`MiniMax API error: ${detail} (raw=${JSON.stringify(raw).slice(0, 240)}…)`);
      }

      const choice = raw?.choices?.[0];
      const content = choice?.message?.content ?? '';
      const usage = raw?.usage ?? {};

      return {
        provider: 'minimax',
        model: raw?.model ?? body.model,
        content,
        finishReason: choice?.finish_reason,
        usage: {
          inputTokens:  usage.prompt_tokens
            ?? (usage.total_tokens != null && usage.completion_tokens != null
                  ? usage.total_tokens - usage.completion_tokens
                  : undefined),
          outputTokens: usage.completion_tokens ?? undefined,
          totalTokens:  usage.total_tokens      ?? undefined,
        },
        raw,
      };
    },
  };
}

// ── helpers ────────────────────────────────────────────────────────────────

function _normaliseMessage(m) {
  // MiniMax expects {role, content} with optional name for tool messages.
  // We accept either shape and emit MiniMax's shape verbatim.
  if (typeof m === 'string') return { role: 'user', content: m };
  const { role, content, name } = m;
  if (!role || typeof content !== 'string') {
    throw new Error(`MiniMax: message must be {role, content:string}; got ${JSON.stringify(m)}`);
  }
  const out = { role, content };
  if (name) out.name = name;
  return out;
}

async function _safeJson(res) {
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); }
  catch { return { _nonjson: true, _text: text.slice(0, 1024) }; }
}
