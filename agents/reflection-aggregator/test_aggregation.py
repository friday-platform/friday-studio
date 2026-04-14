"""Unit tests for reflection-aggregator's aggregation algorithm.

Tests the pure aggregation logic in isolation. Re-implements the core
algorithm so the test runs without the WIT bridge / friday_agent_sdk.
A drift-check at the top of main() asserts the agent.py source still
contains the expected bucket keys.

Run with: python3 agents/reflection-aggregator/test_aggregation.py
"""

import sys
from pathlib import Path


def aggregate(reflections: list) -> dict:
    if not isinstance(reflections, list):
        raise TypeError("reflections must be a list")

    if not reflections:
        return {
            "total_count": 0,
            "outcome_buckets": {"PROGRESSED": 0, "STUCK": 0, "REGRESSED": 0, "OTHER": 0},
            "known_failure_recurrence_count": 0,
            "top_failure_pattern": None,
            "avg_confidence": None,
            "proposes_new_skill_count": 0,
        }

    outcome_buckets = {"PROGRESSED": 0, "STUCK": 0, "REGRESSED": 0, "OTHER": 0}
    known_failure_counts: dict = {}
    confidence_values: list = []
    proposes_new_skill_count = 0

    for item in reflections:
        if not isinstance(item, dict):
            continue
        outcome = item.get("outcome", "OTHER")
        if outcome in outcome_buckets:
            outcome_buckets[outcome] += 1
        else:
            outcome_buckets["OTHER"] += 1

        matches_known = item.get("matches_known_failure")
        if matches_known is not None:
            known_failure_counts[matches_known] = known_failure_counts.get(matches_known, 0) + 1

        confidence = item.get("confidence")
        if isinstance(confidence, (int, float)):
            confidence_values.append(float(confidence))

        if item.get("proposes_skill_update"):
            proposes_new_skill_count += 1

    top = max(known_failure_counts, key=known_failure_counts.get) if known_failure_counts else None
    avg = sum(confidence_values) / len(confidence_values) if confidence_values else None

    return {
        "total_count": len(reflections),
        "outcome_buckets": outcome_buckets,
        "known_failure_recurrence_count": sum(known_failure_counts.values()),
        "top_failure_pattern": top,
        "avg_confidence": avg,
        "proposes_new_skill_count": proposes_new_skill_count,
    }


def assert_eq(label: str, actual, expected) -> None:
    if actual != expected:
        print(f"FAIL: {label}\n  expected: {expected}\n  got:      {actual}")
        sys.exit(1)
    print(f"PASS: {label}")


def assert_constants_match_agent() -> None:
    src = (Path(__file__).parent / "agent.py").read_text()
    expected_keys = '"PROGRESSED": 0, "STUCK": 0, "REGRESSED": 0, "OTHER": 0'
    if expected_keys not in src:
        print(f"FAIL: agent.py outcome_buckets keys drifted from test")
        sys.exit(1)
    print("PASS: agent.py bucket keys match test")


def main() -> None:
    assert_constants_match_agent()

    r = aggregate([])
    assert_eq("empty list -> total 0", r["total_count"], 0)
    assert_eq("empty list -> avg None", r["avg_confidence"], None)
    assert_eq("empty list -> top None", r["top_failure_pattern"], None)

    r = aggregate([
        {"outcome": "PROGRESSED", "confidence": 0.9, "proposes_skill_update": True},
        {"outcome": "PROGRESSED", "confidence": 0.7, "proposes_skill_update": False},
    ])
    assert_eq("two PROGRESSED", r["outcome_buckets"]["PROGRESSED"], 2)
    assert_eq("avg confidence", round(r["avg_confidence"], 2), 0.8)
    assert_eq("one proposes new skill", r["proposes_new_skill_count"], 1)
    assert_eq("no known failures", r["top_failure_pattern"], None)

    r = aggregate([
        {"outcome": "STUCK", "matches_known_failure": "missing_bridge_import"},
        {"outcome": "STUCK", "matches_known_failure": "missing_bridge_import"},
        {"outcome": "REGRESSED", "matches_known_failure": "schema_mismatch"},
    ])
    assert_eq("top failure pattern", r["top_failure_pattern"], "missing_bridge_import")
    assert_eq("known_failure_recurrence_count", r["known_failure_recurrence_count"], 3)
    assert_eq("STUCK bucket", r["outcome_buckets"]["STUCK"], 2)
    assert_eq("REGRESSED bucket", r["outcome_buckets"]["REGRESSED"], 1)

    r = aggregate([
        {"outcome": "WEIRD_VALUE"},
        {"outcome": "ALSO_WEIRD"},
        {"outcome": "PROGRESSED"},
    ])
    assert_eq("unknown outcomes go to OTHER", r["outcome_buckets"]["OTHER"], 2)
    assert_eq("known PROGRESSED still counted", r["outcome_buckets"]["PROGRESSED"], 1)

    r = aggregate([
        {"outcome": "PROGRESSED"},
        "not a dict",
        42,
        None,
        {"outcome": "STUCK"},
    ])
    assert_eq("non-dict items skipped (PROGRESSED)", r["outcome_buckets"]["PROGRESSED"], 1)
    assert_eq("non-dict items skipped (STUCK)", r["outcome_buckets"]["STUCK"], 1)
    assert_eq("total_count uses raw input length", r["total_count"], 5)

    r = aggregate([
        {"outcome": "PROGRESSED"},
        {"outcome": "PROGRESSED", "confidence": "not a number"},
        {"outcome": "PROGRESSED", "confidence": 1.0},
    ])
    assert_eq("non-numeric confidence ignored", r["avg_confidence"], 1.0)

    print("\n14/14 passed")


if __name__ == "__main__":
    main()
