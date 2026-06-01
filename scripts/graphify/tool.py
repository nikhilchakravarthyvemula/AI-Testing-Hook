"""Drive graphify by registering it as a SINGLE custom tool the LLM calls.

Mode "tool": defines a Python wrapper around the `graphify` CLI as the only
tool in the registry. The LLM's job reduces to "call graphify(path)" — no
multi-step orchestration, no need for bash/file/glob. This works on much
smaller local models (llama3.1:8b handles single-tool tasks fine).

Use this when:
  * You want a deterministic single-shot graphify run
  * You're testing local-model tool-calling support
  * You don't want to expose bash/file tools to the LLM

Defaults:
    model:   llama3.1:8b via local Ollama  (set OPENHARNESS_MODEL to change)
    api key: literal "ollama" (no real key needed for local Ollama)

Override to Gemini:
    OPENHARNESS_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/ \\
    OPENHARNESS_MODEL=gemini-2.5-flash \\
    OPENHARNESS_API_KEY_ENV=GEMINI_API_KEY \\
        python tool.py /path/to/target

Note: per session memory, graphify is a TOOL — the wrapper below makes that
literal by exposing it as a Python tool the LLM can call directly.
"""
from __future__ import annotations

import asyncio
import os
import shlex
import shutil
import sys
from pathlib import Path

from pydantic import BaseModel, Field

from openharness.api.openai_client import OpenAICompatibleClient
from openharness.config.settings import PermissionMode, PermissionSettings
from openharness.engine.query_engine import QueryEngine
from openharness.engine.stream_events import (
    AssistantTextDelta,
    AssistantTurnComplete,
    ErrorEvent,
    ToolExecutionCompleted,
    ToolExecutionStarted,
)
from openharness.permissions.checker import PermissionChecker
from openharness.tools.base import (
    BaseTool, ToolExecutionContext, ToolRegistry, ToolResult,
)

OPENHARNESS_BASE_URL = os.environ.get("OPENHARNESS_BASE_URL") or "http://localhost:11434/v1"
OPENHARNESS_MODEL = os.environ.get("OPENHARNESS_MODEL") or "llama3.1:8b"
OPENHARNESS_API_KEY_ENV = os.environ.get("OPENHARNESS_API_KEY_ENV", "NOT_SET_OK")
GRAPHIFY_BIN = os.environ.get("GRAPHIFY_BIN", "graphify")


def load_env_walk_up(target: Path) -> None:
    """Find .env by walking up parents from target. Loads GEMINI_API_KEY /
    GOOGLE_API_KEY / OPENAI_API_KEY / KIMI_API_KEY into os.environ unless
    they're already set.
    """
    keys = {
        "GEMINI_API_KEY", "GOOGLE_API_KEY",
        "OPENAI_API_KEY", "KIMI_API_KEY",
        "MINIMAX_API_KEY", "MINIMAX_GROUP_ID",
        "MINIMAX_MODEL", "MINIMAX_REGION",
        "GRAPHIFY_TOKEN_BUDGET",
        "GRAPHIFY_GEMINI_MODEL", "GRAPHIFY_MINIMAX_MODEL",
    }
    if all(os.environ.get(k) for k in keys):
        return
    cur = target.resolve()
    for _ in range(8):
        env_path = cur / ".env"
        if env_path.is_file():
            for raw in env_path.read_text().splitlines():
                line = raw.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, _, v = line.partition("=")
                k = k.strip()
                v = v.strip().strip('"').strip("'")
                if k in keys and v and not os.environ.get(k):
                    os.environ[k] = v
            return
        if cur.parent == cur:
            break
        cur = cur.parent


def _auto_backend() -> str:
    """Pick a backend if the user didn't choose one.

    Preference order:
      1. Hosted models with an API key in env (cheap, fast, reliable JSON)
      2. Local ollama (free, slower, JSON-mode flaky on small models)

    Keeping this in a function (not module-level) so .env files loaded
    later in run() still get picked up before we make the choice.
    """
    # Gemini deliberately disabled — user opted out 2026-05-20 to avoid
    # accidental paid Gemini calls. Re-enable by uncommenting AND removing
    # the matching guard in scripts/graphify/tool.py:_assert_backend_allowed
    # and in interfaces/cli/commands/scan.mjs.
    # if os.environ.get("GEMINI_API_KEY"):
    #     return "gemini"
    if os.environ.get("MINIMAX_API_KEY"):
        return "minimax"
    if os.environ.get("OPENAI_API_KEY"):
        return "openai"
    if os.environ.get("ANTHROPIC_API_KEY"):
        return "claude"
    if os.environ.get("KIMI_API_KEY"):
        return "kimi"
    return "ollama"


