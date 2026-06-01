"""Structural interfaces (Protocols) the agentic-harness components implement.

We use `typing.Protocol` instead of ABCs because:
  * tools come from third-party openharness — no inheritance contract to add
  * Protocols are structural — anything quacking like the protocol qualifies
  * type checker enforces it without runtime registration

Implementations don't `extends` these; they just satisfy the shape.
"""

from __future__ import annotations

from typing import Any, AsyncIterator, Protocol, Sequence, runtime_checkable

from .models import BackendConfig, ToolDefinition, ToolInvocationResult


@runtime_checkable
class IBaseTool(Protocol):
    """Subset of openharness `BaseTool` that the harness actually relies on.

    OpenHarness's real BaseTool has more methods; we only need these,
    so type-check the minimum to keep the dependency loose.
    """

    name: str

    async def execute(self, arguments: Any, context: Any) -> Any: ...


@runtime_checkable
class IBackendResolver(Protocol):
    """Picks a BackendConfig at runtime — typically from env vars."""

    def resolve(self, *, force: str | None = None) -> BackendConfig: ...


@runtime_checkable
class IToolRegistry(Protocol):
    """Knows where tool source files live and how to instantiate them."""

    def list_tools(self) -> list[str]: ...
    def get_definition(self, name: str) -> ToolDefinition: ...
    def load(self, name: str) -> tuple[IBaseTool, type]: ...


@runtime_checkable
class IAgenticHarness(Protocol):
    """A configured LLM + tool-calling engine."""

    backend: BackendConfig
    model: str

    def register(self, tool: IBaseTool) -> None: ...
    async def submit(self, prompt: str) -> AsyncIterator[Any]: ...


@runtime_checkable
class IToolService(Protocol):
    """The seam every consumer should use to call a tool."""

    async def invoke_direct(
        self,
        tool: IBaseTool,
        args: Any,
    ) -> ToolInvocationResult: ...

    async def invoke_via_agent(
        self,
        prompt: str,
        *,
        tools: Sequence[IBaseTool] = (),
    ) -> ToolInvocationResult: ...

    async def invoke_via_free_agent(
        self,
        prompt: str,
        *,
        custom_tools: Sequence[IBaseTool] = (),
        max_turns: int = 80,
    ) -> ToolInvocationResult: ...


__all__ = [
    "IBaseTool",
    "IBackendResolver",
    "IToolRegistry",
    "IAgenticHarness",
    "IToolService",
]
