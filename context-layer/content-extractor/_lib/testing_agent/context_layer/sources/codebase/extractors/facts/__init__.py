"""Codebase fact extractors — `FrameworkFact` producers.

These read a single file per repo (manifest / config / build file) and
emit one or more `FrameworkFact` rows. They don't iterate; each runs
exactly once per repo (when the runner sees the named manifest file).
"""