def _assert_backend_allowed(backend: str) -> None:
    """Hard-stop guard. Any explicit attempt to use Gemini errors out.

    This is a belt-and-braces safety: even if GRAPHIFY_BACKEND=gemini
    sneaks in (env, .env, command line), the run refuses to proceed.
    Lifted by uncommenting this block + the gemini lines elsewhere.
    """
    if backend == "gemini":
        print(
            "\n[graphify] ERROR: backend 'gemini' is disabled in this checkout.\n"
            "[graphify] Re-enable by editing scripts/graphify/tool.py "
            "(see comments near _auto_backend / _assert_backend_allowed).\n"
            "[graphify] Currently allowed backends: minimax, openai, claude, kimi, ollama.",
            file=sys.stderr,
        )
        sys.exit(2)


# Heuristic for cross-backend model mismatch detection. Match the
# obvious naming families — if a model looks like it belongs to a
# different family than the chosen backend, we warn + fall back.
_BACKEND_MODEL_PREFIXES = {
    "gemini":  ("gemini-", "models/gemini-"),
    "minimax": ("MiniMax", "abab"),
    "openai":  ("gpt-", "o1-", "o3-", "o4-"),
    "claude":  ("claude-",),
    "kimi":    ("moonshot-", "kimi-"),
    "ollama":  (),   # any local model name is fine — no prefix check
}


def _model_is_compatible(model: str, backend: str) -> bool:
    """True if `model` looks like it belongs to `backend`. Conservative —
    returns True when we can't tell (e.g. ollama, or unknown backend)."""
    prefixes = _BACKEND_MODEL_PREFIXES.get(backend)
    if not prefixes:
        return True  # ollama or unknown — don't second-guess the user
    return any(model.startswith(p) for p in prefixes)


# Default model per backend. User can override via GRAPHIFY_MODEL.
_DEFAULT_MODELS = {
    "gemini":  "gemini-2.5-flash",
    "minimax": "MiniMax-Text-01",
    "openai":  "gpt-4o-mini",
    "claude":  "claude-3-5-haiku-20241022",
    "kimi":    "moonshot-v1-32k",
    "ollama":  "llama3.1:8b",
}

# Default concurrency per backend. Local LLMs serialize cleanly at 1;
# hosted backends shine with parallel chunks.
_DEFAULT_CONCURRENCY = {
    "gemini":  "4",
    "minimax": "4",
    "openai":  "4",
    "claude":  "4",
    "kimi":    "4",
    "ollama":  "1",
}

GRAPHIFY_BACKEND = os.environ.get("GRAPHIFY_BACKEND")  # may be None; resolved in run()
GRAPHIFY_MODEL = os.environ.get("GRAPHIFY_MODEL")
GRAPHIFY_MAX_CONCURRENCY = os.environ.get("GRAPHIFY_MAX_CONCURRENCY")
GRAPHIFY_TIMEOUT_S = int(os.environ.get("GRAPHIFY_TIMEOUT_S", "900"))
# Per-chunk INPUT token cap. Graphify's default is 60000 — which expects
# ~16K output tokens to fit the response. When the LLM is verbose (we saw
# this happen with Gemini 2.5 Flash drifting over time), the JSON gets
# truncated mid-string and json.loads fails with "Unterminated string".
# Lowering this shrinks each chunk so the response fits. Sensible values:
#   60000 — graphify default, fast when LLM is terse
#   30000 — safe for verbose models, ~2× more LLM calls
#   20000 — very safe, ~3× more LLM calls
GRAPHIFY_TOKEN_BUDGET = os.environ.get("GRAPHIFY_TOKEN_BUDGET")
# Optional: redirect graphify-out to a custom location AND force a fresh
# (non-incremental) run. If unset, graphify writes <target>/graphify-out as
# usual and reuses any existing cache there.
GRAPHIFY_OUT_DIR = os.environ.get("GRAPHIFY_OUT_DIR")


class GraphifyArgs(BaseModel):
    path: str = Field(..., description="Absolute path of the folder to graphify")


