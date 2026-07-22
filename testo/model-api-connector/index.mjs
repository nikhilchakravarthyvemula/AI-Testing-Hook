// Model API connector — public entrypoint.
//
// Single function: `getClient(provider)`. BYO-LLM: the only provider is
// "host" — chat() routes to the MCP host model (VS Code Copilot / Claude
// Code) through the sampling bridge. No API keys live in this repo. This
// is the seam where future providers would register the same way without
// callers having to know which one they got.
//
// Usage:
//
//   import { getClient } from './testo/model-api-connector/index.mjs';
//   const llm = getClient('host');
//   const res = await llm.chat({
//     messages: [{ role: 'user', content: 'Say hi in one sentence.' }],
//   });
//   console.log(res.content, res.usage);

export { CONNECTOR_SCHEMA_VERSION } from './types.mjs';
import { createHostClient } from './providers/host.mjs';

const PROVIDERS = {
  host: createHostClient,   // BYO-LLM: routes chat() to the MCP host model via the sampling bridge
};

/**
 * Get a configured model client.
 *
 * @param {keyof typeof PROVIDERS} provider
 * @param {object} [opts]              provider-specific options (apiKey, region, etc.)
 * @returns {import('./types.mjs').ModelClient}
 */
export function getClient(provider, opts) {
  const factory = PROVIDERS[provider];
  if (!factory) {
    const supported = Object.keys(PROVIDERS).join(', ');
    throw new Error(`model-api-connector: unknown provider "${provider}". Supported: ${supported}`);
  }
  return factory(opts);
}

/** List provider ids registered in this build. */
export function listProviders() {
  return Object.keys(PROVIDERS);
}
