"""SkillService — the seam every consumer should use to invoke skills.

Mirrors agentic_harness.services.tool_service. Today we ship `direct`
mode only — agent mode (LLM picks a skill) can plug in later when a
real call-site needs it.
"""

from __future__ import annotations

import sys
from typing import Any

from ..enums import SkillInvocationMode, SkillInvocationStatus
from ..interfaces import ISkill
from ..models import SkillInvocationResult


class SkillService:
    """Routes skill calls through one of the supported invocation modes."""

    _RESULT_TAIL_CHARS = 600

    # ── direct mode ────────────────────────────────────────────────────────

    async def invoke_direct(self, skill: ISkill, args: Any) -> SkillInvocationResult:
        """Call `skill.execute(args)`; normalise into SkillInvocationResult."""
        skill_name = getattr(skill, "name", type(skill).__name__)
        print(
            f"\n[skill→] {skill_name}({args!r})\n"
            f"[skill→] direct invocation",
            flush=True,
        )

        try:
            result = await skill.execute(args)
        except Exception as exc:  # noqa: BLE001 — surface ANY error uniformly
            print(f"\n[skill← {skill_name} err=True]\nException: {exc!r}", flush=True)
            return SkillInvocationResult(
                ok=False,
                mode=SkillInvocationMode.DIRECT,
                status=SkillInvocationStatus.EXCEPTION,
                output=repr(exc),
            )

        # Skills return their own per-skill result objects (typically pydantic
        # models). We want a uniform top-level wrapper. The convention is that
        # the skill's result either:
        #   * has an `ok` attr → use that
        #   * is dict-like with 'ok' → use that
        #   * else assume success (skill didn't raise)
        ok, output, metadata = _normalise_skill_result(result)
        status = SkillInvocationStatus.SUCCESS if ok else SkillInvocationStatus.SKILL_ERROR
        self._log_completion(skill_name, ok, output)
        return SkillInvocationResult(
            ok=ok,
            mode=SkillInvocationMode.DIRECT,
            status=status,
            output=output,
            metadata=metadata,
        )

    # ── helpers ────────────────────────────────────────────────────────────

    def _log_completion(self, skill_name: str, ok: bool, output: str | None) -> None:
        tail = (output or "")[-self._RESULT_TAIL_CHARS:]
        print(
            f"\n[skill← {skill_name} ok={ok}]"
            f"\n----- last {self._RESULT_TAIL_CHARS} chars of skill output -----\n{tail}"
            f"\n-----------------------------------------",
            flush=True,
        )


def _normalise_skill_result(result: Any) -> tuple[bool, str | None, dict]:
    """Coerce a skill's per-skill result type into (ok, output, metadata)."""
    if result is None:
        return True, None, {}
    # Pydantic model with model_dump
    if hasattr(result, "model_dump"):
        d = result.model_dump()
        ok = bool(d.get("ok", True))
        output = _stringify(d)
        return ok, output, d
    # plain dict
    if isinstance(result, dict):
        ok = bool(result.get("ok", True))
        return ok, _stringify(result), result
    # boolean
    if isinstance(result, bool):
        return result, str(result), {}
    # everything else — treat as opaque success
    return True, _stringify(result), {}


def _stringify(v: Any) -> str:
    if v is None: return ""
    if isinstance(v, str): return v
    try:
        import json
        return json.dumps(v, default=str, indent=2)
    except Exception:  # noqa: BLE001
        return repr(v)


__all__ = ["SkillService"]
