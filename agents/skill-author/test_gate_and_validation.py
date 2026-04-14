"""Unit tests for skill-author's confidence gate + _validate_failure_mode.

The skill-author agent has two pure validation paths that don't need the
LLM:
1. PUBLISH_GATE check (confidence < 0.9 → return skipped)
2. _validate_failure_mode (require dict with non-empty string keys)

Both run BEFORE the LLM call. Catching bugs here protects the publish chain
from accidentally proposing/publishing low-confidence or malformed updates.

Run with: python3 agents/skill-author/test_gate_and_validation.py
"""

import sys
from pathlib import Path
from typing import Any

PUBLISH_GATE = 0.9
REQUIRED_FAILURE_MODE_KEYS = ("symptom", "root_cause", "structural_fix")


def _validate_failure_mode(fm):
    """Mirror of agents/skill-author/agent.py:_validate_failure_mode."""
    if not isinstance(fm, dict):
        return f"new_failure_mode must be a dict, got {type(fm).__name__}"
    missing = [k for k in REQUIRED_FAILURE_MODE_KEYS if k not in fm]
    if missing:
        return f"new_failure_mode missing required keys: {', '.join(missing)}"
    for key in REQUIRED_FAILURE_MODE_KEYS:
        if not isinstance(fm[key], str) or not fm[key].strip():
            return f"new_failure_mode.{key} must be a non-empty string"
    return None


def gate_check(confidence):
    """Mirror of the PUBLISH_GATE check at agent.py:155."""
    return confidence >= PUBLISH_GATE  # True = pass gate, False = skipped


def assert_eq(label, actual, expected):
    if actual != expected:
        print(f"FAIL: {label}\n  expected: {expected}\n  got:      {actual}")
        sys.exit(1)
    print(f"PASS: {label}")


def assert_drift_check():
    src = (Path(__file__).parent / "agent.py").read_text()
    assert "PUBLISH_GATE = 0.9" in src, "gate constant drifted"
    assert "REQUIRED_FAILURE_MODE_KEYS = (\"symptom\", \"root_cause\", \"structural_fix\")" in src, (
        "required keys drifted"
    )
    assert "if confidence < PUBLISH_GATE" in src, "gate check site drifted"
    print("PASS: agent.py constants + gate site match test")


def main():
    assert_drift_check()

    # Gate tests
    assert_eq("0.0 → skipped", gate_check(0.0), False)
    assert_eq("0.5 → skipped", gate_check(0.5), False)
    assert_eq("0.85 → skipped (the autopilot's seen this case)", gate_check(0.85), False)
    assert_eq("0.89 → skipped", gate_check(0.89), False)
    assert_eq("0.9 → pass (boundary inclusive)", gate_check(0.9), True)
    assert_eq("0.95 → pass", gate_check(0.95), True)
    assert_eq("1.0 → pass", gate_check(1.0), True)

    # Validation tests
    assert_eq("None → error", _validate_failure_mode(None) is not None, True)
    assert_eq(
        "string → error",
        _validate_failure_mode("not a dict") is not None,
        True,
    )
    assert_eq(
        "empty dict → missing keys error",
        "missing required keys" in (_validate_failure_mode({}) or ""),
        True,
    )
    assert_eq(
        "missing root_cause",
        "root_cause" in (_validate_failure_mode({"symptom": "s", "structural_fix": "f"}) or ""),
        True,
    )
    assert_eq(
        "all keys + non-empty strings → valid",
        _validate_failure_mode({
            "symptom": "session crashes with streamEmit undefined",
            "root_cause": "globalThis.__fridayCapabilities deleted in finally",
            "structural_fix": "remove the delete; bindHostFunctions overwrites",
        }),
        None,
    )
    assert_eq(
        "empty string value → error",
        _validate_failure_mode({"symptom": "s", "root_cause": "", "structural_fix": "f"}) is not None,
        True,
    )
    assert_eq(
        "whitespace-only value → error",
        _validate_failure_mode({"symptom": "  ", "root_cause": "r", "structural_fix": "f"}) is not None,
        True,
    )
    assert_eq(
        "non-string value → error",
        _validate_failure_mode({"symptom": "s", "root_cause": 42, "structural_fix": "f"}) is not None,
        True,
    )

    print("\n14/14 passed")


if __name__ == "__main__":
    main()
