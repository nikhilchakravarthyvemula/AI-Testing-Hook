// Model API connector — public entrypoint.
//
// Single function: `getClient(provider)`. Pass "minimax" today; this
// is the seam where future providers (gemini, openai, claude, ollama)
// register the same way without callers having to know which one they
// got.
//
// Usage:
//
//   import { getClient } from './infrastructure/model-api-connector/index.mjs';
//   const llm = getClient('minimax');
//   const res = await llm.chat({
//     messages: [{ role: 'user', content: 'Say hi in one sentence.' }],
//   });
//   console.log(res.content, res.usage);

export { CONNECTOR_SCHEMA_VERSION } from './types.mjs';
import { createMiniMaxClient } from './providers/minimax.mjs';

const PROVIDERS = {
  minimax: createMiniMaxClient,
  // future: gemini, openai, claude, ollama
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
