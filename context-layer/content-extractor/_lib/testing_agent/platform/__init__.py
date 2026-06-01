"""Platform layer — cross-cutting low-level infrastructure.

Contains everything that talks to the outside world from a position
"underneath" the application: HTTP clients, database engines, file I/O,
logging configuration. Adapters depend on `platform.*` for plumbing;
the rest of the codebase doesn't import from here directly.

Naming follows the Radius backend convention (`internal/platform/`) so
the two codebases stay legible to humans switching between them.
"""
