"""AgenticHarness — wraps OpenHarness `QueryEngine` for LLM + tool calls.

Implements `IAgenticHarness`. Constructor-injected dependencies (resolver,
registry, system prompt) so the class can be unit-tested without env state.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import AsyncIterator, Optional

from openharness.api.openai_client import OpenAICompatibleClient
from openharness.config.settings import PermissionMode, PermissionSettings
from openharness.engine.query_engine import QueryEngine
from openharness.permissions.checker import PermissionChecker
from openharness.tools.base import ToolRegistry as OpenHarnessToolRegistry

from ..backends.resolver import BackendResolver
from ..interfaces import IBaseTool, IBackendResolver
from ..models import BackendConfig
from ..tools.standard_toolbelt import DEFAULT_SYSTEM_PROMPT


class AgenticHarness:
    """A configured LLM + tool registry, ready to drive."""

    DEFAULT_MAX_TURNS = 4
    KEYLESS_API_KEY_PLACEHOLDER = "ollama"  # openai SDK requires a non-empty string

    def __init__(
        self,
        *,
        registry: Optional[OpenHarnessToolRegistry] = None,
        resolver: Optional[IBackendResolver] = None,
        backend: Optional[str] = None,
        model: Optional[str] = None,
        max_turns: int = DEFAULT_MAX_TURNS,
        system_prompt: Optional[str] = None,
        cwd: Optional[Path] = None,
    ) -> None:
        self._resolver: IBackendResolver = resolver or BackendResolver()
        self.config: BackendConfig = self._resolver.resolve(force=backend)
        self.model: str = self._resolve_model_override(model)
        self._registry: OpenHarnessToolRegistry = registry or OpenHarnessToolRegistry()

        self._engine: QueryEngine = self._build_engine(
            max_turns=max_turns,
            system_prompt=system_prompt or DEFAULT_SYSTEM_PROMPT,
            cwd=cwd or Path.cwd(),
        )

    # ── public ────────────────────────────────────────────────────────────

    @property
    def backend(self) -> BackendConfig:
        """The resolved BackendConfig for this harness."""
        return self.config

    def register(self, tool: IBaseTool) -> None:
        """Add a tool to the registry so the LLM can pick it."""
        self._registry.register(tool)

    async def submit(self, prompt: str) -> AsyncIterator:
        """Stream OpenHarness events for `prompt`. Caller consumes the iter."""
        async for event in self._engine.submit_message(prompt):
            yield event

    def describe(self) -> dict:
        """Short summary of how this harness is configured. Useful for logs."""
        return {
            "backend": self.config.kind.value,
            "model": self.model,
            "base_url": self.config.base_url,
            "max_turns": getattr(self._engine, "max_turns", None),
        }

    # ── internals ─────────────────────────────────────────────────────────

    def _resolve_model_override(self, explicit_model: Optional[str]) -> str:
        """Pick the model: explicit > per-backend env > backend default."""
        if explicit_model:
            return explicit_model
        env_key = f"AGENTIC_HARNESS_{self.config.kind.value.upper()}_MODEL"
        return os.environ.get(env_key) or self.config.default_model

    def _api_key(self) -> str:
        if self.config.is_keyless:
            return self.KEYLESS_API_KEY_PLACEHOLDER
        env_key = self.config.api_key_env  # type: ignore[assignment]
        return os.environ.get(env_key, "") or self.KEYLESS_API_KEY_PLACEHOLDER

    def _build_engine(self, *, max_turns: int, system_prompt: str, cwd: Path) -> QueryEngine:
        api = OpenAICompatibleClient(
            api_key=self._api_key(),
            base_url=self.config.base_url,
        )
        return QueryEngine(
            api_client=api,
            tool_registry=self._registry,
            permission_checker=PermissionChecker(
                PermissionSettings(mode=PermissionMode.FULL_AUTO),
            ),
            cwd=cwd,
            model=self.model,
            system_prompt=system_prompt,
            max_turns=max_turns,
        )


__all__ = ["AgenticHarness"]
