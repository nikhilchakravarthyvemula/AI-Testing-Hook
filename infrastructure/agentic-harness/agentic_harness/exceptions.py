"""Exception hierarchy for the agentic-harness.

Single root (`AgenticHarnessError`) so callers can `except AgenticHarnessError`
to catch anything from this package, then refine with specific subclasses
when they care about the failure mode.
"""

from __future__ import annotations


class AgenticHarnessError(Exception):
    """Base class for every error raised by the agentic-harness package."""


# ── backend / config ──────────────────────────────────────────────────────


class BackendError(AgenticHarnessError):
    """A backend (LLM provider) couldn't be selected or contacted."""


class UnknownBackendError(BackendError):
    """A caller asked for a backend name we don't recognise."""


class BackendDisabledError(BackendError):
    """Backend exists in the catalog but has been explicitly disabled."""


class MissingApiKeyError(BackendError):
    """A backend was selected but its API-key env var isn't set."""


# ── tool registry / loading ───────────────────────────────────────────────


class ToolError(AgenticHarnessError):
    """A custom tool couldn't be loaded or didn't behave as expected."""


class UnknownToolError(ToolError):
    """The registry has no entry under this name."""


class ToolSourceMissingError(ToolError):
    """The file the registry points to doesn't exist on disk."""


class ToolArgumentError(ToolError):
    """Args passed to a tool failed validation (typically pydantic)."""


# ── invocation outcomes (non-fatal in some modes) ─────────────────────────


class NoToolInvokedError(AgenticHarnessError):
    """Agent mode finished without ever calling a tool.

    Raised at the caller's discretion; `ToolService` returns this as a
    structured result by default, but callers can choose to raise it.
    """


__all__ = [
    "AgenticHarnessError",
    "BackendError", "UnknownBackendError", "BackendDisabledError", "MissingApiKeyError",
    "ToolError", "UnknownToolError", "ToolSourceMissingError", "ToolArgumentError",
    "NoToolInvokedError",
]
