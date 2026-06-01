# Model API Connector

Pluggable LLM client interface. Speaks one shape (`ChatRequest` →
`ChatResponse`) so consumers don't care which provider they got back.

This is the architecture diagram's **Model API Connector** box —
the seam where every future LLM-using component (gap-analyzer LLM
enricher, agentic harness, mock data creator, …) goes through.

## Layout

```
infrastructure/model-api-connector/
├── types.mjs              shared ChatRequest / ChatResponse JSDoc shapes
├── index.mjs              public entrypoint: getClient(provider, opts)
├── providers/
│   └── minimax.mjs        MiniMax V2 chat-completion client
├── bin/
│   └── chat.mjs           one-shot CLI smoke test
└── README.md              (this file)
```

## Providers

| Provider | Status | Models | Env vars |
|---|---|---|---|
| `minimax` | ✅ | MiniMax-Text-01, MiniMax-M1, abab6.5s-chat, abab6.5g-chat | `MINIMAX_API_KEY` (required), `MINIMAX_REGION` (`global`\|`cn`, default `global`), `MINIMAX_MODEL` (default `MiniMax-Text-01`) |
| `gemini`  | planned | gemini-2.5-flash, gemini-2.5-pro | `GEMINI_API_KEY` |
| `openai`  | planned | gpt-4o, gpt-4o-mini | `OPENAI_API_KEY` |
| `claude`  | planned | claude-3-5-sonnet, claude-3-5-haiku | `ANTHROPIC_API_KEY` |
| `ollama`  | planned | any local model | (none) |

## Usage

### Programmatic

```js
import { getClient } from './infrastructure/model-api-connector/index.mjs';

const llm = getClient('minimax');             // reads env
const res = await llm.chat({
  messages: [
    { role: 'system', content: 'You are concise.' },
    { role: 'user',   content: 'One-line explanation of MiniMax.' },
  ],
  maxTokens: 200,
  temperature: 0.5,
});

console.log(res.content);            // → assistant message text
console.log(res.usage.totalTokens);  // → token count
console.log(res.model);              // → model id the provider used
```

### Smoke test (CLI)

```bash
# uses MINIMAX_API_KEY from <repo>/.env
node infrastructure/model-api-connector/bin/chat.mjs minimax "Say hi in one sentence."
```

Set the two MiniMax env vars in `<repo>/.env` first:

```ini
MINIMAX_API_KEY=...your key...
MINIMAX_GROUP_ID=...your group id...   # not needed for V2 chat, but recorded for future audio/embedding endpoints
MINIMAX_MODEL=MiniMax-Text-01
MINIMAX_REGION=global                  # or "cn"
```

## ChatRequest / ChatResponse shape

See `types.mjs`. The minimal request is just `{ messages }`. The
response is always:

```js
{
  provider: 'minimax',
  model: 'MiniMax-Text-01',
  content: '...assistant text...',
  finishReason: 'stop',
  usage: { inputTokens, outputTokens, totalTokens },
  raw: { /* provider-native body, for debugging */ },
}
```

## Adding a new provider

1. Drop `providers/<name>.mjs` exporting `createXClient({ apiKey, ... })`.
2. Register it in `index.mjs#PROVIDERS`.
3. Add a row to the Providers table above.

That's it. No interface to subclass — just return the `{ provider,
defaultModel, chat }` shape `index.mjs` already documents.
