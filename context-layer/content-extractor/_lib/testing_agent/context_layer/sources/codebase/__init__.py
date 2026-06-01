"""Codebase source — reads source files on disk, produces entities.

The codebase source is one `SourceExtractor` among several. It owns
its own internal abstractions (framework extractors and shared
helpers) but exposes only the standard `SourceExtractor` interface to
the pipeline.

Submodules:
  * `extractor.py`     — `CodebaseExtractor` class (the source-level entry point)
  * `types.py`         — `CodebaseExtractionRequest`
  * `registry.py`      — registered framework extractors
  * `framework_port.py` — internal Protocol that framework extractors satisfy
  * `extractors/`      — concrete framework extractors (Spring, FastAPI, …)
"""

from .extractor import CodebaseExtractor
from .types import CodebaseExtractionRequest

__all__ = ["CodebaseExtractor", "CodebaseExtractionRequest"]
