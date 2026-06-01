"""Logging setup — single configuration point for the whole package.

Every module gets its logger via `get_logger(__name__)`. Configuration happens
once, at CLI startup, before any subcommand body runs. Two output modes:

  * human  — RichHandler, coloured, level-prefixed; default for interactive runs
  * plain  — single-line, level-prefixed; for CI / log-aggregation pipelines

Levels (CLI flag → effective level):
  default       WARNING   only warnings + errors
  -v / --verbose INFO     phase boundaries, harness calls, subprocess starts
  -vv / --debug  DEBUG    everything, incl. payload sizes, full subprocess args
"""

from __future__ import annotations

import logging
import sys
from enum import StrEnum
from pathlib import Path

from rich.console import Console
from rich.logging import RichHandler


class LogLevel(StrEnum):
    """CLI-facing names. Map onto stdlib logging levels."""

    WARNING = "warning"
    INFO = "info"
    DEBUG = "debug"


class LogFormat(StrEnum):
    HUMAN = "human"
    PLAIN = "plain"


_LEVEL_MAP: dict[LogLevel, int] = {
    LogLevel.WARNING: logging.WARNING,
    LogLevel.INFO: logging.INFO,
    LogLevel.DEBUG: logging.DEBUG,
}

_PACKAGE_ROOT = "testing_agent"


def configure(
    level: LogLevel = LogLevel.WARNING,
    fmt: LogFormat = LogFormat.HUMAN,
    log_file: Path | None = None,
) -> None:
    """Set up the package logger. Idempotent — safe to call multiple times.

    Replaces any existing handlers on the package logger so a re-invocation
    (e.g. across two CLI subcommands in a script) doesn't double-emit.
    """
    package_logger = logging.getLogger(_PACKAGE_ROOT)
    # Set the logger level to the lowest threshold any handler will accept so
    # records are not filtered out before reaching the handlers. With a file
    # handler in DEBUG mode, the console handler still filters at its own level.
    effective_level = min(_LEVEL_MAP[level], logging.DEBUG) if log_file is not None else _LEVEL_MAP[level]
    package_logger.setLevel(effective_level)
    package_logger.propagate = False

    # Drop any pre-existing handlers (idempotency).
    for handler in list(package_logger.handlers):
        package_logger.removeHandler(handler)

    # Console handler.
    if fmt == LogFormat.HUMAN:
        console_handler: logging.Handler = RichHandler(
            console=Console(stderr=True),
            rich_tracebacks=True,
            tracebacks_show_locals=False,
            show_time=True,
            show_path=False,
            markup=True,
        )
        console_handler.setFormatter(logging.Formatter("%(message)s"))
    else:
        console_handler = logging.StreamHandler(stream=sys.stderr)
        console_handler.setFormatter(
            logging.Formatter("%(asctime)s %(levelname)-7s %(name)s — %(message)s"),
        )
    console_handler.setLevel(_LEVEL_MAP[level])
    package_logger.addHandler(console_handler)

    # Optional file handler — always plain format, full debug detail.
    if log_file is not None:
        log_file.parent.mkdir(parents=True, exist_ok=True)
        file_handler = logging.FileHandler(log_file, encoding="utf-8")
        file_handler.setLevel(logging.DEBUG)
        file_handler.setFormatter(
            logging.Formatter(
                "%(asctime)s %(levelname)-7s %(name)s:%(lineno)d — %(message)s",
            ),
        )
        package_logger.addHandler(file_handler)


def get_logger(name: str) -> logging.Logger:
    """Module-level logger access. Use `get_logger(__name__)` everywhere.

    The package logger is the parent; configuration there cascades to all
    children automatically (`testing_agent.scanner.api`, etc.).
    """
    return logging.getLogger(name)
