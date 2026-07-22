"""ai-hook MCP server.

Exposes the AI testing-hook pipeline to MCP hosts (VS Code Copilot / Cursor). The
productionized inversion: `scan` spawns the harness with `LLM_PROVIDER=host`, so the
crawler's OWN advisor (`adviseOn`) routes its LLM calls — via the sampling bridge — to
the host model. No API key here; the host owns the LLM. Run: python -m ai_hook_mcp.server
"""

from __future__ import annotations

import asyncio
import json
import os
import secrets
import time
from pathlib import Path

from mcp.server.fastmcp import Context, FastMCP

from .bridge import SamplingBridge
from .config import harness_root, output_dir
from .milestones import Narrator

mcp = FastMCP("ai-hook")
_bridge: SamplingBridge | None = None


def _get_bridge() -> SamplingBridge:
    global _bridge
    if _bridge is None:
        _bridge = SamplingBridge(asyncio.get_running_loop())
        _bridge.start()
    return _bridge


def _read(p: Path) -> dict | None:
    try:
        return json.loads(p.read_text())
    except Exception:
        return None


def _run_id() -> str:
    return f"run-{int(time.time())}-{secrets.token_hex(3)}"


_RESULT_MARKER = "[call_skill:result] "


async def _stream(argv: list[str], env: dict, cwd: Path, ctx: Context, label: str,
                  narrator: Narrator | None = None) -> tuple[int, dict | None]:
    """Run a subprocess and capture the structured result marker
    (`[call_skill:result] {json}`) if one is emitted. Without a narrator every
    log line is relayed to the host verbatim; with one, the narrator decides
    (milestones always, raw only in verbose mode)."""
    proc = await asyncio.create_subprocess_exec(
        *argv, env=env, cwd=str(cwd),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
        limit=2 ** 20,
    )
    assert proc.stdout is not None
    result: dict | None = None
    async for raw in proc.stdout:
        line = raw.decode(errors="ignore").rstrip()
        if line.startswith(_RESULT_MARKER):        # machine channel — don't echo the blob
            try:
                result = json.loads(line[len(_RESULT_MARKER):])
            except Exception:
                pass
            continue
        if narrator is not None:
            await narrator.feed(label, line)
        else:
            await ctx.info(f"[{label}] {line}")
    return await proc.wait(), result


async def _run_node(entry: Path, env: dict, ctx: Context, label: str,
                    narrator: Narrator | None = None) -> int:
    code, _ = await _stream(["node", str(entry)], env, harness_root(), ctx, label, narrator)
    return code


async def _run_skill(skill: str, kv: dict, env: dict, ctx: Context, label: str,
                     narrator: Narrator | None = None) -> tuple[int, dict]:
    """Invoke a deterministic harness skill via call_skill.py (no LLM).
    Returns (exit_code, structured_result) — the result is the skill's own payload."""
    root = harness_root()
    py = root / "context-layer" / "content-extractor" / "_lib" / ".venv" / "bin" / "python"
    call = root / "testo" / "skill-register" / "bin" / "call_skill.py"
    argv = [str(py), str(call), skill, "--mode", "direct", "--json"]
    for k, v in kv.items():
        if v not in (None, "", 0):
            argv += [f"--{k}", str(v)]
    code, result = await _stream(argv, env, root, ctx, label, narrator)
    return code, (result or {})


def _host_env(bridge: SamplingBridge, run_id: str, url: str, codebase: str,
              extra_skip: list[str] | None = None) -> dict:
    """Pipeline env for a host-sampled scan. Graphify is NOT skipped — it is
    deterministic now and gated on TARGET_CODEBASE by run.mjs itself."""
    env = dict(os.environ)
    env.update({
        "LLM_PROVIDER": "host",            # crawler adviseOn → host model
        "SAMPLING_BRIDGE_URL": bridge.url,
        "SAMPLING_TOKEN": run_id,
        "CRAWLER_LLM": "1",                # LLM on — but it's the host's now
    })
    if url:
        env["BASE_URL"] = url
    if codebase:
        env["TARGET_CODEBASE"] = str(Path(codebase).resolve())
    skip = list(extra_skip or []) + ([] if url else ["crawler"])
    existing = [s for s in (env.get("SKIP", "").split(",")) if s]
    merged = [s for s in dict.fromkeys(existing + skip)]
    if merged:
        env["SKIP"] = ",".join(merged)
    else:
        env.pop("SKIP", None)
    return env


async def _scan_pipeline(ctx: Context, env: dict, narrator: Narrator | None) -> list[dict]:
    """Run extract + index with the given env; returns the stage results."""
    root = harness_root()
    stages = []
    c1 = await _run_node(root / "context-layer" / "content-extractor" / "run.mjs", env, ctx, "extract", narrator)
    stages.append({"id": "content-extractor", "ok": c1 == 0, "exit": c1})
    if c1 == 0:
        c2 = await _run_node(root / "context-layer" / "indexer" / "index.mjs", env, ctx, "index", narrator)
        stages.append({"id": "indexer", "ok": c2 == 0, "exit": c2})
    return stages


