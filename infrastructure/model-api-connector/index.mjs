// Model API connector — public entrypoint.
//
// Two surfaces, for two different needs:
//
//   • complete(req)      — the SINGLE-SHOT engine touchpoint (C2a). Cache +
//                          budget + schema + ledger wrapped around one prompt.
//                          This is what S1/S2/S4 (and later S6/S7) call. See
//                          complete.mjs and docs/specs/p0-02-engine-layer.spec.md.
//
//   • runSession(req)    — the AGENT-SESSION touchpoint (C2b, use case A1). A
//                          bounded, MCP-tool-using session that writes test
//                          files into the workspace, held to the honesty rule.
//                          This is what C6 (generate) calls. See session.mjs.
//
//   • getClient(provider) — the raw chat client (the pre-existing v1 surface,
//                          used by `bin/chat.mjs` and the legacy minimax path).
//                          complete() is the layer you almost always want; this
//                          stays for direct, unmanaged calls.
//
// Usage:
//
//   import { complete } from './infrastructure/model-api-connector/index.mjs';
//   const r = await complete({
//     useCase: 'S2', workspace: runDir, provider: 'claude',
//     prompt: 'Are these the same endpoint? …',
//     schema: { type: 'object', properties: { same: { type: 'boolean' } }, required: ['same'] },
//   });
//   if (r.ok) use(r.json); else fallBackDeterministically(r.error);

export { CONNECTOR_SCHEMA_VERSION } from './types.mjs';
export { complete } from './complete.mjs';
export { runSession } from './session.mjs';
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
