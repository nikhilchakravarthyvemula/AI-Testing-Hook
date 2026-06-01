"""ToolService — the seam every consumer should use to invoke tools.

Three modes (see `InvocationMode` enum):
  * DIRECT      — call `tool.execute()` ourselves. No LLM.
  * AGENT       — narrow LLM agent that picks from a small set of tools.
  * FREE_AGENT  — open LLM agent with the full standard toolbelt.

Every mode returns a `ToolInvocationResult` so callers can branch on
`result.ok` / `result.status` without caring which mode ran.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any, Optional, Sequence

from openharness.engine.stream_events import (
    AssistantTextDelta,
    AssistantTurnComplete,
    ErrorEvent,
    ToolExecutionCompleted,
    ToolExecutionStarted,
)

from ..enums import InvocationMode, InvocationStatus
from ..interfaces import IAgenticHarness, IBaseTool
from ..models import ToolInvocationResult
from ..tools.standard_toolbelt import DEFAULT_SYSTEM_PROMPT, build_toolbelt


class ToolService:
    """Routes tool calls through one of three invocation modes."""

    DEFAULT_FREE_AGENT_MAX_TURNS = 80
    _RESULT_TAIL_CHARS = 600

    def __init__(self, harness: Optional[IAgenticHarness] = None) -> None:
        # `harness` is only required for `invoke_via_agent`. Direct + free-agent
        # modes either don't need one (direct) or build their own (free-agent).
        self._harness = harness

    # ── direct mode ────────────────────────────────────────────────────────

    async def invoke_direct(
        self,
        tool: IBaseTool,
        args: Any,
    ) -> ToolInvocationResult:
        """Run `tool.execute(args, None)` and normalise the result."""
        tool_name = getattr(tool, "name", type(tool).__name__)
        print(
            f"\n[tool→] {tool_name}({args!r})\n"
            f"[tool→] direct invocation (no LLM agent)",
            flush=True,
        )

        try:
            result = await tool.execute(args, context=None)  # type: ignore[arg-type]
        except Exception as exc:  # noqa: BLE001 — surface ANY error uniformly
            print(f"\n[tool← {tool_name} err=True]\nException: {exc!r}", flush=True)
            return ToolInvocationResult(
                ok=False,
                mode=InvocationMode.DIRECT,
                status=InvocationStatus.EXCEPTION,
                output=repr(exc),
            )

        self._log_tool_completion(tool_name, result.is_error, result.output)
        return ToolInvocationResult(
            ok=not result.is_error,
            mode=InvocationMode.DIRECT,
            status=(InvocationStatus.SUCCESS if not result.is_error else InvocationStatus.TOOL_ERROR),
            output=result.output,
            tool_calls=1,
            metadata=getattr(result, "metadata", {}) or {},
        )

    # ── agent mode (narrow) ────────────────────────────────────────────────

    async def invoke_via_agent(
        self,
        prompt: str,
        *,
        tools: Sequence[IBaseTool] = (),
    ) -> ToolInvocationResult:
        """Let the LLM in `self._harness` pick a tool to call for `prompt`."""
        if self._harness is None:
            raise RuntimeError(
                "ToolService.invoke_via_agent requires a harness; "
                "pass one to ToolService(harness=...)."
            )
        for tool in tools:
            self._harness.register(tool)

        print(
            f"\n[agent→] backend={self._harness.backend.kind.value} "
            f"model={self._harness.model}"
            f"\n[agent→] prompt: {prompt!r}",
            flush=True,
        )

        outcome = await self._consume_agent_stream(prompt, mode=InvocationMode.AGENT)
        return outcome

    # ── free-agent mode (full toolbelt) ────────────────────────────────────

    async def invoke_via_free_agent(
        self,
        prompt: str,
        *,
        custom_tools: Sequence[IBaseTool] = (),
        max_turns: int = DEFAULT_FREE_AGENT_MAX_TURNS,
        system_prompt: Optional[str] = None,
        cwd: Optional[Path] = None,
    ) -> ToolInvocationResult:
        """Open-ended agentic call. LLM gets full toolbelt + custom tools."""
        # Lazy import — avoids circular dependency with harness_service.
        from .harness_service import AgenticHarness

        registry = build_toolbelt(custom_tools)
        harness: IAgenticHarness = AgenticHarness(
            registry=registry,
            max_turns=max_turns,
            system_prompt=system_prompt or DEFAULT_SYSTEM_PROMPT,
            cwd=cwd,
        )
        # Local mutation: switch harness for the stream consumption.
        prior_harness = self._harness
        self._harness = harness
        try:
            print(
                f"\n[free-agent] backend={harness.backend.kind.value} "
                f"model={harness.model} max_turns={max_turns}\n"
                f"[free-agent] toolbelt: bash, read_file, write_file, edit_file, "
                f"glob, grep, todo_write, agent + {len(list(custom_tools))} custom\n"
                f"[free-agent] prompt: {prompt!r}",
                flush=True,
            )
            return await self._consume_agent_stream(
                prompt,
                mode=InvocationMode.FREE_AGENT,
                compact_logging=True,
            )
        finally:
            self._harness = prior_harness

    # ── shared agent event-loop consumer ───────────────────────────────────

    async def _consume_agent_stream(
        self,
        prompt: str,
        *,
        mode: InvocationMode,
        compact_logging: bool = False,
    ) -> ToolInvocationResult:
        """Common loop for AGENT and FREE_AGENT modes. Streams events,
        returns a uniform result with strict honesty rules."""
        assert self._harness is not None

        last_tool_output: Optional[str] = None
        last_tool_ok = True
        tool_call_count = 0

        async for event in self._harness.submit(prompt):
            if isinstance(event, AssistantTextDelta):
                print(event.text, end="", flush=True)
            elif isinstance(event, ToolExecutionStarted):
                tool_call_count += 1
                self._log_tool_started(event, tool_call_count, compact=compact_logging)
            elif isinstance(event, ToolExecutionCompleted):
                self._log_tool_completion(
                    event.tool_name,
                    event.is_error,
                    event.output,
                    counter=tool_call_count,
                    compact=compact_logging,
                )
                last_tool_output = event.output
                last_tool_ok = not event.is_error
            elif isinstance(event, ErrorEvent):
                print(f"\n[ENGINE ERROR] {event!r}", flush=True)
                return ToolInvocationResult(
                    ok=False, mode=mode, status=InvocationStatus.ENGINE_ERROR,
                    output=str(event),
                    tool_calls=tool_call_count,
                )
            elif isinstance(event, AssistantTurnComplete):
                print(
                    f"\n[turn complete]  ({tool_call_count} tool calls so far)",
                    flush=True,
                )

        # Strict honesty: if no tool ran, the task wasn't done — even
        # if the LLM cheerfully claimed success in its text. Past bugs
        # have hidden behind this exact pattern (llama hallucinating
        # tool args, then declaring success).
        if tool_call_count == 0:
            print(
                "\n[agent←] WARNING: agent never invoked a tool. The LLM "
                "likely talked through the task without acting on it.",
                file=sys.stderr,
                flush=True,
            )
            return ToolInvocationResult(
                ok=False, mode=mode, status=InvocationStatus.NOT_INVOKED,
                output=last_tool_output,
                tool_calls=0,
                metadata={"reason": "no_tool_invoked"},
            )

        return ToolInvocationResult(
            ok=last_tool_ok,
            mode=mode,
            status=(InvocationStatus.SUCCESS if last_tool_ok else InvocationStatus.TOOL_ERROR),
            output=last_tool_output,
            tool_calls=tool_call_count,
        )

    # ── small log helpers ─────────────────────────────────────────────────

    def _log_tool_started(
        self,
        event: ToolExecutionStarted,
        counter: int,
        *,
        compact: bool,
    ) -> None:
        if compact:
            inp_str = repr(event.tool_input)
            if len(inp_str) > 200:
                inp_str = inp_str[:197] + "…"
            print(f"\n[tool→ #{counter}] {event.tool_name}({inp_str})", flush=True)
        else:
            print(f"\n[tool→] {event.tool_name}({event.tool_input})", flush=True)

    def _log_tool_completion(
        self,
        tool_name: str,
        is_error: bool,
        output: Optional[str],
        *,
        counter: Optional[int] = None,
        compact: bool = False,
    ) -> None:
        tail = (output or "")[-self._RESULT_TAIL_CHARS:]
        prefix = f"[tool← #{counter}" if counter is not None else "[tool←"
        if compact:
            short_tail = tail.strip()[:200]
            ellipsis = "…" if len(tail) > 200 else ""
            print(
                f"\n{prefix} {tool_name} err={is_error}]  {short_tail}{ellipsis}",
                flush=True,
            )
        else:
            print(
                f"\n{prefix} {tool_name} err={is_error}]"
                f"\n----- last {self._RESULT_TAIL_CHARS} chars of tool output -----\n{tail}"
                f"\n-----------------------------------------",
                flush=True,
            )


__all__ = ["ToolService"]