class GraphifyTool(BaseTool):
    name = "graphify"
    description = (
        "Build a knowledge graph for a folder by running `graphify extract <path>` "
        "(headless full extraction: AST + semantic LLM). Produces graphify-out/ "
        "inside the target path."
    )
    input_model = GraphifyArgs

    async def execute(self, arguments: GraphifyArgs, context: ToolExecutionContext) -> ToolResult:
        target = Path(arguments.path).resolve()
        target_out = target / "graphify-out"

        # Resolve backend / model / concurrency HERE so the tool works
        # regardless of how it's invoked. Previously these were resolved
        # in tool.py:run() (the legacy `python tool.py <path>` path);
        # callers that bypass run() — like the agentic-harness service
        # calling execute() directly — would see backend=None and the
        # subprocess argv would contain `--backend ''` → graphify barfs
        # with "expected str, bytes or os.PathLike object, not NoneType".
        _resolve_runtime_config(target)

        # Banner — tells the user what's about to happen so they don't
        # think we're stuck on the [tool→] line.
        print(
            "\n[graphify] starting full extraction pipeline\n"
            f"[graphify]   target:    {target}\n"
            f"[graphify]   backend:   {GRAPHIFY_BACKEND}\n"
            f"[graphify]   model:     {GRAPHIFY_MODEL}\n"
            f"[graphify]   timeout:   {GRAPHIFY_TIMEOUT_S}s per step\n"
            f"[graphify]   concurrency: {GRAPHIFY_MAX_CONCURRENCY}\n"
            f"[graphify]   token-budget: {GRAPHIFY_TOKEN_BUDGET or '60000 (graphify default)'}\n"
            f"[graphify]   steps:     1/extract  2/cluster-only  3/tree\n"
            "[graphify] streaming step output below — each line prefixed with [graphify:<step>]",
            flush=True,
        )

        # If GRAPHIFY_OUT_DIR is set, we want a FRESH run that does NOT
        # pollute the target's existing graphify-out cache. Strategy:
        #   1. Move target/graphify-out → /tmp/graphify-backup-<ts>
        #   2. Run extract + cluster-only + tree (all write to target/graphify-out)
        #   3. Move new target/graphify-out → GRAPHIFY_OUT_DIR
        #   4. Restore backup → target/graphify-out
        # Net effect: target unchanged, all artifacts at requested destination.
        import time
        dest_path = Path(GRAPHIFY_OUT_DIR).resolve() if GRAPHIFY_OUT_DIR else None
        backup_path = None
        if dest_path:
            dest_path.parent.mkdir(parents=True, exist_ok=True)
            if dest_path.exists():
                shutil.rmtree(dest_path)
            if target_out.exists():
                backup_path = target.parent / f".graphify-backup-{int(time.time())}"
                shutil.move(str(target_out), str(backup_path))

        combined_log = ""

        async def run_step(label, argv):
            """Run one graphify subcommand, streaming output to console in real time.

            We DON'T use proc.communicate() because that buffers everything
            until the subprocess exits — graphify's extract step can take
            many minutes, and the user would see nothing during it, making
            the whole run look hung. Instead we read stdout line-by-line
            and prefix each line with [graphify:<step>] so the user knows
            (a) something is happening and (b) which step is happening.
            """
            nonlocal combined_log
            cmd_str = shlex.join(argv)
            header = f"\n========== {label} ==========\n[$] {cmd_str}\n"
            combined_log += header
            tag = f"[graphify:{label.split(' ')[0]}]"
            print(f"\n{tag} starting — {cmd_str}", flush=True)

            proc = await asyncio.create_subprocess_exec(
                *argv,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )

            start = asyncio.get_event_loop().time()
            last_output_at = start

            # Heartbeat: every 15s of silence, print an elapsed marker so
            # the user knows the process is still alive even if graphify
            # itself isn't logging anything (e.g. waiting on an LLM call).
            stop_heartbeat = asyncio.Event()

            async def heartbeat():
                while not stop_heartbeat.is_set():
                    try:
                        await asyncio.wait_for(stop_heartbeat.wait(), timeout=15.0)
                    except asyncio.TimeoutError:
                        idle = asyncio.get_event_loop().time() - last_output_at
                        elapsed = asyncio.get_event_loop().time() - start
                        if idle >= 15.0:
                            print(
                                f"{tag} still running — {int(elapsed)}s elapsed "
                                f"(silent for {int(idle)}s)",
                                flush=True,
                            )

            hb_task = asyncio.create_task(heartbeat())

            try:
                while True:
                    try:
                        line = await asyncio.wait_for(
                            proc.stdout.readline(),
                            timeout=GRAPHIFY_TIMEOUT_S,
                        )
                    except asyncio.TimeoutError:
                        proc.kill()
                        await proc.wait()
                        combined_log += f"[TIMEOUT after {GRAPHIFY_TIMEOUT_S}s]\n"
                        print(f"{tag} TIMEOUT after {GRAPHIFY_TIMEOUT_S}s", flush=True)
                        return -1
                    if not line:
                        break
                    decoded = line.decode("utf-8", errors="replace").rstrip("\n")
                    combined_log += decoded + "\n"
                    print(f"{tag} {decoded}", flush=True)
                    last_output_at = asyncio.get_event_loop().time()
                rc = await proc.wait()
            finally:
                stop_heartbeat.set()
                try:
                    await hb_task
                except Exception:  # noqa: BLE001
                    pass

            duration = asyncio.get_event_loop().time() - start
            print(
                f"{tag} done in {duration:.1f}s (exit={rc})",
                flush=True,
            )
            return rc

        try:
            # ----- step 1: extract (AST + semantic LLM → graph.json) -----
            #
            # Graphify natively supports gemini|kimi|claude|openai|ollama|bedrock.
            # MiniMax is added via scripts/graphify/with_minimax.py — a launcher
            # that registers a `minimax` backend at runtime, then forwards to
            # graphify's CLI. We invoke that launcher via the same Python
            # interpreter that has graphify installed.
            if GRAPHIFY_BACKEND == "minimax":
                graphify_python = shutil.which("graphify") or GRAPHIFY_BIN
                # Resolve the pipx venv's python alongside the graphify entrypoint.
                # Pipx layout: <venv>/bin/graphify  →  <venv>/bin/python
                gp = Path(graphify_python).resolve()
                py = (gp.parent / "python")
                if not py.exists():
                    py = Path(sys.executable)  # fallback
                launcher = Path(__file__).resolve().parent / "with_minimax.py"
                extract_cmd = [
                    str(py), str(launcher), "extract", str(target),
                    "--backend", "minimax",
                    "--model", GRAPHIFY_MODEL,
                    "--max-concurrency", GRAPHIFY_MAX_CONCURRENCY,
                ]
            else:
                extract_cmd = [
                    GRAPHIFY_BIN, "extract", str(target),
                    "--backend", GRAPHIFY_BACKEND,
                    "--model", GRAPHIFY_MODEL,
                    "--max-concurrency", GRAPHIFY_MAX_CONCURRENCY,
                ]
            if GRAPHIFY_TOKEN_BUDGET:
                extract_cmd.extend(["--token-budget", GRAPHIFY_TOKEN_BUDGET])
            rc = await run_step("extract", extract_cmd)
            if rc != 0:
                return ToolResult(
                    output=combined_log[-8000:],
                    is_error=True,
                    metadata={"cmd": shlex.join(extract_cmd), "exit_code": rc},
                )

            graph_json = target_out / "graph.json"

            # ----- step 2: cluster-only (regenerates GRAPH_REPORT.md + graph.html) -----
            if graph_json.exists():
                await run_step(
                    "cluster-only (report + interactive graph.html)",
                    [GRAPHIFY_BIN, "cluster-only", str(target), "--graph", str(graph_json)],
                )

            # ----- step 3: tree (D3 collapsible tree HTML) -----
            if graph_json.exists():
                await run_step(
                    "tree (collapsible tree HTML)",
                    [
                        GRAPHIFY_BIN, "tree",
                        "--graph", str(graph_json),
                        "--output", str(target_out / "GRAPH_TREE.html"),
                        "--root", str(target),
                    ],
                )

            # ----- step 4: move target_out → dest, restore backup -----
            move_note = ""
            if dest_path and target_out.exists():
                shutil.move(str(target_out), str(dest_path))
                move_note = f"\n[wrapper] moved {target_out} → {dest_path}"
        finally:
            if backup_path and backup_path.exists() and not target_out.exists():
                shutil.move(str(backup_path), str(target_out))
                move_note += f"\n[wrapper] restored target backup → {target_out}"

        final_dir = dest_path if dest_path else target_out
        artifacts = sorted(p.name for p in final_dir.iterdir() if p.is_file())[:30] if final_dir.exists() else []
        summary = f"\n[wrapper] artifacts in {final_dir}:\n  " + "\n  ".join(artifacts)

        return ToolResult(
            output=combined_log[-10000:] + move_note + summary,
            is_error=False,
            metadata={"output_dir": str(final_dir)},
        )


