"""scan.crawler — headless live crawl of a web app → output/crawler/bundle.json.

Wraps context-layer/content-extractor/crawler/extract.mjs (which runs the
context-layer/content-extractor/crawler parallel-DFS Playwright walker, then analyzes + optionally
annotates intents via MiniMax). Reuses output/crawler/auth-state.json for
SSO'd apps (produced by a one-time `npm run login`).
"""

from __future__ import annotations

from pydantic import BaseModel, Field

from agentic_harness.tools.subprocess_stage import SubprocessStageTool, read_json


class CrawlerArgs(BaseModel):
    base_url: str = Field(..., description="Target app root URL to crawl, e.g. https://app.example.com")
    login_email: str | None = Field(None, description="Login email (only if the app uses a login form).")
    login_password: str | None = Field(None, description="Login password.")
    reuse_existing: bool = Field(False, description="Reuse the prior crawl instead of re-crawling (SKIP_CRAWL=1).")


class CrawlerTool(SubprocessStageTool):
    name = "scan.crawler"
    description = (
        "Crawl a live web app headlessly and produce a normalized source bundle "
        "(endpoints, pages, click-graph, redirects, auth + LLM intent annotations). "
        "Give it base_url. Writes output/crawler/bundle.json. Runs for minutes."
    )
    input_model = CrawlerArgs

    ENTRYPOINT = "context-layer/content-extractor/crawler/extract.mjs"
    RUNTIME = "node"
    SILENCE_KILL_S = 900.0
    WALL_S = 3600.0

    def build_env(self, args: CrawlerArgs) -> dict[str, str | None]:
        return {
            "BASE_URL": args.base_url,
            "LOGIN_EMAIL": args.login_email,
            "LOGIN_PASSWORD": args.login_password,
            "SKIP_CRAWL": "1" if args.reuse_existing else None,
        }

    def expected_outputs(self, args: CrawlerArgs) -> list[str]:
        return ["output/crawler/bundle.json", "output/crawler/data"]

    def summarize(self, exit_code: int, args: CrawlerArgs) -> dict:
        b = read_json("output/crawler/bundle.json")
        if not b:
            return {"ok": exit_code == 0, "counts": {}}
        stats = b.get("stats", {}) or {}
        return {
            "ok": exit_code == 0,
            "baseUrl": (b.get("target", {}) or {}).get("baseUrl"),
            "counts": {
                "endpoints": stats.get("endpoints"),
                "pages": stats.get("pages"),
                "clickEdges": stats.get("clickEdges"),
                "intentsAnnotated": stats.get("intentsAnnotated"),
            },
        }
