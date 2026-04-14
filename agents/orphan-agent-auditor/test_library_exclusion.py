"""Unit test for orphan-agent-auditor v1.2's library_agents exclusion.

Re-implements the orphan computation locally (since friday_agent_sdk isn't
installed for this test runner). Drift-checks against agent.py source.

Run with: python3 agents/orphan-agent-auditor/test_library_exclusion.py
"""

import sys
from pathlib import Path


def compute_orphans(user_agent_ids, referenced_ids, library_agent_ids):
    """Mirror of agents/orphan-agent-auditor/agent.py orphan computation."""
    referenced_set = set(referenced_ids)
    raw_orphan_ids = set(user_agent_ids) - referenced_set
    library_orphans = sorted(raw_orphan_ids & set(library_agent_ids))
    orphan_ids = raw_orphan_ids - set(library_agent_ids)
    return {
        "orphans": sorted(orphan_ids),
        "library_orphans_excluded": library_orphans,
        "referenced_count": len(referenced_set & set(user_agent_ids)),
    }


def assert_eq(label, actual, expected):
    if actual != expected:
        print(f"FAIL: {label}\n  expected: {expected}\n  got:      {actual}")
        sys.exit(1)
    print(f"PASS: {label}")


def assert_drift_check():
    src = (Path(__file__).parent / "agent.py").read_text()
    assert 'config.get("library_agents"' in src, "library_agents config field missing"
    assert "raw_orphan_ids - library_agent_ids" in src, "orphan exclusion math drift"
    assert "library_orphans_excluded" in src, "result field missing"
    print("PASS: agent.py library_agents logic + result field present")


def main():
    assert_drift_check()

    # No library agents → all orphans are flagged
    r = compute_orphans(
        user_agent_ids=["a", "b", "c", "d"],
        referenced_ids=["a", "b"],
        library_agent_ids=[],
    )
    assert_eq("no library exclusion", r["orphans"], ["c", "d"])
    assert_eq("no library_orphans", r["library_orphans_excluded"], [])
    assert_eq("ref count", r["referenced_count"], 2)

    # Library agent that's NOT referenced → excluded from orphans
    r = compute_orphans(
        user_agent_ids=["a", "b", "library1"],
        referenced_ids=["a"],
        library_agent_ids=["library1"],
    )
    assert_eq("library agent excluded from orphans", r["orphans"], ["b"])
    assert_eq("library agent in library_orphans", r["library_orphans_excluded"], ["library1"])
    assert_eq("ref count", r["referenced_count"], 1)

    # Library agent that IS referenced → not in orphans, not in library_orphans
    r = compute_orphans(
        user_agent_ids=["a", "library1"],
        referenced_ids=["a", "library1"],
        library_agent_ids=["library1"],
    )
    assert_eq("referenced library has no orphans", r["orphans"], [])
    assert_eq("referenced library has no library_orphans", r["library_orphans_excluded"], [])
    assert_eq("ref count", r["referenced_count"], 2)

    # Real-world current state (autopilot)
    r = compute_orphans(
        user_agent_ids=[
            "autopilot-dispatcher",
            "autopilot-planner",
            "multi-session-reflector",
            "orphan-agent-auditor",
            "reflection-aggregator",
            "reflector",
            "session-summarizer",
            "skill-author",
            "skill-publisher",
            "task-router",
            "workspace-creator",
        ],
        referenced_ids=[
            "autopilot-dispatcher",
            "autopilot-planner",
            "multi-session-reflector",
            "orphan-agent-auditor",
            "reflector",
            "skill-author",
            "skill-publisher",
            "task-router",
        ],
        library_agent_ids=["session-summarizer", "reflection-aggregator"],
    )
    assert_eq("real autopilot orphans", r["orphans"], ["workspace-creator"])
    assert_eq(
        "real autopilot library_orphans",
        r["library_orphans_excluded"],
        ["reflection-aggregator", "session-summarizer"],
    )
    assert_eq("real autopilot ref count", r["referenced_count"], 8)

    print("\n12/12 passed")


if __name__ == "__main__":
    main()
