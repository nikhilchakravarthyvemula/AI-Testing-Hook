"""SubprocessStageTool — a generic BaseTool that runs a harness stage script
(a .mjs / extractor) as a child process and returns a compact JSON summary.

Lifts the proven bits of testo/harness/agentic_harness/tools/graphify/tool.py: line-streamed stdout with a
[tag] prefix, a silence heartbeat/kill, a wall-clock cap, and a small result
envelope (agents get counts + output paths, never the megabyte bundle).

Subclasses (in tools/stage_tools/) set `name`, `description`, `input_model`,
`ENTRYPOINT` (repo-relative), `RUNTIME`, and implement `build_env()` +
`summarize()`. This keeps ToolDefinition/ToolRegistry.load() unchanged — each
stage tool is just another source-file BaseTool, exactly like graphify.
"""

from __future__ import annotations

import asyncio
import json
import os
import shlex
import time
from pathlib import Path
from typing import Any

from openharness.tools.base import BaseTool, ToolResult

# subprocess_stage.py → tools → agentic_harness → harness → testo → <repo>
REPO_ROOT = Path(__file__).resolve().parents[4]
NODE_BIN = os.environ.get("NODE_BIN", "node")
_PY_VENV = REPO_ROOT / "context-layer" / "content-extractor" / "_lib" / ".venv" / "bin" / "python"


class SubprocessStageTool(BaseTool):
    """Base class for stage tools. Subclasses set the class attrs below."""

    # ── subclass configuration ──────────────────────────────────────────────
    ENTRYPOINT: str = ""          # repo-relative path to the script
    RUNTIME: str = "node"         # "node" | "python"
    HEARTBEAT_S: float = 15.0
    SILENCE_KILL_S: float = 900.0
    WALL_S: float = 3600.0

    # subclasses override these three
    def build_env(self, args: Any) -> dict[str, str | None]:
        """Return env overlay {VAR: value}; None values are left unset."""
        return {}

    def expected_outputs(self, args: Any) -> list[str]:
        """Repo-relative paths the run should (re)write — for the summary."""
        return []

    def summarize(self, exit_code: int, args: Any) -> dict:
        """Read the tool's known artifacts → {ok?, counts...}. Never raise."""
        return {}

    # ── generic execute ─────────────────────────────────────────────────────
    def _interpreter(self) -> str:
        if self.RUNTIME == "python":
            return str(_PY_VENV) if _PY_VENV.exists() else "python3"
        return NODE_BIN

    async def execute(self, arguments: Any, context: Any = None) -> ToolResult:  # noqa: ARG002
        entry = REPO_ROOT / self.ENTRYPOINT
        if not entry.exists():
            return ToolResult(
                output=json.dumps({"ok": False, "tool": self.name,
                                   "error": f"entrypoint missing: {self.ENTRYPOINT}"}),
                is_error=True,
            )

        overlay = {k: str(v) for k, v in self.build_env(arguments).items() if v is not None}
        env = {**os.environ, **overlay}
        argv = [self._interpreter(), str(entry)]
        run_start = time.time()
        tag = f"[{self.name}]"
        print(f"\n{tag} {shlex.join(argv)}"
              + (f"   env: {', '.join(overlay)}" if overlay else ""), flush=True)

        proc = await asyncio.create_subprocess_exec(
            *argv, cwd=str(REPO_ROOT), env=env,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
        )
        last_output = time.time()
        killed: str | None = None

        async def pump() -> None:
            nonlocal last_output
            assert proc.stdout is not None
            async for raw in proc.stdout:
                last_output = time.time()
                line = raw.decode("utf-8", "replace").rstrip()
                if line:
                    print(f"{tag} {line}", flush=True)

        async def watchdog() -> None:
            nonlocal killed
            while proc.returncode is None:
                await asyncio.sleep(3.0)
                now = time.time()
                if now - last_output > self.SILENCE_KILL_S:
                    killed = f"{int(self.SILENCE_KILL_S)}s silence"
                elif now - run_start > self.WALL_S:
                    killed = f"{int(self.WALL_S)}s wall-clock"
                if killed:
                    try:
                        proc.kill()
                    except ProcessLookupError:
                        pass
                    return

        await asyncio.gather(pump(), watchdog(), proc.wait())
        rc = proc.returncode if proc.returncode is not None else -1

        try:
            summary = self.summarize(rc, arguments)
        except Exception as exc:  # noqa: BLE001 — a summarizer bug must not mask the run
            summary = {"warnings": [f"summarizer error: {exc}"]}

        ok = rc == 0 and killed is None and summary.get("ok", True)
        envelope = {
            "ok": ok,
            "tool": self.name,
            "exitCode": rc,
            "durationMs": int((time.time() - run_start) * 1000),
            "outputPaths": [p for p in self.expected_outputs(arguments)
                            if (REPO_ROOT / p).exists()],
            **{k: v for k, v in summary.items() if k != "ok"},
        }
        if killed:
            envelope["error"] = f"killed after {killed}"
        return ToolResult(output=json.dumps(envelope), is_error=not ok)


def read_json(rel: str) -> dict | None:
    """Best-effort read of a repo-relative JSON file (None on any failure)."""
    try:
        return json.loads((REPO_ROOT / rel).read_text())
    except Exception:  # noqa: BLE001
        return None


__all__ = ["SubprocessStageTool", "REPO_ROOT", "read_json"]
