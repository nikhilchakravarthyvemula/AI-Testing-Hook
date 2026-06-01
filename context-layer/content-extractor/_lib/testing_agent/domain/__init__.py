"""Domain layer — cross-slice primitives.

After the context_layer refactor, only the Pydantic base classes
(`FrozenModel`, `StrictModel`) are genuinely cross-slice. The old
catalog / journey / planning enums lived here but moved with their
code when the pipeline phases were retired.
"""

from ._base import FrozenModel, StrictModel

__all__ = ["FrozenModel", "StrictModel"]
