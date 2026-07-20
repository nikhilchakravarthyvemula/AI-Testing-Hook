#!/usr/bin/env python
"""testo — an interactive, Claude-CLI-style front door for the testing harness.

Multi-turn conversation with the agent; it plans and calls the harness tools
(bash / read / grep / glob / graphify / … and the scan/generate/execute/report
tools as they land), streaming activity to the terminal the way Claude Code does:

    › find where BASE_URL is read
    ⏺ Grep(BASE_URL)
      ⎿ 6 matches
    ⏺ Read(context-layer/content-extractor/crawler/crawl.mjs)
      ⎿ Read 43 lines
    The crawler reads BASE_URL at crawl.mjs:43 …

Run:  ./testo/testo         (or  python testo/repl.py )
Slash commands:  /help /tools /model /backend /clear /usage /cwd /exit
"""

from __future__ import annotations

import asyncio
import os
import shlex
from pathlib import Path

import bootstrap  # noqa: F401 — MUST be first: sets sys.path + loads .env

from rich.console import Console
from prompt_toolkit import PromptSession
from prompt_toolkit.history import FileHistory

from render import Renderer
from tools_list import render_table

from agentic_harness import ToolRegistry  # noqa: E402
from agentic_harness.services.harness_service import AgenticHarness  # noqa: E402
from agentic_harness.tools.standard_toolbelt import build_toolbelt  # noqa: E402

HARNESS_SYSTEM_PROMPT = (
    "You are testo, the interactive agent for an AI testing harness. You help "
    "the user explore this repo and drive its testing pipeline. You have a "
    "toolbelt: bash, read_file, write_file, edit_file, glob, grep, todo_write, "
    "agent, plus custom harness tools (graphify today; scan/generate/execute/"
    "report tools as they are registered). Prefer read-only exploration (grep, "
    "read_file, glob) to answer questions about the code. When the user asks to "
    "run part of the pipeline, use the matching custom tool. Act with the tools "
    "rather than only describing what you would do; when done, give a short "
    "summary. If a tool errors, read the message and adapt."
)


_SCAN_HELP = """/scan — discover everything about a target (full context-layer run)

Usage:
  /scan --url <URL> [--sso] [--email E --pass P] [--codebase PATH]
  /scan <URL>                       (bare URL works too)

Options:
  --url <URL>           live link to crawl (drives the crawler)
  --sso                 interactive SSO login first: opens a headed browser,
                        auto-fills --email/--pass, lets you finish MFA/CAPTCHA
                        by hand, saves the session, then crawls with it.
                        Omit for plain login pages (creds filled inline).
  --email <EMAIL>       login email/username (alias: --user)
  --pass <PASS>         login password
  --codebase <PATH>     local repo path (drives graphify + per-framework extractors)
  --backend <NAME>      LLM backend for graphify (default: auto)
                          auto    — picks minimax → … → local based on keys present
                          minimax — MiniMax via Token Plan (fast)
                          local   — local ollama (free, slow)
                        (gemini is intentionally disabled in this checkout)
  --model <NAME>        override the model for the chosen backend
  --only <ids>          comma-separated extractor ids to run
  --skip <ids>          comma-separated extractor ids to skip
  -h, --help            show this help

Examples:
  /scan --codebase /Users/me/myrepo
  /scan --url http://localhost:3000 --user admin --pass secret
  /scan --url https://console-preview.superalign.ai --sso --email you@x.com --pass 'pw'

For a crawl-only pass without the orchestrator, use /crawl <url> instead."""

_GENERATE_HELP = """/generate <kind> [options] — generation-layer entrypoint

Kinds:
  api-tests       Build + run curl-based API tests against the live target.

Options:
  --url <URL>            target API base URL (defaults to crawler bundle's first API origin)
  --user <USER>          login email/username (skill skips login if absent)
  --pass <PASS>          login password
  --output-dir <PATH>    where to write generated tests + results
  --max-tests <N>        cap the number of APIs to test
  --timeout <SECONDS>    per-curl timeout (default: 30)
  --no-execute           generate the curl scripts but don't run them
  -h, --help             show this help

Examples:
  /generate api-tests --url http://localhost:3000 --user admin --pass secret
  /generate api-tests --no-execute
  /generate api-tests --max-tests 5"""


