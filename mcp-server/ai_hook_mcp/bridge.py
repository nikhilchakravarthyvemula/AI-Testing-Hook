"""SamplingBridge — turns the harness's LLM calls into MCP sampling.

The harness pipeline is a Node subprocess; MCP sampling (`ctx.session.create_message`)
lives in this Python server's async context. This bridge is the crossing point:

  crawler (Node) → getClient('host').chat() → HTTP POST → SamplingBridge
                 → ctx.session.create_message() → host model → completion → back

A loopback HTTP server (127.0.0.1, random port) runs in a daemon thread. Each POST
carries a `token` that correlates it to the in-flight MCP request's `ctx` (a tool call
registers its ctx before spawning the pipeline). The handler hops the coroutine back to
the server's event loop with `run_coroutine_threadsafe`.
"""

from __future__ import annotations

import asyncio
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from mcp.types import SamplingMessage, TextContent


class SamplingBridge:
    def __init__(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop
        self._ctx_by_token: dict[str, object] = {}
        self._narrate: dict[str, bool] = {}
        self._calls: dict[str, int] = {}
        self._server: ThreadingHTTPServer | None = None
        self.url: str | None = None

    # ── ctx correlation ──────────────────────────────────────────────────
    def register(self, token: str, ctx: object, narrate: bool = False) -> None:
        self._ctx_by_token[token] = ctx
        self._narrate[token] = narrate
        self._calls[token] = 0

    def unregister(self, token: str) -> None:
        self._ctx_by_token.pop(token, None)
        self._narrate.pop(token, None)
        self._calls.pop(token, None)

    # ── lifecycle ────────────────────────────────────────────────────────
    def start(self) -> str:
        if self._server is not None:
            return self.url  # type: ignore[return-value]
        bridge = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):  # silence stdlib logging (would pollute stdio)
                pass

            def do_POST(self):
                try:
                    n = int(self.headers.get("content-length", 0) or 0)
                    body = json.loads(self.rfile.read(n) or b"{}")
                    ctx = bridge._ctx_by_token.get(body.get("token"))
                    if ctx is None:
                        return self._reply(400, {"error": "unknown or missing token"})
                    fut = asyncio.run_coroutine_threadsafe(bridge._sample(ctx, body), bridge._loop)
                    return self._reply(200, fut.result(timeout=180))
                except Exception as e:  # noqa: BLE001 — always answer the Node client
                    return self._reply(500, {"error": str(e)})

            def _reply(self, code, obj):
                data = json.dumps(obj).encode()
                self.send_response(code)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self._server.server_address[1]}"
        threading.Thread(target=self._server.serve_forever, daemon=True).start()
        return self.url

    # ── the sampling call (runs on the server's event loop) ──────────────
    async def _sample(self, ctx, body: dict) -> dict:
        # Counters live on the event loop (run_coroutine_threadsafe hops every
        # POST here), so per-token increments are race-free.
        token = body.get("token")
        n = self._calls.get(token, 0) + 1
        self._calls[token] = n
        narrate = self._narrate.get(token, False)

        msgs = [
            SamplingMessage(role=m.get("role", "user"),
                            content=TextContent(type="text", text=m.get("text", "")))
            for m in body.get("messages", [])
        ]
        if narrate:
            await ctx.info(f"[crawler] LLM call #{n} → sending {len(msgs)} message(s) to host")
        t0 = time.monotonic()
        resp = await ctx.session.create_message(
            messages=msgs,
            system_prompt=body.get("system"),
            max_tokens=int(body.get("maxTokens", 2048)),
        )
        if narrate:
            await ctx.info(
                f"[crawler] ← received from host in {time.monotonic() - t0:.1f}s — resuming crawler (call #{n})"
            )
        text = resp.content.text if isinstance(resp.content, TextContent) else str(resp.content)
        return {"content": text, "model": getattr(resp, "model", "host")}
