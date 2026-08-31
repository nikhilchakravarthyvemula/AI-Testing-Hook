# Spec 21 — The bridge: a UI-triggered scan over the Agent Host Protocol

_Target when built: a new `testo bridge` command in the npm package (localhost HTTP server + static
page + run state + job queue); a new structured event stream `output/tool-runs/<runId>.events.jsonl`;
an AHP client leg using `@microsoft/agent-host-protocol`; two new CLI verbs `bridge next --wait` /
`bridge complete`; and a worker loop section in `SKILL.md`. **No VS Code extension. No provider key.
No new model dependency.**_

> **TL;DR** — A button in a local web page must start a scan whose reasoning happens in the
> developer's editor model. The blocker was thought to be that no external process can drive Copilot
> — that is **out of date**. **AHP, the Agent Host Protocol, is Microsoft's, ships with VS Code
> 1.129/1.133, and exists precisely to let external local clients share a long-running agent
> session.** Its local endpoint is **live on this machine today** (§0.1). The design is three tiers
> behind one unchanged delegation contract: **AHP** where available, an outbound **pull queue** the
> skill long-polls (portable to every host), and today's **file protocol** as the floor. Build the
> queue first — it is portable and carries no unresolved legal question; AHP is a swappable
> accelerator. §7 lists the open questions, one of which is commercial and must be cleared before
> engineering spend.

---

## 0. Context

Requirement: click **Scan** in a local UI → the CLI runs → the editor's model performs intent
classification, feature naming, test generation and validation → progress streams back live. **The
trigger must originate in the UI.**

Spec-18:328 records the same gap from the server side: dashboard and schedule triggers
**`return 501 with "device-push only"`**. Today the only trigger is a human typing `/ctx` and
hand-fulfilling a file-based delegation.

### 0.1 The correcting fact, verified three ways

An earlier reading of this problem concluded that the only programmatic path to Copilot was a VS Code
extension using `vscode.lm`. **That is out of date.** AHP is purpose-built for this, and states the
distinction itself:

> "Most agent protocols describe a one-to-one conversation between a client and an agent. AHP solves
> a different problem: coordinating multiple independent clients around the same long-running agent
> session."

1. **The spec** — `microsoft.github.io/agent-host-protocol`: Microsoft-published; multi-client;
   streaming; "monotonically-sequenced mutations broadcast from a central host to all subscribed
   clients."
2. **The endpoint exists on this machine**, matching the documented schema exactly —
   `~/Library/Application Support/Code/agent-host/local-endpoint/entries/<sha256>.json`:
   ```json
   { "schemaVersion": 2, "type": "editor", "pid": 6198, "instanceId": "…",
     "endpoint": { "type": "socket",
                   "path": "/var/folders/…/vscode-ah-<hash>/<instanceId>.sock" },
     "connectionToken": "<43 chars, base64url>", "protocolVersion": "0.8.0" }
   ```
3. **The client is published** — `npm view @microsoft/agent-host-protocol` → **v0.9.0**, "TypeScript
   client for the Agent Host Protocol (AHP)."

`src/vs/platform/agentHost/LOCAL_ENDPOINT.md` scopes itself explicitly to outside callers: *"This
document describes only the discoverable endpoint for external local clients."* **The testo CLI is a
first-class intended consumer.** Copilot runs as a harness inside the Agent Host, so the reasoning
still spends the user's own entitlement — the npm package ships no key and no provider SDK, and the
BYO-LLM guarantee in `roadmap/README.md:46` holds unchanged.

---

## 1. Architecture — three tiers that degrade gracefully

```
┌─ Browser, 127.0.0.1 ────────────────┐
│  Scan button                        │  POST /runs            → {runId}
│  Live monitor                       │  GET  /runs/:id/events → SSE
└──────────────┬──────────────────────┘
┌──────────────▼──────────────────────────────────────────────────┐
│ testo bridge — a small Node server inside the npm package       │
│   • serves the local page; owns run state                       │
│   • spawns ctx.mjs for all deterministic work                   │
│   • re-broadcasts CLI events + model deltas as ONE SSE stream    │
│   └── model access, first match wins:                           │
│        T1  AHP  → Agent Host socket → Copilot harness           │
│        T2  queue → skill long-polls `testo bridge next --wait`   │
│        T3  file delegation (today's path, human-driven)         │
└─────────────────────────────────────────────────────────────────┘
```

**Tier 1 — AHP (VS Code).** The bridge discovers the endpoint entry, connects by WebSocket over the
Unix socket (named pipe on Windows) with `?tkn=<connectionToken>`, sends `initialize`, and holds
**one session for the whole scan**. Each model touchpoint is a `chat/turnStarted` on that session.
Streaming is native and granular: `chat/delta`, `chat/responsePart`, `chat/toolCallStart`,
`chat/inputRequested`, terminating in `chat/turnComplete` or `chat/error`. Sessions survive with no
client attached, so the UI can disconnect and reattach mid-scan without killing the run.

