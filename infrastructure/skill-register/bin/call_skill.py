#!/usr/bin/env python
"""Internal CLI — invoke a registered skill through SkillService.

Mirrors `infrastructure/agentic-harness/bin/call_tool.py`. End users
should prefer the higher-level `testo` commands; this CLI is for
plumbing (testo generate, scripts, smoke tests).

Usage:
    python call_skill.py <SKILL> [--mode direct] [--<arg> <value>] ...

Exit codes:
    0 — skill ran and reported success
    1 — skill ran and reported failure
    2 — skill failed to start (unknown skill, bad args, etc.)
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path

# Make the parent dir importable so `skill_register` resolves.
_BIN_DIR = Path(__file__).resolve().parent
_PKG_PARENT = _BIN_DIR.parent  # infrastructure/skill-register/
_REPO_ROOT = _PKG_PARENT.parent.parent
sys.path.insert(0, str(_PKG_PARENT))


def _load_repo_env() -> None:
    env = _REPO_ROOT / ".env"
    if not env.is_file():
        return
    for raw in env.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        k = k.strip()
        v = v.strip().strip('"').strip("'")
        if k and v and not os.environ.get(k):
            os.environ[k] = v


_load_repo_env()

from skill_register import (  # noqa: E402
    SkillArgumentError,
    SkillInvocationMode,
    SkillRegistry,
    SkillService,
    SkillSourceMissingError,
    UnknownSkillError,
)


def _parse_extras(extras: list[str]) -> dict:
    """Parse forwarded `--key value` pairs from argv tail into a dict."""
    out: dict = {}
    i = 0
    while i < len(extras):
        token = extras[i]
        if not token.startswith("--"):
            raise SystemExit(f"call_skill: unexpected positional arg: {token!r}")
        key = token[2:]
        if i + 1 >= len(extras) or extras[i + 1].startswith("--"):
            out[key] = True
            i += 1
        else:
            out[key] = extras[i + 1]
            i += 2
    return out


def main() -> int:
    registry = SkillRegistry()
    parser = argparse.ArgumentParser(prog="call_skill.py", description=__doc__)
    parser.add_argument(
        "skill", choices=registry.list_skills(),
        help=f"Registered skill name (one of: {', '.join(registry.list_skills())}).",
    )
    parser.add_argument(
        "--mode",
        choices=tuple(m.value for m in SkillInvocationMode),
        default=SkillInvocationMode.DIRECT.value,
    )
    known, extras = parser.parse_known_args()
    skill_args = _parse_extras(extras)

    try:
        skill, args_cls = registry.load(known.skill)
    except (UnknownSkillError, SkillSourceMissingError) as exc:
        print(f"call_skill: {exc}", file=sys.stderr)
        return 2

    mode = SkillInvocationMode(known.mode)
    if mode is not SkillInvocationMode.DIRECT:
        # Agent mode would route through agentic-harness here; for now we ship
        # direct-only and add agent mode when a real caller needs it.
        print(f"call_skill: --mode {mode.value} not yet wired", file=sys.stderr)
        return 2

    try:
        args_obj = args_cls(**skill_args)
    except Exception as exc:  # noqa: BLE001 — pydantic ValidationError, etc.
        print(f"call_skill: bad args for {known.skill}: {exc}", file=sys.stderr)
        return 2

    service = SkillService()
    result = asyncio.run(service.invoke_direct(skill, args_obj))

    print(
        f"\n[call_skill] mode={result.mode.value} ok={result.ok} status={result.status.value}",
        flush=True,
    )
    return 0 if result.ok else 1


if __name__ == "__main__":
    sys.exit(main())