# ── scan: run the pipeline; the crawler classifies via HOST sampling ──────────
@mcp.tool()
async def scan(ctx: Context, url: str = "", codebase: str = "", reuse: bool = False) -> dict:
    """Discover a live web app (+ optional codebase) into structured test context.

    The pipeline runs the deterministic crawl/extract/index (including the graphify
    code knowledge graph when a codebase is given), and the crawler's own click-intent
    classification is powered by YOUR host model via MCP sampling (LLM_PROVIDER=host)
    — no API key. `reuse=true` skips the whole pipeline and reads existing output/.
    Returns a run summary + the indexed topics."""
    if not url and not codebase:
        return {"ok": False, "error": "scan needs url or codebase"}
    run_id = _run_id()
    bridge = _get_bridge()
    bridge.register(run_id, ctx)          # the bridge samples THIS ctx for this run
    try:
        stages = []
        if not reuse:
            await ctx.info("running content-extractor (crawler classifies via host sampling)…")
            env = _host_env(bridge, run_id, url, codebase)
            stages = await _scan_pipeline(ctx, env, narrator=None)
        else:
            await ctx.info("reuse: reading existing output/")

        idx = _read(output_dir() / "indexed_output" / "index.json") or {}
        ok = all(s["ok"] for s in stages) if stages else True
        return {
            "ok": ok, "run_id": run_id, "mode": "host-sampling",
            "target": {"baseUrl": url or None, "codebase": codebase or None},
            "stages": stages,
            "topics": idx.get("topics", {}),
            "consumable": "output/indexed_output/",
        }
    finally:
        bridge.unregister(run_id)


# ── test_app: the narrated end-to-end loop (scan → graphify → generate → execute)
@mcp.tool()
async def test_app(ctx: Context, url: str, codebase: str = "",
                   login_email: str = "", login_password: str = "",
                   max_tests: int = 0, reuse: bool = False, verbose: bool = False) -> dict:
    """Test a live web app end-to-end (the run_all pipeline): scan it (crawler
    classifies clickables via YOUR host model; graphify builds the code knowledge
    graph when a codebase is given) → index → generate API tests → EXECUTE them
    against the live target → combined summary.

    Narrates each milestone as it happens ([scanner]/[crawler]/[graphify]/
    [generator]/[executor] lines); `verbose=true` adds the raw pipeline log
    (capped). `reuse=true` skips only the crawl and keeps everything else fresh
    (unlike scan.reuse, which skips the whole pipeline). Login credentials are
    forwarded to the test runner via environment variables, never argv."""
    if not url:
        return {"ok": False, "error": "test_app needs url — tests execute against the live target"}
    run_id = _run_id()
    bridge = _get_bridge()
    nar = Narrator(ctx, verbose=verbose)
    bridge.register(run_id, ctx, narrate=True)   # sampling round-trips narrate too
    try:
        await nar.say(f"[scanner] starting scan of {url}" + (f" + codebase {codebase}" if codebase else ""))
        env = _host_env(bridge, run_id, url, codebase)
        if reuse:
            existing = [s for s in (env.get("SKIP", "").split(",")) if s]
            env["SKIP"] = ",".join(dict.fromkeys(existing + ["crawler"]))
            await nar.say("[crawler] reuse: keeping the existing crawl output")

        stages = await _scan_pipeline(ctx, env, narrator=nar)

        def _partial(error: str) -> dict:
            idx_now = _read(output_dir() / "indexed_output" / "index.json") or {}
            return {"ok": False, "partial": True, "run_id": run_id, "stages": stages,
                    "error": error, "topics": idx_now.get("topics", {})}

        if not all(s["ok"] for s in stages):
            await nar.say("[scanner] pipeline FAILED — aborting (not generating tests from a stale index)")
            await nar.finish()
            return _partial("scan/index failed — see stages")
        if not (output_dir() / "indexed_output" / "apis.json").is_file():
            await nar.finish()
            return _partial("indexing produced no apis.json")

        await nar.say("[generator] starting — building API tests from the indexed context")
        env2 = dict(os.environ)
        if login_email:                    # secrets via env, never argv
            env2["LOGIN_EMAIL"] = login_email
        if login_password:
            env2["LOGIN_PASSWORD"] = login_password
        kv = {"execute": "true", "base_url": url, "max_tests": max_tests or None}
        code, r = await _run_skill("api-test-generator", kv, env2, ctx, "test", nar)
        stages.append({"id": "api-tests", "ok": code == 0 and bool(r.get("ok")), "exit": code})

        await nar.say(f"[generator] {r.get('curls_generated', 0)} curls generated → output/generation/api-tests/curls/")
        await nar.say(f"[executor] {r.get('curls_executed', 0)} tests run — {r.get('passed', 0)} passed, "
                      f"{r.get('failed', 0)} failed, {r.get('skipped', 0)} skipped")
        await nar.finish()

        idx = _read(output_dir() / "indexed_output" / "index.json") or {}
        return {
            "ok": all(s["ok"] for s in stages), "run_id": run_id, "mode": "host-sampling",
            "target": {"baseUrl": url, "codebase": codebase or None},
            "stages": stages,
            "topics": idx.get("topics", {}),
            "tests_generated": r.get("curls_generated"),
            "executed": r.get("curls_executed"),
            "passed": r.get("passed"),
            "failed": r.get("failed"),
            "skipped": r.get("skipped"),
            "loginOk": r.get("login_succeeded"),
            "error": r.get("error"),
            "paths": {
                "indexed": "output/indexed_output/",
                "tests": "output/generation/api-tests/",
                "results": "output/generation/api-tests/results.json",
                "report": "output/generation/api-tests/report.md",
                "graph": "output/graphify/graph.json" if codebase else None,
            },
        }
    finally:
        bridge.unregister(run_id)