def _load_custom_tools() -> list:
    reg = ToolRegistry()
    tools = []
    for name in reg.list_tools():
        try:
            tool, _ = reg.load(name)
            tools.append(tool)
        except Exception as exc:  # noqa: BLE001 — a broken row shouldn't kill startup
            Console().print(f"[yellow]! skipped tool '{name}': {exc}[/]")
    return tools


class Repl:
    def __init__(self) -> None:
        self.console = Console()
        self.custom_tools = _load_custom_tools()
        os.chdir(bootstrap.REPO_ROOT)  # tools operate from the repo root
        self.harness = AgenticHarness(
            registry=build_toolbelt(self.custom_tools),
            system_prompt=HARNESS_SYSTEM_PROMPT,
            max_turns=40,
            cwd=bootstrap.REPO_ROOT,
        )
        self.renderer = Renderer(self.console)
        self.session: PromptSession = PromptSession(
            history=FileHistory(str(Path.home() / ".testo_history")),
        )
        self.turns = 0
        self.total_tool_calls = 0
        self.tokens_in = 0
        self.tokens_out = 0

    # ── banner ──────────────────────────────────────────────────────────────
    def banner(self) -> None:
        d = self.harness.describe()
        self.console.print()
        self.console.print("[bold]  testo[/] [dim]— interactive testing harness[/]")
        self.console.print(
            f"  [dim]backend[/] [cyan]{d['backend']}[/]  "
            f"[dim]model[/] [cyan]{d['model']}[/]  "
            f"[dim]tools[/] [green]{8 + len(self.custom_tools)}[/]  "
            f"[dim]cwd[/] {os.path.relpath(Path.cwd())}"
        )
        self.console.print("  [dim]/help for commands · Ctrl-D to exit[/]\n")

    # ── direct (deterministic) tool invocation ───────────────────────────────
    # /run <tool> k=v … is a debugging escape hatch: invoke one registered tool
    # without the LLM (no tokens, no dependence on the model formatting args).
    # Normal use is /scan, /generate, or just talking to the agent.

    async def _run_tool(self, name: str, kwargs: dict) -> None:
        try:
            tool, Args = ToolRegistry().load(name)
        except Exception as exc:  # noqa: BLE001
            self.console.print(f"  [red]{exc}[/]")
            return
        try:
            args = Args(**kwargs)
        except Exception as exc:  # noqa: BLE001
            req = [n for n, f in Args.model_fields.items() if f.is_required()]
            self.console.print(f"  [red]bad args:[/] {exc}\n  [dim]required: {req or '—'}[/]")
            return
        shown = ", ".join(f"{k}={v}" for k, v in kwargs.items())
        self.console.print(f"[bold blue]⏺ {name}[/]([cyan]{shown}[/])")
        import json as _json
        res = await tool.execute(args, None)
        try:
            env = _json.loads(res.output)
            ok = env.get("ok", not res.is_error)
            counts = {k: v for k, v in (env.get("counts") or {}).items() if v not in (None, [], 0)}
            cstr = " · ".join(f"{k}={v}" for k, v in counts.items())
            outs = ", ".join(env.get("outputPaths", []) or [])
            style = "green" if ok else "red"
            self.console.print(
                f"  ⎿ [{style}]{'ok' if ok else 'failed'}[/] {cstr}"
                f"  [dim]{env.get('durationMs', 0)}ms{('  → ' + outs) if outs else ''}[/]"
            )
            if env.get("error"):
                self.console.print(f"    [red]{env['error']}[/]")
        except Exception:  # noqa: BLE001 — non-JSON tool output
            self.console.print(f"  ⎿ {(res.output or '')[:300]}")

    def _parse_kv(self, arg: str) -> dict:
        kwargs = {}
        for tok in arg.split():
            if "=" in tok:
                k, _, v = tok.partition("=")
                kwargs[k.strip()] = v.strip()
        return kwargs

    # ── subprocess pipelines (ported from the retired interfaces/cli) ────────

    async def _spawn(self, argv: list[str], env: dict) -> int:
        """Run a child with inherited stdio (like the old CLI's stdio:'inherit').

        No prompt is active during the await, so the child owns the terminal —
        streaming output, headed SSO browsers, and Ctrl-C all work.
        """
        proc = await asyncio.create_subprocess_exec(*argv, env=env)
        try:
            return await proc.wait()
        except (KeyboardInterrupt, asyncio.CancelledError):
            proc.terminate()
            await proc.wait()
            raise

    async def _scan(self, arg: str) -> None:
        """Full context-layer scan — port of the retired Node CLI's `testo scan`."""
        try:
            tokens = shlex.split(arg)
        except ValueError as exc:
            self.console.print(f"  [red]bad quoting: {exc}[/]")
            return

        o: dict = {}
        i = 0
        while i < len(tokens):
            t = tokens[i]
            i += 1
            if t in ("-h", "--help"):
                self.console.print(_SCAN_HELP)
                return
            elif t == "--url":
                o["url"], i = tokens[i], i + 1
            elif t == "--sso":
                o["sso"] = True
            elif t in ("--email", "--user", "--username"):
                o["user"], i = tokens[i], i + 1
            elif t in ("--pass", "--password"):
                o["pass"], i = tokens[i], i + 1
            elif t in ("--codebase", "--code"):
                o["codebase"], i = tokens[i], i + 1
            elif t == "--only":
                o["only"], i = tokens[i], i + 1
            elif t == "--skip":
                o["skip"], i = tokens[i], i + 1
            elif t == "--backend":
                o["backend"], i = tokens[i], i + 1
            elif t == "--model":
                o["model"], i = tokens[i], i + 1
            elif not t.startswith("-") and "url" not in o and "codebase" not in o:
                o["url"] = t          # bare token → url  (/scan <url> ergonomic)
            else:
                self.console.print(f"  [red]unknown option \"{t}\" — /scan --help[/]")
                return

        if not o.get("url") and not o.get("codebase"):
            self.console.print("  [yellow]need at least --url or --codebase — /scan --help[/]")
            return
        if o.get("codebase"):
            cb = Path(o["codebase"]).resolve()
            if not cb.is_dir():
                self.console.print(f"  [red]--codebase {cb} is not a directory[/]")
                return
            o["codebase"] = str(cb)

        env = dict(os.environ)
        if o.get("url"):
            env["BASE_URL"] = o["url"]
        if o.get("user"):
            env["LOGIN_EMAIL"] = o["user"]
        if o.get("pass"):
            env["LOGIN_PASSWORD"] = o["pass"]
        if o.get("codebase"):
            env["TARGET_CODEBASE"] = o["codebase"]

        picked = [s.strip() for s in o.get("only", "").split(",") if s.strip()]
        if picked:
            env["ONLY"] = ",".join(picked)

        # Sources with no input are skipped explicitly (crawler has no env gate).
        skip = [] if o.get("url") else ["crawler"]
        skip += [s.strip() for s in o.get("skip", "").split(",") if s.strip()]
        if skip:
            env["SKIP"] = ",".join(dict.fromkeys(skip))

        # Backend selection — mirrors the retired scan.mjs exactly.
        resolved = "auto"
        if o.get("backend"):
            b = o["backend"].lower()
            resolved = b
            if b == "gemini":
                self.console.print(
                    "  [red]--backend gemini is disabled in this checkout.[/]\n"
                    "  [dim]To re-enable: edit testo/repl.py + testo/harness/agentic_harness/tools/graphify/tool.py\n"
                    "  Currently allowed: minimax, local, auto[/]"
                )
                return
            elif b == "minimax":
                if not env.get("MINIMAX_API_KEY"):
                    self.console.print("  [red]--backend minimax needs MINIMAX_API_KEY in your environment[/]")
                    return
                env["GRAPHIFY_BACKEND"] = "minimax"
            elif b in ("local", "ollama"):
                env["GRAPHIFY_BACKEND"] = "ollama"
                resolved = "local"
            elif b == "auto":
                env.pop("GRAPHIFY_BACKEND", None)
            else:
                env["GRAPHIFY_BACKEND"] = b
        if o.get("model"):
            env["GRAPHIFY_MODEL"] = o["model"]

        auth = ("sso (interactive login first)" if o.get("sso")
                else "basic (inline creds)" if o.get("user") or o.get("pass") else "none")
        c = self.console
        c.print("[bold]━━━━━━━━━━ testo scan ━━━━━━━━━━[/]")
        c.print(f"  [dim]url[/]       {o.get('url', '(none)')}")
        c.print(f"  [dim]codebase[/]  {o.get('codebase', '(none)')}")
        c.print(f"  [dim]auth[/]      {auth}")
        c.print(f"  [dim]email[/]     {'✓ set' if o.get('user') else '(none)'}")
        c.print(f"  [dim]pass[/]      {'✓ set' if o.get('pass') else '(none)'}")
        c.print(f"  [dim]backend[/]   {resolved}{('  (model: ' + o['model'] + ')') if o.get('model') else ''}")
        c.print(f"  [dim]sources[/]   {('(--only ' + ', '.join(picked) + ')') if picked else '(auto: framework-detector picks code-extractors)'}")
        c.print(f"  [dim]skipping[/]  {', '.join(skip) if skip else '(none)'}")
        c.print("[bold]━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━[/]\n")

        # SSO pre-step: capture an authenticated session in a headed browser,
        # save auth-state.json, then the crawler reuses it.
        if o.get("sso"):
            if not o.get("url"):
                self.console.print("  [red]--sso requires --url (the app to log in to)[/]")
                return
            c.print("  [dim]--sso → launching interactive login (a Chrome window will open).\n"
                    "  Complete any MFA / CAPTCHA there; your session is saved on landing.[/]\n")
            login = bootstrap.REPO_ROOT / "context-layer" / "content-extractor" / "crawler" / "login-once.mjs"
            code = await self._spawn(["node", str(login)], env)
            if code != 0:
                self.console.print(f"  [red]SSO login step exited {code} — aborting before crawl.[/]")
                return
            c.print("\n  [dim]SSO session captured — continuing to crawl with the saved state.[/]\n")

        runner = bootstrap.REPO_ROOT / "context-layer" / "scan.mjs"
        code = await self._spawn(["node", str(runner)], env)
        style = "green" if code == 0 else "red"
        self.console.print(f"  ⎿ [{style}]scan exited {code}[/]")

    _GEN_KINDS = {"api-tests": "api-test-generator"}

    async def _generate(self, arg: str) -> None:
        """Generation entrypoint — port of the retired Node CLI's `testo generate`.

        Runs as a subprocess (not in-process): the skill needs its own child
        env (BASE_URL etc.) which must not leak into the long-lived REPL.
        """
        try:
            tokens = shlex.split(arg)
        except ValueError as exc:
            self.console.print(f"  [red]bad quoting: {exc}[/]")
            return
        if not tokens or tokens[0] in ("-h", "--help"):
            self.console.print(_GENERATE_HELP)
            return
        kind_arg, tokens = tokens[0], tokens[1:]
        skill = self._GEN_KINDS.get(kind_arg)
        if not skill:
            self.console.print(
                f"  [red]unknown kind \"{kind_arg}\". Available: {', '.join(self._GEN_KINDS)}[/]")
            return

        o: dict = {}
        i = 0
        while i < len(tokens):
            t = tokens[i]
            i += 1
            if t in ("-h", "--help"):
                self.console.print(_GENERATE_HELP)
                return
            elif t == "--url":
                o["url"], i = tokens[i], i + 1
            elif t in ("--user", "--username"):
                o["user"], i = tokens[i], i + 1
            elif t in ("--pass", "--password"):
                o["pass"], i = tokens[i], i + 1
            elif t in ("--output", "--output-dir"):
                o["output_dir"], i = tokens[i], i + 1
            elif t == "--max-tests":
                o["max_tests"], i = tokens[i], i + 1
            elif t == "--timeout":
                o["timeout"], i = tokens[i], i + 1
            elif t == "--no-execute":
                o["no_execute"] = True
            else:
                self.console.print(f"  [red]unknown option \"{t}\" — /generate --help[/]")
                return

        env = dict(os.environ)
        skill_args: list[str] = []
        push = lambda k, v: skill_args.extend([f"--{k}", str(v)])  # noqa: E731
        if o.get("url"):
            env["BASE_URL"] = o["url"]
            push("base_url", o["url"])
        if o.get("user"):
            push("login_email", o["user"])
        if o.get("pass"):
            push("login_password", o["pass"])
        if o.get("output_dir"):
            push("output_dir", o["output_dir"])
        if o.get("max_tests"):
            push("max_tests", o["max_tests"])
        if o.get("timeout"):
            push("timeout_s", o["timeout"])
        if o.get("no_execute"):
            push("execute", "false")

        py = bootstrap.REPO_ROOT / "context-layer" / "content-extractor" / "_lib" / ".venv" / "bin" / "python"
        call_skill = bootstrap.REPO_ROOT / "testo" / "skill-register" / "bin" / "call_skill.py"
        if not py.is_file():
            self.console.print(f"  [red]python interpreter missing at {py}[/]")
            return
        if not call_skill.is_file():
            self.console.print(f"  [red]skill-register CLI missing at {call_skill}[/]")
            return

        c = self.console
        c.print("[bold]━━━━━━━━━━ testo generate ━━━━━━━━━━[/]")
        c.print(f"  [dim]kind[/]        {kind_arg}  (skill: {skill})")
        c.print(f"  [dim]url[/]         {o.get('url', '(auto-detect from crawler bundle)')}")
        c.print(f"  [dim]user[/]        {'✓ set' if o.get('user') else '(no login)'}")
        c.print(f"  [dim]output[/]      {o.get('output_dir', 'output/generation/api-tests')}")
        c.print(f"  [dim]execute[/]     {'NO — generate curls only' if o.get('no_execute') else 'YES'}")
        c.print("[bold]━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━[/]\n")

        argv = [str(py), str(call_skill), skill, "--mode", "direct", *skill_args]
        code = await self._spawn(argv, env)
        style = "green" if code == 0 else "red"
        self.console.print(f"  ⎿ [{style}]generate exited {code}[/]")

    # ── slash commands ───────────────────────────────────────────────────────
    async def slash(self, line: str) -> bool:
        """Handle a /command. Returns True to keep looping, False to quit."""
        parts = line.strip().split(maxsplit=1)
        cmd = parts[0].lower()
        arg = parts[1].strip() if len(parts) > 1 else ""
        eng = self.harness._engine  # noqa: SLF001 — REPL owns the engine

        if cmd in ("/exit", "/quit", "/q"):
            return False
        elif cmd in ("/help", "/?"):
            self.console.print(
                "  [dim]REPL[/]  [bold]/help[/] · [bold]/tools[/] list tools · "
                "[bold]/model [name][/] · [bold]/backend[/] · [bold]/clear[/] · "
                "[bold]/usage[/] · [bold]/cwd[/] · [bold]/exit[/]\n"
                "  [dim]pipelines (no LLM):[/]  "
                "[bold]/scan[/] [dim]--url U --codebase P …  full context-layer scan "
                "(crawl + code extraction; --help)[/]\n"
                "                         [bold]/generate[/] [dim]api-tests …  "
                "build + run API tests (--help)[/]\n"
                "  [dim]debug:[/] [bold]/run[/] [dim]<tool> k=v …  invoke one registered "
                "tool without the LLM (see /tools)[/]\n"
                "  [dim]…or just talk — the agent picks tools itself.[/]"
            )
        elif cmd == "/scan":
            await self._scan(arg)
        elif cmd == "/generate":
            await self._generate(arg)
        elif cmd == "/run":
            rp = arg.split(maxsplit=1)
            if not rp:
                self.console.print("  [yellow]usage: /run <tool> key=value …  (see /tools)[/]")
            else:
                await self._run_tool(rp[0], self._parse_kv(rp[1] if len(rp) > 1 else ""))
        elif cmd == "/tools":
            render_table(self.console)
        elif cmd == "/backend":
            d = self.harness.describe()
            self.console.print(f"  backend [cyan]{d['backend']}[/] · base_url {d['base_url']}")
        elif cmd == "/model":
            if arg:
                try:
                    eng.set_model(arg)
                    self.harness.model = arg
                    self.console.print(f"  model → [cyan]{arg}[/]")
                except Exception as exc:  # noqa: BLE001
                    self.console.print(f"  [red]could not set model: {exc}[/]")
            else:
                self.console.print(f"  model [cyan]{self.harness.model}[/]")
        elif cmd == "/clear":
            try:
                eng.clear()
            except Exception:  # noqa: BLE001
                pass
            self.console.print("  [dim]conversation cleared[/]")
        elif cmd == "/usage":
            self.console.print(
                f"  turns [cyan]{self.turns}[/] · tool calls [cyan]{self.total_tool_calls}[/] · "
                f"tokens in/out [cyan]{self.tokens_in}[/]/[cyan]{self.tokens_out}[/]"
            )
        elif cmd == "/cwd":
            self.console.print(f"  {Path.cwd()}")
        else:
            self.console.print(f"  [yellow]unknown command {cmd} — try /help[/]")
        return True

    # ── one conversational turn ──────────────────────────────────────────────
    async def turn(self, line: str) -> None:
        self.renderer.start_turn()
        try:
            async for event in self.harness.submit(line):
                self.renderer.handle(event)
                if type(event).__name__ == "AssistantTurnComplete":
                    self._account_usage(getattr(event, "usage", None))
        except KeyboardInterrupt:
            self.renderer.end_turn()
            self.console.print("\n  [yellow]⎋ interrupted[/]")
            return
        self.renderer.end_turn()
        self.turns += 1
        self.total_tool_calls += self.renderer.turn_tool_calls
        if self.renderer.turn_tool_calls == 0:
            self.console.print("  [dim yellow]· no tools were called this turn[/]")

    def _account_usage(self, usage) -> None:
        if usage is None:
            return
        get = (lambda k: usage.get(k)) if isinstance(usage, dict) else (lambda k: getattr(usage, k, None))
        self.tokens_in += get("input_tokens") or get("prompt_tokens") or 0
        self.tokens_out += get("output_tokens") or get("completion_tokens") or 0

    # ── main loop ─────────────────────────────────────────────────────────────
    async def run(self) -> int:
        self.banner()
        while True:
            try:
                line = await self.session.prompt_async("› ")
            except (EOFError, KeyboardInterrupt):
                break
            line = line.strip()
            if not line:
                continue
            if line.startswith("/"):
                if not await self.slash(line):
                    break
                continue
            await self.turn(line)
        self.console.print("\n  [dim]bye — "
                           f"{self.turns} turns, {self.total_tool_calls} tool calls[/]")
        return 0


def main() -> int:
    return asyncio.run(Repl().run())


if __name__ == "__main__":
    raise SystemExit(main())
