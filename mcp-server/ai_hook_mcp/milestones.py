"""Milestone narration — turn raw pipeline logs into the user-facing story.

The pipeline's subprocesses print detailed, prefix-stacked log lines
(`[content-extractor] [crawler] intent-extract: page 3/7 — …`). The host
chat panel wants the STORY, not the firehose:

    [scanner] starting crawler
    [crawler] page 3/7: /settings → LLM (14 clickables)
    [crawler] complete → sent to output/crawler/ (312.4 KB)
    [graphify] complete → output/graphify/ (38.1s)
    …

`match(line)` maps one raw line to one milestone string (or None).
`Narrator` decides what reaches ctx.info: milestones always; raw lines only
in verbose mode, capped so a huge crawl can't flood the host.

Pure module — no MCP imports — so it unit-tests against captured log files.
"""

from __future__ import annotations

import re
from typing import Callable, Optional

# Subprocess prefixes stack in parallel mode: run.mjs prepends its own tag to
# lines that already carry one (`[content-extractor] [crawler] …`, sometimes
# three deep). Strip the whole run of leading tags before matching.
_TAGS = re.compile(r"^(?:\s*\[[\w-]+\]\s*)+")


def strip_tags(line: str) -> str:
    return _TAGS.sub("", line).strip()


def _stage(m: re.Match) -> str:
    return f"[scanner] starting {m.group(1).strip()}"


_SOURCE_LABELS = {
    "crawler": "[scanner] starting crawler",
    "graphify": "[graphify] starting (code knowledge graph)",
    "framework-detector": "[scanner] starting framework detector",
}


def _source_start(m: re.Match) -> Optional[str]:
    # Only the story-level sources get a start milestone; the long tail of
    # code-extractors would drown the narration.
    return _SOURCE_LABELS.get(m.group(1))


MILESTONES: list[tuple[re.Pattern, Callable[[re.Match], Optional[str]]]] = [
    (re.compile(r"^━+\s*(stage \d+[^━]*?)\s*━+$"), _stage),
    (re.compile(r"^→\s+([\w-]+)\s+\(start\)"), _source_start),
    (re.compile(r"^○\s+graphify\s+\(skipped: TARGET_CODEBASE not set\)"),
     lambda m: "[graphify] skipped (no codebase provided)"),
    (re.compile(r"^✗\s+([\w-]+)\s+exited\s+(\d+)"),
     lambda m: f"[scanner] {m.group(1)} FAILED (exit {m.group(2)})"),
    (re.compile(r"^parallel-DFS walker — seeds=(\d+)\s+workers=(\d+)"),
     lambda m: f"[crawler] crawling app ({m.group(1)} seed(s), {m.group(2)} workers)"),
    (re.compile(r"login form detected, signing in"),
     lambda m: "[crawler] login form detected — signing in"),
    (re.compile(r"^intent-extract: (\d+)/(\d+) pages have clickables"),
     lambda m: f"[crawler] classifying clickables on {m.group(1)} page(s) via host LLM"),
    (re.compile(r"^intent-extract: page (\d+)/(\d+) — (\S+)\s+\((\d+) clickables"),
     lambda m: f"[crawler] page {m.group(1)}/{m.group(2)}: {m.group(3)} → LLM ({m.group(4)} clickables)"),
    # `↳ batch i/n …` lines are deliberately NOT matched: the sampling bridge
    # already narrates every send/receive round-trip.
    (re.compile(r"^intent-extract: annotated (\d+) clickables across (\d+)/(\d+) pages in ([\d.]+)s"),
     lambda m: f"[crawler] intents done — {m.group(1)} clickables across {m.group(2)}/{m.group(3)} pages ({m.group(4)}s)"),
    (re.compile(r"^wrote output/crawler/bundle\.json \(([\d.]+) KB\)"),
     lambda m: f"[crawler] complete → sent to output/crawler/ ({m.group(1)} KB)"),
    (re.compile(r"^✓\s+crawler\s+\((\d+)ms\)"),
     lambda m: None),  # bundle line above already told the story
    (re.compile(r"^✓\s+graphify\s+\((\d+)ms\)"),
     lambda m: f"[graphify] complete → output/graphify/ ({int(m.group(1)) / 1000:.1f}s)"),
    (re.compile(r'^stats: \{"nodes":(\d+),"edges":(\d+)'),
     lambda m: f"[graphify] graph: {m.group(1)} nodes, {m.group(2)} edges"),
    (re.compile(r"^✓\s+framework-detector\s+\((\d+)ms\)"),
     lambda m: f"[scanner] framework detection done ({m.group(1)}ms)"),
    (re.compile(r"^loading source bundles"),
     lambda m: "[indexer] starting — merging sources into topics"),
    (re.compile(r"^wrote output/indexed_output/index\.json"),
     lambda m: "[indexer] complete → output/indexed_output/"),
    (re.compile(r"^total topics: (\d+)"),
     lambda m: f"[indexer] {m.group(1)} topics indexed"),
    (re.compile(r"^login OK — token captured"),
     lambda m: "[executor] login OK — token captured"),
    (re.compile(r"^login FAILED: (.+)"),
     lambda m: f"[executor] login FAILED: {m.group(1)}"),
    (re.compile(r"^([✓✗])\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)\s+→\s+(\S+)"),
     lambda m: f"[executor] {m.group(1)} {m.group(2)} {m.group(3)} → {m.group(4)}"),
]

_TEST_LINE = MILESTONES[-1][0]          # per-test row — capped by the Narrator
_EXEMPT = re.compile(r"^⊘\s+.+→ skipped \(exempt")


def match(line: str) -> Optional[str]:
    body = strip_tags(line)
    for rx, render in MILESTONES:
        m = rx.match(body) or rx.search(line)
        if m:
            return render(m)
    return None


class Narrator:
    """Decides which lines reach ctx.info — milestones always (with a cap on
    per-test rows), raw relay only in verbose mode and capped."""

    def __init__(self, ctx, verbose: bool = False, raw_cap: int = 400, test_cap: int = 30):
        self.ctx = ctx
        self.verbose = verbose
        self.raw_cap = raw_cap
        self.test_cap = test_cap
        self._raw_seen = 0
        self._tests_seen = 0
        self._exempt_seen = 0

    async def feed(self, label: str, line: str) -> None:
        body = strip_tags(line)
        if _EXEMPT.match(body):
            self._exempt_seen += 1          # summarized once in finish()
            return
        milestone = match(line)
        if milestone:
            if _TEST_LINE.match(body):
                self._tests_seen += 1
                if self._tests_seen == self.test_cap + 1:
                    await self.ctx.info("[executor] … more test results in report.md")
                if self._tests_seen > self.test_cap:
                    return
            await self.ctx.info(milestone)
            return
        if self.verbose:
            if self._raw_seen < self.raw_cap:
                await self.ctx.info(f"[{label}] {body or line}")
            elif self._raw_seen == self.raw_cap:
                await self.ctx.info(f"[{label}] … raw log capped at {self.raw_cap} lines (full log in output/)")
            self._raw_seen += 1

    async def say(self, text: str) -> None:
        await self.ctx.info(text)

    async def finish(self) -> None:
        if self._exempt_seen:
            await self.ctx.info(f"[executor] {self._exempt_seen} session-mutating endpoint(s) exempted")