# ── generate: build API tests from the indexed context (deterministic) ────────
@mcp.tool()
async def generate(ctx: Context, url: str = "", max_tests: int = 0,
                   login_email: str = "", login_password: str = "") -> dict:
    """Generate curl-based API tests from the indexed context (needs a prior `scan`).
    Deterministic — no LLM. Writes output/generation/api-tests/ but does NOT run them."""
    if not (output_dir() / "indexed_output" / "apis.json").is_file():
        return {"ok": False, "error": "no output/indexed_output/apis.json — run `scan` first"}
    env = dict(os.environ)
    if login_email:                       # secrets via env, never argv (avoids ps/stdout leak)
        env["LOGIN_EMAIL"] = login_email
    if login_password:
        env["LOGIN_PASSWORD"] = login_password
    kv = {"execute": "false", "base_url": url or None, "max_tests": max_tests or None}
    await ctx.info("generating API tests (curls only)…")
    code, r = await _run_skill("api-test-generator", kv, env, ctx, "generate")
    return {
        "ok": code == 0 and bool(r.get("ok")),
        "tests_generated": r.get("curls_generated"),
        "error": r.get("error"),
        "output": "output/generation/api-tests/",
        "results": "output/generation/api-tests/results.json",
    }


# ── execute: run the API tests against the live target (deterministic) ─────────
@mcp.tool()
async def execute(ctx: Context, url: str = "", max_tests: int = 0,
                  login_email: str = "", login_password: str = "") -> dict:
    """Generate + RUN the API tests against the live target (needs a prior `scan`).
    Deterministic — no LLM. Returns pass/fail counts + the results path."""
    if not (output_dir() / "indexed_output" / "apis.json").is_file():
        return {"ok": False, "error": "no output/indexed_output/apis.json — run `scan` first"}
    env = dict(os.environ)
    if login_email:
        env["LOGIN_EMAIL"] = login_email
    if login_password:
        env["LOGIN_PASSWORD"] = login_password
    kv = {"execute": "true", "base_url": url or None, "max_tests": max_tests or None}
    await ctx.info("generating + executing API tests against the live target…")
    code, r = await _run_skill("api-test-generator", kv, env, ctx, "execute")
    return {
        "ok": code == 0 and bool(r.get("ok")),
        "executed": r.get("curls_executed"),
        "passed": r.get("passed"),
        "failed": r.get("failed"),
        "skipped": r.get("skipped"),
        "loginSucceeded": r.get("login_succeeded"),
        "error": r.get("error"),
        "results": "output/generation/api-tests/results.json",
        "report": "output/generation/api-tests/report.md",
    }


# ── context: read back the consumable indexed context ────────────────────────
@mcp.tool()
async def context(topic: str = "") -> dict:
    """Return the consumable indexed context (or one topic: apis|pages|click-graph|…)."""
    idx = _read(output_dir() / "indexed_output" / "index.json")
    if not idx:
        return {"ok": False, "error": "no indexed_output — run scan first"}
    if topic:
        meta = (idx.get("topics") or {}).get(topic)
        if not meta:
            return {"ok": False, "error": f"unknown topic {topic!r}. Have: {list(idx.get('topics', {}))}"}
        data = _read(output_dir() / "indexed_output" / meta["file"]) or {}
        return {"ok": True, "topic": topic, "count": meta.get("count"), "items": data.get("items", data)}
    return {"ok": True, "target": idx.get("target"), "topics": idx.get("topics", {})}


def main() -> None:
    mcp.run()  # stdio transport


if __name__ == "__main__":
    main()
