"""Typed data models for the agentic-harness.

Pydantic models — chosen over dataclasses because:
  * we already depend on pydantic via openharness
  * validation at construction is cheap insurance
  * JSON serialisation comes free for log / artifact dumps

If you add a field, do it here and let the type checker tell you who
needs to update.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field

from .enums import BackendKind, InvocationMode, InvocationStatus


# ── backend / harness configuration ───────────────────────────────────────


class BackendConfig(BaseModel):
    """Everything the harness needs to build an OpenAI-compatible client.

    Sourced from `backends/catalog.py` + `.env`. Frozen so passes through
    the system don't accidentally mutate one entry and surprise the next
    caller.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    kind: BackendKind
    base_url: str
    default_model: str
    api_key_env: Optional[str] = Field(
        default=None,
        description="Env var holding the API key. None for keyless backends (ollama).",
    )

    @property
    def is_keyless(self) -> bool:
        return self.api_key_env is None


# ── tool definition (registry side) ───────────────────────────────────────


class ToolDefinition(BaseModel):
    """How a tool is described in the registry catalog.

    Source-file based so each tool can live in whatever directory makes
    sense; the registry doesn't impose a layout.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    name: str = Field(..., description="LLM-callable id, e.g. 'graphify'.")
    source_path: Path = Field(..., description="Path to the file that declares the tool class.")
    tool_class: str = Field(..., description="Class name of the BaseTool subclass.")
    args_class: str = Field(..., description="Class name of the pydantic args model.")
    summary: str = Field(default="", description="One-line description shown in CLI help.")


# ── tool invocation result (uniform across modes) ─────────────────────────


class ToolInvocationResult(BaseModel):
    """Outcome of one ToolService.invoke_* call.

    Same shape regardless of mode — callers branch on `.ok` and
    `.status`, never on which mode was used.
    """

    model_config = ConfigDict(extra="forbid")

    ok: bool
    mode: InvocationMode
    status: InvocationStatus
    output: Optional[str] = None
    tool_calls: int = Field(default=0, ge=0)
    metadata: dict[str, Any] = Field(default_factory=dict)

    def __bool__(self) -> bool:
        return self.ok


__all__ = ["BackendConfig", "ToolDefinition", "ToolInvocationResult"]
