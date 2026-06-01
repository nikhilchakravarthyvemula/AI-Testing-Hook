"""agentic_harness — public API for the LLM tool-calling layer.

Typical usage:

    from agentic_harness import ToolService, ToolRegistry

    registry = ToolRegistry()
    tool, args_cls = registry.load("graphify")

    service = ToolService()
    result = await service.invoke_direct(tool, args_cls(path="/path/to/repo"))
    if result.ok:
        print(result.output)

This module re-exports the curated public surface. Anything not exported
here is internal — import paths inside `agentic_harness.<submodule>` may
move without notice.
"""

from __future__ import annotations

from .enums import BackendKind, InvocationMode, InvocationStatus
from .exceptions import (
    AgenticHarnessError,
    BackendDisabledError,
    BackendError,
    MissingApiKeyError,
    NoToolInvokedError,
    ToolArgumentError,
    ToolError,
    ToolSourceMissingError,
    UnknownBackendError,
    UnknownToolError,
)
from .interfaces import (
    IAgenticHarness,
    IBackendResolver,
    IBaseTool,
    IToolRegistry,
    IToolService,
)
from .models import BackendConfig, ToolDefinition, ToolInvocationResult
from .registry.tool_registry import REGISTERED_TOOLS, ToolRegistry
from .services.harness_service import AgenticHarness
from .services.tool_service import ToolService

__all__ = [
    # Services
    "AgenticHarness", "ToolService", "ToolRegistry",
    # Models
    "BackendConfig", "ToolDefinition", "ToolInvocationResult",
    # Enums
    "BackendKind", "InvocationMode", "InvocationStatus",
    # Interfaces
    "IAgenticHarness", "IBaseTool", "IBackendResolver", "IToolRegistry", "IToolService",
    # Exceptions
    "AgenticHarnessError",
    "BackendError", "UnknownBackendError", "BackendDisabledError", "MissingApiKeyError",
    "ToolError", "UnknownToolError", "ToolSourceMissingError", "ToolArgumentError",
    "NoToolInvokedError",
    # Registry catalog
    "REGISTERED_TOOLS",
]
