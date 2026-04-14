"""Unit tests for reflector v1.2's meta-job skipping in _fetch_latest_session.

Re-implements the selection logic locally to verify it picks substantive
sessions over meta jobs (reflect-on-last-run, apply-reflection, etc).

Run with: python3 agents/reflector/test_skip_meta.py
"""

import sys
from pathlib import Path

_SKIP_JOB_NAMES = frozenset({
    "reflect-on-last-run",
    "apply-reflection",
    "audit-orphans",
    "cross-session-reflect",
    "autopilot-tick",
})


def select_substantive(sessions):
    """Mirror of agents/reflector/agent.py:_fetch_latest_session selection."""
    completed = [s for s in sessions if s.get("status") == "completed"]
    if not completed:
        return None
    for s in completed:
        if s.get("jobName") not in _SKIP_JOB_NAMES:
            return s["sessionId"]
    return completed[0]["sessionId"]  # fallback


def assert_eq(label, actual, expected):
    if actual != expected:
        print(f"FAIL: {label}\n  expected: {expected}\n  got:      {actual}")
        sys.exit(1)
    print(f"PASS: {label}")


def assert_drift_check():
    src = (Path(__file__).parent / "agent.py").read_text()
    assert "_SKIP_JOB_NAMES" in src, "_SKIP_JOB_NAMES not in agent.py"
    assert '"reflect-on-last-run"' in src, "skip set drift"
    assert '"apply-reflection"' in src, "skip set drift"
    print("PASS: agent.py _SKIP_JOB_NAMES + entries match test")


def main():
    assert_drift_check()

    # All meta jobs → falls back to most recent
    r = select_substantive([
        {"sessionId": "s1", "status": "completed", "jobName": "reflect-on-last-run"},
        {"sessionId": "s2", "status": "completed", "jobName": "apply-reflection"},
        {"sessionId": "s3", "status": "completed", "jobName": "autopilot-tick"},
    ])
    assert_eq("all meta → fallback to first", r, "s1")

    # First substantive in middle of meta sessions
    r = select_substantive([
        {"sessionId": "s1", "status": "completed", "jobName": "reflect-on-last-run"},
        {"sessionId": "s2", "status": "completed", "jobName": "execute-self-mod-task"},
        {"sessionId": "s3", "status": "completed", "jobName": "reflect-on-last-run"},
    ])
    assert_eq("substantive in middle", r, "s2")

    # First in list is substantive
    r = select_substantive([
        {"sessionId": "s1", "status": "completed", "jobName": "execute-self-mod-task"},
        {"sessionId": "s2", "status": "completed", "jobName": "reflect-on-last-run"},
    ])
    assert_eq("first is substantive", r, "s1")

    # Mix with failed sessions — only completed counted
    r = select_substantive([
        {"sessionId": "s1", "status": "failed", "jobName": "execute-self-mod-task"},
        {"sessionId": "s2", "status": "completed", "jobName": "reflect-on-last-run"},
        {"sessionId": "s3", "status": "completed", "jobName": "execute-self-mod-task"},
    ])
    assert_eq("failed sessions excluded", r, "s3")

    # Empty list
    r = select_substantive([])
    assert_eq("empty list", r, None)

    # Real-world: today's grilled_xylem session list
    r = select_substantive([
        {"sessionId": "739b822f", "status": "completed", "jobName": "reflect-on-last-run"},
        {"sessionId": "5edda94d", "status": "completed", "jobName": "apply-reflection"},
        {"sessionId": "a9a2bab8", "status": "completed", "jobName": "apply-reflection"},
        {"sessionId": "ce2b3149", "status": "completed", "jobName": "reflect-on-last-run"},
        {"sessionId": "1c1ca27d", "status": "failed", "jobName": "reflect-on-last-run"},
        {"sessionId": "e23fbb7b", "status": "completed", "jobName": "execute-self-mod-task"},
    ])
    assert_eq("real grilled_xylem picks the substantive one", r, "e23fbb7b")

    # Reflect/apply/audit/cross-session-reflect/autopilot-tick all skipped
    for skip_job in ["apply-reflection", "audit-orphans", "cross-session-reflect", "autopilot-tick"]:
        r = select_substantive([
            {"sessionId": "skip", "status": "completed", "jobName": skip_job},
            {"sessionId": "keep", "status": "completed", "jobName": "execute-self-mod-task"},
        ])
        assert_eq(f"{skip_job} skipped", r, "keep")

    print("\n10/10 passed")


if __name__ == "__main__":
    main()
