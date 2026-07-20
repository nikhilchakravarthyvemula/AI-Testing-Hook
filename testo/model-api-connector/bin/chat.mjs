#!/usr/bin/env node
// Smoke test for the model-api-connector.
//
//   node testo/model-api-connector/bin/chat.mjs minimax "Say hi in one sentence."
//
// Loads <repo>/.env first so MINIMAX_API_KEY is picked up automatically.
// Prints the model's reply and a one-line usage summary.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadRepoEnv } from '../../_lib/load-env.mjs';
import { getClient, listProviders } from '../index.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

loadRepoEnv(REPO_ROOT);

const [, , providerArg, ...promptParts] = process.argv;
const provider = providerArg ?? 'minimax';
const prompt = promptParts.join(' ').trim() || 'Say hi in one short sentence.';

if (!listProviders().includes(provider)) {
  console.error(
    `unknown provider "${provider}". Supported: ${listProviders().join(', ')}`,
  );
  process.exit(2);
}

console.log(`[chat] provider=${provider}  prompt=${JSON.stringify(prompt)}`);

try {
  const llm = getClient(provider);
  const t0 = Date.now();
  const res = await llm.chat({
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 256,
    temperature: 0.7,
  });
  const ms = Date.now() - t0;
  console.log(`\n${res.content}\n`);
  console.log(
    `[chat] model=${res.model} finish=${res.finishReason ?? '?'} ` +
    `tokens(in/out/total)=${res.usage?.inputTokens ?? '?'}/${res.usage?.outputTokens ?? '?'}/${res.usage?.totalTokens ?? '?'} ` +
    `took=${ms}ms`,
  );
} catch (e) {
  console.error(`\n[chat] FAILED: ${e.message}`);
  process.exit(1);
}
