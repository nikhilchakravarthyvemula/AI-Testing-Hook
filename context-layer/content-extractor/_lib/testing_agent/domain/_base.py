"""Shared base classes for domain models.

Centralising `model_config` here prevents drift across modules and makes the
"frozen unless lifecycle requires mutability" rule explicit at one place.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class FrozenModel(BaseModel):
    """Immutable base. Use for run artefacts that must not mutate after construction.

    Frozen models are safe to share across concurrent phases — no one can
    alter a value another phase is reading. `extra="forbid"` blocks
    accidental field aliasing, especially when the LLM emits unexpected
    fields it learned from training data.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")


class StrictModel(BaseModel):
    """Mutable but strict — same `extra="forbid"` rule, mutation allowed.

    Use for types whose status legitimately changes during the pipeline
    (e.g. `Case`, where validate flips `status` from PLANNED to REJECTED).
    """

    model_config = ConfigDict(extra="forbid")
