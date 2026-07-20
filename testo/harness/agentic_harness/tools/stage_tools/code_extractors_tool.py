"""scan.code_extractors — static per-framework code extraction over a codebase.

Wraps context-layer/content-extractor/run.mjs, which runs framework detection
then the recommended per-framework extractors (FastAPI/Flask/Django/Spring/
React-Router/Next.js/… routes+endpoints) plus db-schema. Crawler and graphify
are skipped here — graphify is its own tool. Writes output/code-extractors/*.json.
"""

from __future__ import annotations

from pydantic import BaseModel, Field

from agentic_harness.tools.subprocess_stage import (
    REPO_ROOT,
    SubprocessStageTool,
    read_json,
)


class CodeExtractorsArgs(BaseModel):
    target_codebase: str = Field(..., description="Absolute path to the local repo/codebase to analyze.")
    only: str | None = Field(None, description="Comma-separated extractor ids to limit to (e.g. 'python-fastapi,react-router'). Omit to auto-detect.")
    include_db_schema: bool = Field(True, description="Also run the DB-schema extractor.")


class CodeExtractorsTool(SubprocessStageTool):
    name = "scan.code_extractors"
    description = (
        "Statically extract API routes, UI routes, form fields and framework "
        "facts from a local codebase using the per-framework extractors "
        "(auto-detected, or pass `only`). Give it target_codebase (abs path). "
        "Writes output/code-extractors/*.json. Runs in seconds."
    )
    input_model = CodeExtractorsArgs

    ENTRYPOINT = "context-layer/content-extractor/run.mjs"
    RUNTIME = "node"
    SILENCE_KILL_S = 300.0
    WALL_S = 900.0

    def build_env(self, args: CodeExtractorsArgs) -> dict[str, str | None]:
        skip = ["crawler", "graphify"]
        if not args.include_db_schema:
            skip.append("db-schema")
        return {
            "TARGET_CODEBASE": args.target_codebase,
            "SKIP": ",".join(skip),
            "ONLY": args.only,           # ONLY gates code-extractors when set
        }

    def expected_outputs(self, args: CodeExtractorsArgs) -> list[str]:
        return ["output/code-extractors", "output/framework-detector/framework-detection.json"]

    def summarize(self, exit_code: int, args: CodeExtractorsArgs) -> dict:
        det = read_json("output/framework-detector/framework-detection.json") or {}
        ce_dir = REPO_ROOT / "output" / "code-extractors"
        files = sorted(p.name for p in ce_dir.glob("*.json")) if ce_dir.is_dir() else []
        endpoints = routes = 0
        for name in files:
            data = read_json(f"output/code-extractors/{name}") or {}
            endpoints += len(data.get("endpoints", []) or [])
            routes += len(data.get("routes", []) or [])
        return {
            "ok": exit_code == 0,
            "counts": {
                "extractorsRun": len(files),
                "endpoints": endpoints,
                "routes": routes,
                "recommended": det.get("recommendedExtractors", []),
            },
        }