def _resolve_runtime_config(target: Path) -> None:
    """Populate module-level GRAPHIFY_* globals.

    Idempotent — calling twice is fine. Loads .env from target's parent
    walk-up first, then fills in any None globals with auto-detected
    defaults. Both `run()` (legacy path) and `GraphifyTool.execute()`
    (agentic-harness path) call this, so the tool works no matter who
    invokes it.
    """
    global GRAPHIFY_BACKEND, GRAPHIFY_MODEL, GRAPHIFY_MAX_CONCURRENCY

    load_env_walk_up(target)
    have = [k for k in ("GEMINI_API_KEY", "OPENAI_API_KEY", "KIMI_API_KEY", "MINIMAX_API_KEY") if os.environ.get(k)]
    if have:
        print(f"[boot] loaded API key(s): {have}", flush=True)

    if not GRAPHIFY_BACKEND:
        GRAPHIFY_BACKEND = _auto_backend()
    _assert_backend_allowed(GRAPHIFY_BACKEND)

    # Model resolution priority:
    #   1. GRAPHIFY_MODEL    — explicit cross-backend override (e.g. testo --model)
    #   2. GRAPHIFY_<BACKEND>_MODEL — per-backend pin (matches graphify's own convention)
    #   3. _DEFAULT_MODELS[backend] — sensible per-backend default
    # Skipping #1 if its value doesn't match the chosen backend prevents
    # the "gemini-2.5-flash on MiniMax" foot-gun.
    if not GRAPHIFY_MODEL:
        per_backend_key = f"GRAPHIFY_{GRAPHIFY_BACKEND.upper()}_MODEL"
        GRAPHIFY_MODEL = (
            os.environ.get(per_backend_key)
            or _DEFAULT_MODELS.get(GRAPHIFY_BACKEND, "llama3.1:8b")
        )
    elif not _model_is_compatible(GRAPHIFY_MODEL, GRAPHIFY_BACKEND):
        per_backend_key = f"GRAPHIFY_{GRAPHIFY_BACKEND.upper()}_MODEL"
        fallback = (
            os.environ.get(per_backend_key)
            or _DEFAULT_MODELS.get(GRAPHIFY_BACKEND, "llama3.1:8b")
        )
        print(
            f"[boot] WARNING: GRAPHIFY_MODEL={GRAPHIFY_MODEL!r} doesn't match "
            f"backend={GRAPHIFY_BACKEND}. Falling back to {fallback!r}. "
            f"Set {per_backend_key} or pass --model to override.",
            flush=True,
        )
        GRAPHIFY_MODEL = fallback

    if not GRAPHIFY_MAX_CONCURRENCY:
        GRAPHIFY_MAX_CONCURRENCY = _DEFAULT_CONCURRENCY.get(GRAPHIFY_BACKEND, "1")

    print(
        f"[boot] resolved backend={GRAPHIFY_BACKEND} model={GRAPHIFY_MODEL} "
        f"concurrency={GRAPHIFY_MAX_CONCURRENCY}",
        flush=True,
    )


