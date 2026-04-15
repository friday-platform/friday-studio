"""Unit test for _narrative_entries_to_backlog dedupe.

The planner's narrative corpus is append-only: a task_id gets a new entry on
every status transition (pending → completed). Without dedupe, the stale
`pending` entry stays in the task list and passes the eligibility filter,
causing the planner to re-dispatch the task every cooldown cycle.

This test imports the real helper from agent.py — it's pure stdlib, no SDK
dependency, so it runs under plain python3.

Run with: python3 agents/autopilot-planner/test_backlog_dedupe.py
"""

import sys
from pathlib import Path

# Stub out friday_agent_sdk so `import agent` doesn't blow up — the module
# imports the SDK at the top but we only touch the pure helper.
sys.modules.setdefault("friday_agent_sdk", type(sys)("friday_agent_sdk"))
sys.modules["friday_agent_sdk"].agent = lambda **kwargs: (lambda fn: fn)
sys.modules["friday_agent_sdk"].ok = lambda v: {"ok": True, "data": v}
sys.modules["friday_agent_sdk"].err = lambda m: {"ok": False, "error": m}
sys.modules.setdefault("friday_agent_sdk._bridge", type(sys)("friday_agent_sdk._bridge"))
sys.modules["friday_agent_sdk._bridge"].Agent = object

sys.path.insert(0, str(Path(__file__).parent))
from agent import _narrative_entries_to_backlog  # noqa: E402


def test_dedupes_pending_and_completed_for_same_id():
    entries = [
        {
            "id": "task-a",
            "text": "do thing",
            "createdAt": "2026-04-14T21:58:34Z",
            "metadata": {"status": "pending", "priority": 50},
        },
        {
            "id": "task-a",
            "text": "do thing (completed)",
            "createdAt": "2026-04-14T22:06:12Z",
            "metadata": {"status": "completed", "priority": 50},
        },
    ]
    result = _narrative_entries_to_backlog(entries)
    tasks = result["tasks"]
    assert len(tasks) == 1, f"expected 1 task after dedupe, got {len(tasks)}"
    assert tasks[0]["status"] == "completed", f"latest entry wins, got {tasks[0]['status']}"
    assert tasks[0]["created_at"] == "2026-04-14T22:06:12Z"


def test_keeps_distinct_ids():
    entries = [
        {"id": "a", "createdAt": "2026-04-14T10:00:00Z", "metadata": {"status": "pending"}},
        {"id": "b", "createdAt": "2026-04-14T10:00:00Z", "metadata": {"status": "pending"}},
        {"id": "c", "createdAt": "2026-04-14T10:00:00Z", "metadata": {"status": "completed"}},
    ]
    result = _narrative_entries_to_backlog(entries)
    ids = sorted(t["id"] for t in result["tasks"])
    assert ids == ["a", "b", "c"], f"expected [a,b,c], got {ids}"


def test_rejected_shadows_pending():
    entries = [
        {"id": "x", "createdAt": "2026-04-14T10:00:00Z", "metadata": {"status": "pending"}},
        {"id": "x", "createdAt": "2026-04-14T11:00:00Z", "metadata": {"status": "rejected"}},
    ]
    result = _narrative_entries_to_backlog(entries)
    tasks = result["tasks"]
    assert len(tasks) == 1
    assert tasks[0]["status"] == "rejected"


def test_out_of_order_entries():
    # Latest-by-createdAt must win regardless of list order.
    entries = [
        {"id": "y", "createdAt": "2026-04-14T22:00:00Z", "metadata": {"status": "completed"}},
        {"id": "y", "createdAt": "2026-04-14T21:00:00Z", "metadata": {"status": "pending"}},
    ]
    result = _narrative_entries_to_backlog(entries)
    assert result["tasks"][0]["status"] == "completed"


def test_empty_entries():
    assert _narrative_entries_to_backlog([]) == {"tasks": []}


def test_entries_without_id_are_dropped():
    entries = [
        {"id": "", "createdAt": "2026-04-14T10:00:00Z", "metadata": {"status": "pending"}},
        {"id": "a", "createdAt": "2026-04-14T10:00:00Z", "metadata": {"status": "pending"}},
    ]
    result = _narrative_entries_to_backlog(entries)
    assert len(result["tasks"]) == 1
    assert result["tasks"][0]["id"] == "a"


if __name__ == "__main__":
    tests = [
        test_dedupes_pending_and_completed_for_same_id,
        test_keeps_distinct_ids,
        test_rejected_shadows_pending,
        test_out_of_order_entries,
        test_empty_entries,
        test_entries_without_id_are_dropped,
    ]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"  ✓ {t.__name__}")
        except AssertionError as e:
            print(f"  ✗ {t.__name__}: {e}")
            failed += 1
    if failed:
        print(f"\n{failed} failed")
        sys.exit(1)
    print(f"\nall {len(tests)} tests passed")