**Tier 2 — the pull queue.** Where there is no Agent Host — Claude Code, Zed, JetBrains, an older VS
Code — the bridge queues the same request and **the skill pulls it**: `testo bridge next --wait`
long-polls, the host model reasons, `testo bridge complete <id>` posts back. The connection is
**outbound from the editor**, so nothing has to reach in: no inbound port, no firewall traversal, no
extension. This is the only tier that works on every host, so it is **the baseline, not a fallback**.

**Tier 3 — files.** Today's `writeIntentDelegation` → `write_back` path, unchanged, for a human with
no bridge running.

**One contract across all three.** The delegation record already carries
`{kind, schema_path, input_paths, write_back}` and *is self-describing* — `write_back` is literally
the command that fulfils it. The tiers differ only in **who answers it and how fast**. The schema,
the validators, the `clickableId` identity join and the merge are untouched.

---

## 2. Why not the alternatives

| Protocol | Verdict |
|---|---|
| **ACP** (Zed, Agent Client Protocol) | **Wrong direction.** Makes the editor a *client* driving external agent CLIs; we need the inverse. No first-party VS Code support (`microsoft/vscode#265496` open). Assumes a single client and keeps state with the agent, so a UI and the editor cannot jointly observe one run. |
| **ACP** (IBM/BeeAI, Agent Communication Protocol) | **Discontinued.** Merged into A2A under LF AI & Data, 2025-08-29. The name collision is the only reason it still comes up. |
| **A2A** | Cross-organisational server-to-server interop. VS Code publishes no Agent Card; adopting it means running your own agent server **with your own credentials** — violates the hard constraint outright. |
| **MCP sampling** | **Double-blocked.** Org-blocked here already (`testo/src/crawler/llm-advisor/index.mjs:8-15`), **and deprecated** as of MCP protocol 2026-07-28 (SEP-2577) — whose migration guidance is "integrate directly with LLM provider APIs", the one thing we cannot do. Building the core loop on a feature with a published removal path is not an option. |
| **MCP tools / elicitation** | **Causality is backwards.** A server only responds *inside* a tool call the model already chose to make; elicitation requests input from the **human**, not the model. Neither starts a run from a button, and neither lets the CLI ask the model a question on its own initiative. MCP stays the right way to expose testo *to* an agent — the wrong way to consume one. |

Microsoft's own comparison is the clean summary: *"AHP is a coordination layer. ACP is a
communication layer. They compose naturally."*

---

## 3. Progress streaming

**The only live surface today** is `output/tool-runs/ctx-<runId>.log` — appended per line via
`appendFileSync` (`byo-llm-poc/ctx.mjs:59-63`), with child stdout/stderr forwarded per chunk
(`:85-94`), so it genuinely grows in real time. `annotate-intents` calls `openLog(runId)` with the
same `runId` and therefore **appends to the same file**, so one tail follows both halves of a
delegation round trip.

Two defects make it unfit as an API:

- **No timestamps.** `grep -cE "[0-9]{2}:[0-9]{2}:[0-9]{2}"` over a real log returns **0**. Stage
  durations and stall detection are impossible from the log alone.
- **Prose, not events.** Real lines read `  [content-extractor] [crawler] [crawl] parallel-DFS walker
  — seeds=1 workers=4`. The `[ctx] → <label>` / `[ctx] ✓ <label> exit N` grammar is stable and
  greppable, but it is an accidental interface.

**So emit a structured stream alongside it:** `output/tool-runs/<runId>.events.jsonl`, one NDJSON
object per line — `{ts, runId, seq, type, stage, …}` with types `run.started`, `stage.started`,
`stage.finished`, `progress`, `delegation.requested`, `delegation.fulfilled`, `run.finished`. This is
the `output/tool-runs.jsonl` that `spec-12:161` specified and that was never built.

The bridge merges those events with AHP `chat/delta` frames into **one SSE stream**, matching
spec-18's existing transport decision (`GET /v1/scans/{scanId}/events`, `sse-starlette`, and "SSE
buffering off" in the nginx notes). Both sources carry a monotonic sequence — AHP stamps its own, the
jsonl carries `seq` — so the SSE event id is a merged cursor and a reconnecting browser replays from
`Last-Event-ID`. **Resumability falls out of the log being the source of truth**, not an in-memory
buffer that dies with the process.

---

## 4. Security

A server on `127.0.0.1` is **not** private to the machine: any web page the developer visits can send
requests to it. The specific attack is **DNS rebinding** — an attacker-controlled domain re-resolves
to loopback, so the browser treats the bridge as same-origin.

- Bind `127.0.0.1` explicitly, never `0.0.0.0`. Ephemeral port, never a fixed well-known one.
- **Validate the `Host` header** against an allowlist (`127.0.0.1:<port>`, `localhost:<port>`). This
  is the actual rebinding defence, because the rebound request arrives carrying the attacker's
  hostname. Validate `Origin` as well and reject anything but the bridge's own.
- **Per-session bearer token**, generated at startup and injected into the page the bridge serves.
  `EventSource` cannot set headers, so the SSE endpoint takes a **single-use, short-TTL ticket** —
  exactly the pattern spec-18 §2 already specifies (`POST /v1/auth/sse-ticket`, 60 s).
