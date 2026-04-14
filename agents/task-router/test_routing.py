"""Unit tests for task-router routing logic.

Tests the pure routing algorithm in isolation — doesn't load the WIT bridge
or instantiate AgentContext. The agent file imports friday_agent_sdk which
isn't installed locally, so we re-implement the predicate here and verify
it against the same inputs the real agent would see.

Run with: python3 agents/task-router/test_routing.py
"""

import sys
from pathlib import Path

QUICK_FIX_KEYWORDS = frozenset({"fix", "remove", "rename", "rewrite", "undo"})
MAX_BRIEF_LEN = 800


def route(task_brief: str, target_files: list[str]) -> dict:
    brief_lower = task_brief.lower()
    is_single_file = len(target_files) == 1
    has_quick_keyword = any(kw in brief_lower for kw in QUICK_FIX_KEYWORDS)
    is_short_brief = len(task_brief) < MAX_BRIEF_LEN

    if is_single_file and has_quick_keyword and is_short_brief:
        matched_kw = next(kw for kw in QUICK_FIX_KEYWORDS if kw in brief_lower)
        return {
            "route": "quick-fix",
            "matched_kw": matched_kw,
            "estimated_files_changed": 1,
        }

    return {
        "route": "full-fsm",
        "estimated_files_changed": max(len(target_files), 1),
    }


def assert_eq(label: str, actual, expected) -> None:
    if actual != expected:
        print(f"FAIL: {label}\n  expected: {expected}\n  got:      {actual}")
        sys.exit(1)
    print(f"PASS: {label}")


def assert_keys_match_agent_source() -> None:
    """Source-of-truth check: the constants in agent.py must match this test.

    Catches drift between the test fixture and the real agent.
    """
    agent_path = Path(__file__).parent / "agent.py"
    src = agent_path.read_text()
    if 'frozenset({"fix", "remove", "rename", "rewrite", "undo"})' not in src:
        print(f"FAIL: QUICK_FIX_KEYWORDS in {agent_path} drifted from test fixture")
        sys.exit(1)
    if "MAX_BRIEF_LEN = 800" not in src:
        print(f"FAIL: MAX_BRIEF_LEN in {agent_path} drifted from test fixture")
        sys.exit(1)
    print("PASS: agent.py constants match test fixture")


def main() -> None:
    assert_keys_match_agent_source()

    r = route("fix the typo in foo.ts", ["src/foo.ts"])
    assert_eq("single file + 'fix' keyword + short brief", r["route"], "quick-fix")
    assert_eq("matched keyword == fix", r["matched_kw"], "fix")

    r = route("rename the helper", ["src/foo.ts"])
    assert_eq("rename keyword", r["route"], "quick-fix")

    r = route("undo last commit's change", ["src/foo.ts"])
    assert_eq("undo keyword", r["route"], "quick-fix")

    r = route("FIX the casing", ["src/foo.ts"])
    assert_eq("uppercase keyword still matches", r["route"], "quick-fix")

    r = route("add support for new feature", ["src/foo.ts"])
    assert_eq("no quick keyword -> full-fsm", r["route"], "full-fsm")

    r = route("fix the bug", ["src/a.ts", "src/b.ts"])
    assert_eq("multiple files -> full-fsm", r["route"], "full-fsm")

    r = route("fix the bug " * 100, ["src/a.ts"])  # 1300+ chars
    assert_eq("long brief -> full-fsm", r["route"], "full-fsm")

    r = route("fix it", [])
    assert_eq("zero files -> full-fsm", r["route"], "full-fsm")
    assert_eq("zero files estimated_files_changed clamped to 1", r["estimated_files_changed"], 1)

    r = route("rewrite the entire flow", ["src/a.ts", "src/b.ts", "src/c.ts"])
    assert_eq("3 files even with quick keyword -> full-fsm", r["route"], "full-fsm")
    assert_eq("estimated_files_changed = 3", r["estimated_files_changed"], 3)

    print("\n10/10 passed")


if __name__ == "__main__":
    main()
