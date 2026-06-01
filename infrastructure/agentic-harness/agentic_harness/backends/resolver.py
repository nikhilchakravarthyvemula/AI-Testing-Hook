"""BackendResolver — picks a `BackendConfig` from env state or a name.

Implements `IBackendResolver`. The whole point of this class is to
decouple "what backend to use" decisions from "what backend exists"
data — the latter lives in `catalog.py`.
"""

from __future__ import annotations

import os

from ..enums import BackendKind
from ..exceptions import MissingApiKeyError, UnknownBackendError
from ..models import BackendConfig
from .catalog import BACKEND_CATALOG, BACKEND_PRIORITY


class BackendResolver:
    """Decide which BackendConfig the harness should use this run."""

    def __init__(self, catalog: dict[BackendKind, BackendConfig] | None = None) -> None:
        self._catalog = catalog or BACKEND_CATALOG

    # ── public ────────────────────────────────────────────────────────────

    def resolve(self, *, force: str | None = None) -> BackendConfig:
        """Return the BackendConfig the harness should use.

        Args:
            force: backend kind to force (string from CLI or env). If
                provided, must be a known backend AND its API key (when
                required) must be in env. Skips auto-detection.

        Raises:
            UnknownBackendError: `force` doesn't match any registered backend.
            MissingApiKeyError: backend requires an API key and it isn't set.
        """
        if force:
            return self._resolve_forced(force)
        return self._resolve_auto()

    # ── internals ─────────────────────────────────────────────────────────

    def _resolve_forced(self, name: str) -> BackendConfig:
        try:
            kind = BackendKind(name.lower())
        except ValueError as exc:
            raise UnknownBackendError(
                f"Unknown backend {name!r}. "
                f"Known: {[b.value for b in BackendKind]}"
            ) from exc

        cfg = self._catalog[kind]
        if not cfg.is_keyless and not os.environ.get(cfg.api_key_env or ""):
            raise MissingApiKeyError(
                f"Backend {kind.value!r} requires {cfg.api_key_env} in env."
            )
        return cfg

    def _resolve_auto(self) -> BackendConfig:
        """Pick the first backend in `BACKEND_PRIORITY` whose key is set.

        Ollama is always the no-key fallback at the tail.
        """
        for kind in BACKEND_PRIORITY:
            cfg = self._catalog[kind]
            if cfg.is_keyless:
                return cfg  # ollama — always works as fallback
            if os.environ.get(cfg.api_key_env or ""):
                return cfg
        # Unreachable in practice: ollama is keyless and always in the list.
        return self._catalog[BACKEND_PRIORITY[-1]]


__all__ = ["BackendResolver"]
