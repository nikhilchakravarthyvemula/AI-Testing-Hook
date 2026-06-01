"""Shared AST loaders + parsers.

  * `python.py` — stdlib `ast` wrapper with cached parsing.
  * `tree_sitter_loader.py` — lazy tree-sitter `Parser` per language.
  * `java.py` / `csharp.py` — language-specific helpers atop tree-sitter.

The `ast_cache.py` (one level up under `_shared/backend/`) holds
parsed trees per file across a single extraction run so extractors
that share a file don't re-parse.
"""
