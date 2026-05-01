#!/usr/bin/env python3
"""Lint a skill directory.

Validates the SKILL.md frontmatter, body budgets, reference depth, path
conventions, and known anti-patterns. Exits non-zero on errors; warnings
are informational.

Usage:
    python lint_skill.py path/to/skill/
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

# --- Budgets ----------------------------------------------------------------

MAX_NAME_LEN = 64
MAX_DESC_LEN = 1024

BODY_WARN_LINES = 500
BODY_ERR_LINES = 800
BODY_WARN_TOKENS = 5000
BODY_ERR_TOKENS = 8000

REF_WARN_LINES = 100  # above this, require a table of contents

# --- Patterns ---------------------------------------------------------------

NAME_RE = re.compile(r"^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$")
RESERVED = ("anthropic", "claude")

# Common first/second-person openings in descriptions.
FIRST_PERSON = re.compile(
    r"\b(I\s+(can|will|help)|you\s+(can|will)|this\s+skill\s+is)\b",
    re.IGNORECASE,
)

# Any `before 2024`, `after August 2025`, `until 2026` shape.
TIME_SENSITIVE = re.compile(
    r"\b(before|after|until|by)\s+[A-Z][a-z]+\s+\d{4}\b",
)

# backslash between identifier-like segments with a file extension.
BACKSLASH_PATH = re.compile(r"[A-Za-z_][A-Za-z0-9_]*\\[A-Za-z_][A-Za-z0-9_\\]*\.[a-z]+")

MARKDOWN_REF_LINK = re.compile(r"\[[^\]]+\]\(([^)]+\.md)\)")


# --- Frontmatter parsing ----------------------------------------------------


def split_frontmatter(text: str) -> tuple[dict[str, str], str]:
    """Return (frontmatter_dict, body). Minimal YAML parse — strings only."""
    if not text.startswith("---\n"):
        return {}, text
    end = text.find("\n---\n", 4)
    if end == -1:
        return {}, text
    fm: dict[str, str] = {}
    for line in text[4:end].splitlines():
        if ":" in line and not line.lstrip().startswith("-"):
            key, _, value = line.partition(":")
            fm[key.strip()] = value.strip().strip('"').strip("'")
    return fm, text[end + len("\n---\n") :]


def estimate_tokens(text: str) -> int:
    """Rough token estimate — ~4 chars per token."""
    return max(1, len(text) // 4)


# --- Checks -----------------------------------------------------------------


def check_frontmatter(fm: dict[str, str]) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []

    name = fm.get("name", "")
    if not name:
        errors.append("frontmatter: `name` missing")
    else:
        if len(name) > MAX_NAME_LEN:
            errors.append(f"frontmatter: name {len(name)} chars > {MAX_NAME_LEN}")
        if not NAME_RE.match(name):
            errors.append(f"frontmatter: name `{name}` does not match required pattern")
        for r in RESERVED:
            if r in name.lower():
                errors.append(f"frontmatter: name contains reserved substring `{r}`")

    desc = fm.get("description", "")
    if not desc:
        errors.append("frontmatter: `description` missing")
    else:
        if len(desc) > MAX_DESC_LEN:
            errors.append(f"frontmatter: description {len(desc)} chars > {MAX_DESC_LEN}")
        if FIRST_PERSON.search(desc):
            errors.append("frontmatter: description uses first/second person")
        lowered = desc.lower()
        if "use when" not in lowered and "used when" not in lowered:
            warnings.append(
                "frontmatter: description should include an explicit 'Use when …' trigger"
            )

    return errors, warnings


INLINE_CODE = re.compile(r"`[^`]*`")


def strip_inline_code(text: str) -> str:
    """Remove inline `…` segments so anti-example snippets don't trip checks."""
    return INLINE_CODE.sub("", text)


def check_body(body: str) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []

    lines = body.count("\n")
    tokens = estimate_tokens(body)

    if lines > BODY_ERR_LINES:
        errors.append(f"body: {lines} lines > {BODY_ERR_LINES}")
    elif lines > BODY_WARN_LINES:
        warnings.append(f"body: {lines} lines > {BODY_WARN_LINES}")

    if tokens > BODY_ERR_TOKENS:
        errors.append(f"body: ~{tokens} tokens > {BODY_ERR_TOKENS}")
    elif tokens > BODY_WARN_TOKENS:
        warnings.append(f"body: ~{tokens} tokens > {BODY_WARN_TOKENS}")

    # Skip inline-code segments: they're almost always anti-examples,
    # not prose the agent will follow.
    prose = strip_inline_code(body)

    if TIME_SENSITIVE.search(prose):
        warnings.append(
            "body: time-sensitive phrasing found — move to a `<details>` Old patterns block"
        )

    if BACKSLASH_PATH.search(prose):
        errors.append("body: Windows-style path found — use forward slashes")

    return errors, warnings


def check_references(skill_dir: Path, body: str) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []

    direct_refs = MARKDOWN_REF_LINK.findall(body)
    for ref in direct_refs:
        if ref.startswith(("http://", "https://", "#")):
            continue
        ref_path = (skill_dir / ref).resolve()
        if not ref_path.exists():
            errors.append(f"references: broken link `{ref}`")
            continue

        ref_text = ref_path.read_text(encoding="utf-8", errors="replace")

        # Depth check — anything the reference links to should not be a new .md.
        nested = [
            n for n in MARKDOWN_REF_LINK.findall(ref_text)
            if not n.startswith(("http://", "https://", "#"))
            and n.endswith(".md")
        ]
        if nested:
            warnings.append(
                f"references: {ref} links to {nested} (depth > 1 — Claude may partial-read)"
            )

        ref_lines = ref_text.count("\n")
        if ref_lines > REF_WARN_LINES:
            if "## Contents" not in ref_text and "## contents" not in ref_text.lower():
                warnings.append(
                    f"references: {ref} is {ref_lines} lines without a `## Contents` section"
                )

    return errors, warnings


# --- Entry point ------------------------------------------------------------


def lint(skill_dir: Path) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []

    skill_md = skill_dir / "SKILL.md"
    if not skill_md.exists():
        errors.append(f"SKILL.md missing at {skill_md}")
        return errors, warnings

    text = skill_md.read_text(encoding="utf-8")
    fm, body = split_frontmatter(text)

    fe, fw = check_frontmatter(fm)
    errors.extend(fe)
    warnings.extend(fw)

    be, bw = check_body(body)
    errors.extend(be)
    warnings.extend(bw)

    re_errs, re_warns = check_references(skill_dir, body)
    errors.extend(re_errs)
    warnings.extend(re_warns)

    return errors, warnings


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: lint_skill.py path/to/skill/", file=sys.stderr)
        return 2

    skill_dir = Path(argv[1])
    if not skill_dir.is_dir():
        print(f"not a directory: {skill_dir}", file=sys.stderr)
        return 2

    errors, warnings = lint(skill_dir)

    for w in warnings:
        print(f"WARN   {w}")
    for e in errors:
        print(f"ERROR  {e}")

    if not errors and not warnings:
        print("ok")

    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
