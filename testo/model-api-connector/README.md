# Model API Connector

Pluggable LLM client interface. Speaks one shape (`ChatRequest` →
`ChatResponse`) so consumers don't care which provider they got back.

This is the architecture diagram's **Model API Connector** box — the single
seam every LLM-using component goes through. **BYO-LLM: the only registered
provider is `host`** — no API keys live in this repo.

## Layout

```
testo/model-api-connector/
├── types.mjs              shared ChatRequest / ChatResponse JSDoc shapes
├── index.mjs              public entrypoint: getClient(provider, opts)
├── providers/
│   └── host.mjs           MCP host-sampling client (via the sampling bridge)
├── bin/
│   └── chat.mjs           one-shot CLI smoke test
└── README.md              (this file)
```

## Providers

| Provider | Status | Model | Env vars |
|---|---|---|---|
| `host` | ✅ | whatever the MCP host runs (Copilot / Claude Code) | `SAMPLING_BRIDGE_URL` (required — set by the MCP server when it spawns the pipeline), `SAMPLING_TOKEN` (correlates the run) |

With no bridge env present, `getClient('host')` throws at construction — the
crawler's llm-advisor catches that and falls back to its deterministic path.

## Usage

### Programmatic

```js
import { getClient } from './testo/model-api-connector/index.mjs';

const llm = getClient('host');                // reads SAMPLING_BRIDGE_URL/TOKEN
const res = await llm.chat({
  messages: [
    { role: 'system', content: 'You are concise.' },
    { role: 'user',   content: 'One-line explanation of MCP sampling.' },
  ],
  maxTokens: 200,
});

console.log(res.content);            // → host model's text
console.log(res.model);              // → model id the host reported
```

### Smoke test (CLI)

```bash
# needs a live bridge (normally the MCP server provides it)
SAMPLING_BRIDGE_URL=http://127.0.0.1:PORT SAMPLING_TOKEN=run-x \
  node testo/model-api-connector/bin/chat.mjs host "Say hi in one sentence."
```

## ChatRequest / ChatResponse shape

See `types.mjs`. The minimal request is just `{ messages }`. The
response is always:

```js
{
  provider: 'host',
  model: '…host model id…',
  content: '...assistant text...',
  finishReason: 'stop',
  usage: null,                       // hosts don't report token usage over sampling
  raw: { /* bridge-native body, for debugging */ },
}
```

## Adding a new provider

1. Drop `providers/<name>.mjs` exporting `createXClient({ ... })`.
2. Register it in `index.mjs#PROVIDERS`.
3. Add a row to the Providers table above.

That's it. No interface to subclass — just return the `{ chat }` shape
`index.mjs` already documents.
