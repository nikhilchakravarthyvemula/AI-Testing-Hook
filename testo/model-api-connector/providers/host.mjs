// Host-sampling provider — routes chat() to the MCP host's model.
//
// Selected via LLM_PROVIDER=host. Instead of calling a cloud API, it POSTs the
// messages to the "sampling bridge" that the MCP server exposes; the bridge turns
// them into an MCP `create_message` sampling request, which the host (VS Code
// Copilot / Cursor) runs on its own model and returns. **No API key here** — the
// host owns the LLM. This is the BYO-LLM seam for the crawler's own adviseOn loop.
//
// Env (set by the MCP server when it spawns the pipeline):
//   SAMPLING_BRIDGE_URL   loopback URL of the bridge (required)
//   SAMPLING_TOKEN        correlates this run to the in-flight MCP request/ctx (optional)

const BRIDGE_URL_ENV = 'SAMPLING_BRIDGE_URL';
const TOKEN_ENV = 'SAMPLING_TOKEN';

/**
 * @param {object} [opts] { bridgeUrl?, token? }
 * @returns {{ chat: (req:object) => Promise<object> }}
 */
export function createHostClient(opts = {}) {
  const bridgeUrl = opts.bridgeUrl ?? process.env[BRIDGE_URL_ENV];
  if (!bridgeUrl) {
    throw new Error(
      `host provider: ${BRIDGE_URL_ENV} not set. The MCP server sets it when it ` +
      `spawns the pipeline; run under the MCP server (or set it manually to a bridge).`,
    );
  }
  const token = opts.token ?? process.env[TOKEN_ENV] ?? null;

  async function chat(req) {
    const { messages = [], temperature, maxTokens, timeoutMs } = req;

    // MCP sampling separates a system prompt from the user/assistant turns.
    let system = null;
    const convo = [];
    for (const m of messages) {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      if (m.role === 'system' && system == null) system = content;
      else convo.push({ role: m.role === 'assistant' ? 'assistant' : 'user', text: content });
    }

    const body = {
      token,
      system,
      messages: convo,
      maxTokens: maxTokens ?? 2048,
      temperature: temperature ?? 0,
    };

    const ctrl = new AbortController();
    const timer = timeoutMs ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    let res;
    let data;
    try {
      res = await fetch(bridgeUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`host bridge ${res.status}: ${t.slice(0, 200)}`);
      }
      data = await res.json();   // { content, model?, finishReason?, usage? }
    } finally {
      if (timer) clearTimeout(timer);   // cleared AFTER the body is read (avoids the minimax hang bug)
    }

    return {
      provider: 'host',
      model: data.model ?? 'host',
      content: data.content ?? '',
      finishReason: data.finishReason ?? 'stop',
      usage: data.usage ?? null,
      raw: data,
    };
  }

  return { chat };
}
