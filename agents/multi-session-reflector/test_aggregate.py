"""Unit tests for multi-session-reflector's _outcome_label + _aggregate_summaries.

Both are pure-Python aggregations with no LLM call. Re-implements them
locally for testing (since friday_agent_sdk isn't installed).

Run with: python3 agents/multi-session-reflector/test_aggregate.py
"""

import sys
from pathlib import Path


def _outcome_label(summary):
    if summary.get("status") != "completed":
        return "TIMEOUT"
    verdict = summary.get("verdict")
    if verdict in ("APPROVE", "NEEDS_CHANGES", "BLOCK"):
        return verdict
    return "OTHER"


def _aggregate_summaries(summaries):
    outcome_buckets = {}
    finding_severity_counts = {}
    files_written_total = 0
    deno_check_passes = 0
    deno_lint_passes = 0
    deno_check_total = 0
    deno_lint_total = 0
    reviewer_summaries = []

    for s in summaries:
        label = _outcome_label(s)
        outcome_buckets[label] = outcome_buckets.get(label, 0) + 1

        for sev in s.get("finding_severities", []):
            if isinstance(sev, str):
                finding_severity_counts[sev] = finding_severity_counts.get(sev, 0) + 1

        files_written_total += s.get("files_written_count", 0) or 0

        if s.get("deno_check_passed") is not None:
            deno_check_total += 1
            if s["deno_check_passed"]:
                deno_check_passes += 1
        if s.get("deno_lint_passed") is not None:
            deno_lint_total += 1
            if s["deno_lint_passed"]:
                deno_lint_passes += 1

        rs = s.get("reviewer_summary")
        if isinstance(rs, str):
            reviewer_summaries.append(rs)

    return {
        "total_scanned": len(summaries),
        "outcome_buckets": outcome_buckets,
        "finding_severity_counts": finding_severity_counts,
        "files_written_total": files_written_total,
        "deno_check_pass_rate": deno_check_passes / deno_check_total if deno_check_total else 1.0,
        "deno_lint_pass_rate": deno_lint_passes / deno_lint_total if deno_lint_total else 1.0,
        "reviewer_summaries": reviewer_summaries,
    }


def assert_eq(label, actual, expected):
    if actual != expected:
        print(f"FAIL: {label}\n  expected: {expected}\n  got:      {actual}")
        sys.exit(1)
    print(f"PASS: {label}")


def assert_drift_check():
    src = (Path(__file__).parent / "agent.py").read_text()
    assert "def _outcome_label" in src
    assert "def _aggregate_summaries" in src
    assert "outcome_buckets" in src
    assert "deno_check_pass_rate" in src
    print("PASS: agent.py helpers present")


def main():
    assert_drift_check()

    # _outcome_label
    assert_eq("not completed → TIMEOUT", _outcome_label({"status": "active"}), "TIMEOUT")
    assert_eq("failed → TIMEOUT", _outcome_label({"status": "failed"}), "TIMEOUT")
    assert_eq("completed APPROVE", _outcome_label({"status": "completed", "verdict": "APPROVE"}), "APPROVE")
    assert_eq("completed NEEDS_CHANGES", _outcome_label({"status": "completed", "verdict": "NEEDS_CHANGES"}), "NEEDS_CHANGES")
    assert_eq("completed BLOCK", _outcome_label({"status": "completed", "verdict": "BLOCK"}), "BLOCK")
    assert_eq("completed unknown verdict → OTHER", _outcome_label({"status": "completed", "verdict": "WEIRD"}), "OTHER")
    assert_eq("completed no verdict → OTHER", _outcome_label({"status": "completed"}), "OTHER")

    # _aggregate_summaries
    r = _aggregate_summaries([])
    assert_eq("empty → 0 total", r["total_scanned"], 0)
    assert_eq("empty → 1.0 deno_check (no signal)", r["deno_check_pass_rate"], 1.0)
    assert_eq("empty → 1.0 deno_lint", r["deno_lint_pass_rate"], 1.0)

    r = _aggregate_summaries([
        {"status": "completed", "verdict": "APPROVE", "files_written_count": 3,
         "deno_check_passed": True, "deno_lint_passed": True},
        {"status": "completed", "verdict": "APPROVE", "files_written_count": 1,
         "deno_check_passed": True, "deno_lint_passed": True},
        {"status": "completed", "verdict": "BLOCK", "files_written_count": 0,
         "deno_check_passed": False, "deno_lint_passed": False,
         "finding_severities": ["CRITICAL", "WARNING"]},
    ])
    assert_eq("3 sessions total", r["total_scanned"], 3)
    assert_eq("2 APPROVE", r["outcome_buckets"]["APPROVE"], 2)
    assert_eq("1 BLOCK", r["outcome_buckets"]["BLOCK"], 1)
    assert_eq("4 files written total", r["files_written_total"], 4)
    assert_eq("deno_check 2/3 ≈ 0.666", round(r["deno_check_pass_rate"], 3), 0.667)
    assert_eq("CRITICAL count", r["finding_severity_counts"]["CRITICAL"], 1)
    assert_eq("WARNING count", r["finding_severity_counts"]["WARNING"], 1)

    # Mixed completed + failed
    r = _aggregate_summaries([
        {"status": "completed", "verdict": "APPROVE"},
        {"status": "failed"},
        {"status": "completed", "verdict": "APPROVE"},
    ])
    assert_eq("APPROVE bucket = 2", r["outcome_buckets"]["APPROVE"], 2)
    assert_eq("TIMEOUT bucket = 1", r["outcome_buckets"]["TIMEOUT"], 1)

    # Reviewer summaries collected
    r = _aggregate_summaries([
        {"status": "completed", "reviewer_summary": "first review"},
        {"status": "completed", "reviewer_summary": "second review"},
        {"status": "completed"},  # no reviewer_summary
    ])
    assert_eq("collected reviewer summaries", r["reviewer_summaries"], ["first review", "second review"])

    print("\n17/17 passed")


if __name__ == "__main__":
    main()
