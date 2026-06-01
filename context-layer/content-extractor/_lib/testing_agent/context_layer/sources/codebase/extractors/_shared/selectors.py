"""Shared selector-extraction helpers for HTML/JSX/Svelte/Vue templates.

Returns flat dicts (matching the flat schema on `Interaction` and
`FormField`) keyed by snake_case intent.

The ladder (testid > role+name > aria-label > text) is identical across
the convention-based frontend extractors. One canonical implementation
prevents drift when the ladder evolves.

Output shape (per intent key):
    {
      "selector_strategy": "testid" | "role" | "label" | "text",
      "selector_value": "<the literal>",
      "selector_role": "<role>" | None,   # populated only when strategy="role"
      "selector_name": "<aria-name>" | None,
      "element_tag": "<tag>" | None,       # populated for text-strategy
      "is_destructive": bool,              # heuristic on the value text
    }
"""

from __future__ import annotations

import re
from typing import Any


MAX_SELECTORS_PER_ROUTE = 12

# Lenient regexes — tolerate whitespace and quote style. False positives
# are bounded by literal strings having to appear in the source.
_TESTID_RE = re.compile(
    r"""data-testid\s*=\s*["']([^"']+)["']"""
)
_ARIA_LABEL_RE = re.compile(r"""aria-label\s*=\s*["']([^"']+)["']""")
_ROLE_NAME_RE = re.compile(
    r"""role\s*=\s*["']([^"']+)["'][^>]*?aria-label\s*=\s*["']([^"']+)["']"""
)
_TEXT_TAG_RE = re.compile(
    r"""<(?P<tag>button|h[1-6]|a|label|p)\b[^>]*>\s*(?P<text>[^<{]+?)\s*</(?P=tag)>""",
    re.DOTALL,
)

# Destructive-action detection — used by Interaction.is_destructive.
_DESTRUCTIVE_RE = re.compile(
    r"\b(delete|remove|destroy|cancel.*account|drop|purge|terminate|revoke)\b",
    re.IGNORECASE,
)


def extract_selectors(content: str) -> dict[str, dict[str, Any]]:
    """Strict selector ladder. Returns ≤ `MAX_SELECTORS_PER_ROUTE`.

    Order: testid > role+name > aria-label > visible text. Earlier
    strategies win when the same intent key appears at multiple levels —
    never overwrite a stronger anchor with a weaker one.
    """
    selectors: dict[str, dict[str, Any]] = {}

    # 1. testid
    for value in _TESTID_RE.findall(content):
        intent = intent_key(value)
        if intent and intent not in selectors:
            selectors[intent] = {
                "selector_strategy": "testid",
                "selector_value": value,
                "selector_role": None,
                "selector_name": None,
                "element_tag": None,
                "is_destructive": _is_destructive(value),
            }
        if len(selectors) >= MAX_SELECTORS_PER_ROUTE:
            return selectors

    # 2. role + aria-label combos
    seen_aria_pairs: set[tuple[str, str]] = set()
    for role, name in _ROLE_NAME_RE.findall(content):
        seen_aria_pairs.add((role, name))
        intent = intent_key(f"{role}_{name}")
        if intent and intent not in selectors:
            selectors[intent] = {
                "selector_strategy": "role",
                "selector_value": role,
                "selector_role": role,
                "selector_name": name,
                "element_tag": None,
                "is_destructive": _is_destructive(name),
            }
        if len(selectors) >= MAX_SELECTORS_PER_ROUTE:
            return selectors

    # 3. plain aria-label (skipping those captured by role+name)
    for label in _ARIA_LABEL_RE.findall(content):
        if any(label == n for _, n in seen_aria_pairs):
            continue
        intent = intent_key(label)
        if intent and intent not in selectors:
            selectors[intent] = {
                "selector_strategy": "label",
                "selector_value": label,
                "selector_role": None,
                "selector_name": None,
                "element_tag": None,
                "is_destructive": _is_destructive(label),
            }
        if len(selectors) >= MAX_SELECTORS_PER_ROUTE:
            return selectors

    # 4. visible text from buttons / headings / labels / anchors
    for match in _TEXT_TAG_RE.finditer(content):
        tag = match.group("tag")
        text = " ".join(match.group("text").split())
        if not text or len(text) > 80:
            continue
        # Skip templated text the regex let through.
        if "{" in text or "}" in text:
            continue
        intent = intent_key(f"{tag}_{text}")
        if intent and intent not in selectors:
            selectors[intent] = {
                "selector_strategy": "text",
                "selector_value": text,
                "selector_role": None,
                "selector_name": None,
                "element_tag": tag,
                "is_destructive": _is_destructive(text),
            }
        if len(selectors) >= MAX_SELECTORS_PER_ROUTE:
            return selectors

    return selectors


def intent_key(raw: str) -> str:
    """Convert free-form text into a stable snake_case identifier."""
    cleaned = re.sub(r"[^a-zA-Z0-9]+", "_", raw).strip("_").lower()
    return cleaned[:60]


def _is_destructive(text: str) -> bool:
    return bool(_DESTRUCTIVE_RE.search(text))