- **The AHP `connectionToken` is a credential.** Read the entry file, use it to connect, discard it.
  Never log it, never place it in an envelope or an event, never expose it to the browser.
- **Treat all crawled text as untrusted DATA.** Page text, button labels and response bodies flow
  into prompts on every tier. Carry the instruction from `SKILL.md:42-44` verbatim into every prompt
  the bridge composes.

---

## 5. What exists vs what is new

**Reused unchanged:** the delegation schema, validators, `clickableId` identity join and merge; the
self-describing `write_back`; the one-JSON-object-on-stdout contract; `runId` + per-run log; `spawn`
with per-chunk forwarding (`ctx.mjs:85-94`); and the **line-framed sentinel protocol** in `runSkill`
(`ctx.mjs:531-552`), which parses a growing stdout buffer for `[call_skill:result] ` — the working
in-repo precedent for structured child↔parent messaging.

**New — verified absent today:** any HTTP server in any language (zero `createServer` / `listen` /
`express` / `fastify` in first-party code); any SSE or WebSocket (zero `EventSource`, zero
`text/event-stream`); any file-watch (zero `fs.watch` / `chokidar`); the structured event log; the
AHP client leg; the queue; the local page. `web-app/api/` **has never existed in any commit**.

**Hard prerequisite — do this first or build the bridge twice:** spec-19 §10 **B2 — `ctx.mjs` is not
relocatable.** It computes `REPO_ROOT = path.resolve(__dirname, '..')` and reaches into
`../context-layer/`, `../generation-layer/`, `../node_modules/.bin/playwright`, plus a hardcoded
`.venv` python path (`:525`).

**Do not revive:** `.vscode/mcp.json` existed and was deleted in `53e10b8`. It registered **stdio MCP
servers** — a different integration point, and closed for the reasons in §2. Note also that
`README.md` and `byo-llm-poc/README.md` still describe that MCP server as a live front door; they are
stale (spec-19 §10 records this).

---

## 6. Phasing

| # | Step | Effort |
|---|---|---|
| 0 | Make `ctx.mjs` relocatable (spec-19 B2) | 1–2 d |
| 1 | `<runId>.events.jsonl` emitter + timestamps in the existing log | 1 d |
| 2 | `testo bridge` — localhost server, static page, token + Host/Origin checks, run state | 2 d |
| 3 | `POST /runs` spawns the CLI; `GET /runs/:id/events` tails the jsonl → SSE with `Last-Event-ID` replay | 2 d |
| 4 | **Tier 2 queue** — `bridge next --wait` / `bridge complete`; the SKILL.md worker loop | 2 d |
| 5 | **Tier 1 AHP** — entry discovery + liveness, socket + token, `initialize`, session, turns, delta→SSE | 3 d |
| 6 | Wire the four touchpoints onto the tier-agnostic call; cancellation; packaging | 3 d |

**Build Tier 2 before Tier 1.** It is portable to every host, it has no unresolved legal question,
and building it first makes Tier 1 a swappable accelerator rather than a dependency.

**Spike first (~1 day):** connect to the live endpoint on this machine, `initialize`, open a session,
dispatch one turn, print the deltas. That settles §7 items 1–3 before any real build.

---

## 7. Risks and open questions

1. **Unresolved commercial gate — clear this before engineering spend.** Whether GitHub Copilot's
   terms of service or enterprise policy permit a third-party product driving the harness
   programmatically via the Agent Host. This is a legal question, not a technical one, and it is the
   same *class* of constraint that already blocked MCP sampling for this client.
2. **Harness selection from an external client is unconfirmed.** `createSession` exists and the UI
   exposes a Session Target control, but the external-facing parameter that pins a session to
   **Copilot specifically** was not found in the docs. If it is UI-only, an external client may get
   whatever the default harness is.
3. **Version skew, observed on this machine.** The endpoint advertises `protocolVersion: "0.8.0"`;
   the published npm client is `0.9.0`. Negotiation behaviour untested.
4. **AHP is days old.** The architecture blog is dated 2026-08-26. The endpoint doc versions its entry
   schema and instructs clients to "ignore entries whose version they do not understand", but
   publishes **no stability or back-compat commitment**. Treat as a fast path with a fallback, never
   as the sole transport.
5. **Stale entries.** The entry read here carries `pid 6198` from 19 Aug and may reference a dead
   window. Clients must liveness-check the pid and the socket, not trust the file.
6. **Tool-call confirmations may gate on a human.** AHP defines `chat/toolCallConfirmed`,
   `chat/toolCallResultConfirmed` and a `chat/inputRequested` action; depending on harness approval
   settings an automated run can stall unless the bridge answers them or approvals are pre-configured.
7. **VS Code must be running** for Tier 1 — or a standalone `code agent host`, which also supports
   `--tunnel`. Tier 2 covers every other case, and the UI must say plainly which tier is active.
8. **Scope.** This closes the trigger gap for **device** scans only. Spec-18's server-side headless
   path (501 today) is a separate build and is not addressed here.

## Out of scope

The hosted dashboard and any tunnel or runner-pull to a remote server; server-side headless scans;
MCP in any form; a VS Code extension (AHP removes the need for one); any provider key anywhere.
