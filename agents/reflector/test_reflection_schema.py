"""Unit tests for reflection_schema.py.

Run with: python3 agents/reflector/test_reflection_schema.py
"""

from __future__ import annotations

import sys
import uuid

from reflection_schema import (
    REFLECTIONS_NAMESPACE,
    ReflectionEntry,
    _deterministic_id,
)


def assert_eq(label: str, actual: object, expected: object) -> None:
    if actual != expected:
        print(f"FAIL: {label}\n  expected: {expected}\n  got:      {actual}")
        sys.exit(1)
    print(f"PASS: {label}")


def assert_raises(label: str, exc_type: type, fn: object, *args: object, **kwargs: object) -> None:
    try:
        fn(*args, **kwargs)  # type: ignore[operator]
        print(f"FAIL: {label} — no exception raised")
        sys.exit(1)
    except exc_type:
        print(f"PASS: {label}")
    except Exception as e:
        print(f"FAIL: {label} — wrong exception: {type(e).__name__}: {e}")
        sys.exit(1)


def test_valid_entry_serializes() -> None:
    entry = ReflectionEntry(
        text="Found skill gap in error handling",
        target_workspace_id="grilled_xylem",
        target_session_id="abc-123",
        finding_type="SKILL_GAP",
        severity="HIGH",
        proposed_action="Add error handling row to failure-mode table",
    )
    d = entry.to_narrative_entry()
    assert_eq("has id", isinstance(d["id"], str) and len(d["id"]) > 0, True)
    assert_eq("text matches", d["text"], "Found skill gap in error handling")
    assert_eq("author is reflector", d["author"], "reflector")
    assert_eq("has createdAt", "T" in d["createdAt"], True)
    assert_eq("metadata.finding_type", d["metadata"]["finding_type"], "SKILL_GAP")
    assert_eq("metadata.severity", d["metadata"]["severity"], "HIGH")
    assert_eq("metadata.target_workspace_id", d["metadata"]["target_workspace_id"], "grilled_xylem")
    assert_eq("metadata.target_session_id", d["metadata"]["target_session_id"], "abc-123")
    assert_eq("metadata.proposed_action", d["metadata"]["proposed_action"], "Add error handling row to failure-mode table")


def test_invalid_finding_type_raises() -> None:
    assert_raises(
        "invalid finding_type", ValueError,
        ReflectionEntry,
        text="test",
        target_workspace_id="ws",
        target_session_id="sid",
        finding_type="UNKNOWN_TYPE",
        severity="LOW",
        proposed_action="none",
    )


def test_invalid_severity_raises() -> None:
    assert_raises(
        "invalid severity", ValueError,
        ReflectionEntry,
        text="test",
        target_workspace_id="ws",
        target_session_id="sid",
        finding_type="INFO",
        severity="ULTRA",
        proposed_action="none",
    )


def test_empty_text_raises() -> None:
    assert_raises(
        "empty text", ValueError,
        ReflectionEntry,
        text="",
        target_workspace_id="ws",
        target_session_id="sid",
        finding_type="INFO",
        severity="LOW",
        proposed_action="none",
    )


def test_deterministic_id() -> None:
    id1 = _deterministic_id("session-1", "run-1", 0)
    id2 = _deterministic_id("session-1", "run-1", 0)
    id3 = _deterministic_id("session-1", "run-1", 1)
    assert_eq("same inputs → same id", id1, id2)
    assert_eq("different step → different id", id1 != id3, True)
    uuid.UUID(id1)
    print("PASS: deterministic id is valid UUID")


def test_idempotent_entry_ids() -> None:
    e1 = ReflectionEntry(
        text="reflection A",
        target_workspace_id="ws",
        target_session_id="sid",
        finding_type="INFO",
        severity="LOW",
        proposed_action="none",
        session_id="session-1",
        run_id="run-1",
        step_index=0,
    )
    e2 = ReflectionEntry(
        text="reflection B",
        target_workspace_id="ws",
        target_session_id="sid",
        finding_type="INFO",
        severity="LOW",
        proposed_action="none",
        session_id="session-1",
        run_id="run-1",
        step_index=0,
    )
    assert_eq("idempotent: same session/run/step → same id", e1.id, e2.id)


def test_random_id_without_session() -> None:
    e1 = ReflectionEntry(
        text="no session id",
        target_workspace_id="ws",
        target_session_id="sid",
        finding_type="INFO",
        severity="LOW",
        proposed_action="none",
    )
    e2 = ReflectionEntry(
        text="no session id",
        target_workspace_id="ws",
        target_session_id="sid",
        finding_type="INFO",
        severity="LOW",
        proposed_action="none",
    )
    assert_eq("no session → random ids differ", e1.id != e2.id, True)


def test_all_finding_types_valid() -> None:
    for ft in ("SKILL_GAP", "PROCESS_DRIFT", "ANOMALY", "INFO"):
        entry = ReflectionEntry(
            text=f"test {ft}",
            target_workspace_id="ws",
            target_session_id="sid",
            finding_type=ft,
            severity="LOW",
            proposed_action="none",
        )
        assert_eq(f"finding_type {ft} accepted", entry.to_narrative_entry()["metadata"]["finding_type"], ft)


def test_all_severities_valid() -> None:
    for sev in ("CRITICAL", "HIGH", "MEDIUM", "LOW"):
        entry = ReflectionEntry(
            text=f"test {sev}",
            target_workspace_id="ws",
            target_session_id="sid",
            finding_type="INFO",
            severity=sev,
            proposed_action="none",
        )
        assert_eq(f"severity {sev} accepted", entry.to_narrative_entry()["metadata"]["severity"], sev)


def main() -> None:
    test_valid_entry_serializes()
    test_invalid_finding_type_raises()
    test_invalid_severity_raises()
    test_empty_text_raises()
    test_deterministic_id()
    test_idempotent_entry_ids()
    test_random_id_without_session()
    test_all_finding_types_valid()
    test_all_severities_valid()
    print("\nAll tests passed")


if __name__ == "__main__":
    main()