async def run(target: str) -> None:
    _resolve_runtime_config(Path(target))

    # We DO NOT route through OpenHarness's QueryEngine here. We used to,
    # to be cute about "an agent decides to call the graphify tool". In
    # practice the only available local agent (llama3.1:8b) routinely
    # hallucinated the tool's argument shape — passing {'<path>': ...}
    # literally with angle brackets, which pydantic rejected, and the
    # tool was never invoked. The user-visible failure mode was worse
    # than the bug itself: the agent then declared success, and our
    # wrapper happily read a STALE graph.json on disk and reported it.
    #
    # There is no LLM "decision" to make: we know the path, we know we
    # want to graphify it. Direct call. If we ever want a real agent
    # later, it can wrap this same call.
    print(
        f"[boot] calling GraphifyTool directly (no LLM agent in the loop)",
        flush=True,
    )

    tool = GraphifyTool()
    args = GraphifyArgs(path=target)
    print(
        f"\n[tool→] graphify({{'path': {target!r}}})\n"
        f"[tool→] this can take several minutes; live output follows…",
        flush=True,
    )
    try:
        # GraphifyTool.execute doesn't use `context` for anything we care
        # about — pass None and let the type checker grumble. If openharness
        # ever starts using context for cancellation, swap in a real one.
        result = await tool.execute(args, context=None)  # type: ignore[arg-type]
    except Exception as exc:  # noqa: BLE001
        print(f"\n[tool← graphify err=True]\nException: {exc!r}", flush=True)
        sys.exit(1)

    tail = (result.output or "")[-600:]
    print(
        f"\n[tool← graphify err={result.is_error}]"
        f"\n----- last 600 chars of tool output -----\n{tail}"
        f"\n-----------------------------------------",
        flush=True,
    )
    if result.is_error:
        sys.exit(1)
    print("\n[done]", flush=True)


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else os.getcwd()
    asyncio.run(run(target))
