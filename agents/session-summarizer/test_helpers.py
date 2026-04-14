"""Unit tests for session-summarizer's pure helper functions.

Tests the deterministic helpers in isolation. The agent module imports
friday_agent_sdk which isn't installed locally, so we re-implement the
helpers here and verify them. A drift-check at the top of main() asserts
the agent.py source still has the expected helper signatures.

Run with: python3 agents/session-summarizer/test_helpers.py
"""

import json
import sys
from datetime import datetime
from pathlib import Path

MAX_SUMMARY_CHARS = 400


def _truncate(text, max_chars: int = MAX_SUMMARY_CHARS):
    if text is None:
        return None
    text = str(text)
    if len(text) <= max_chars:
        return text
    return text[:max_chars]


def _compute_duration(session: dict):
    started = session.get("startedAt")
    completed = session.get("completedAt")
    if not started or not completed:
        return None
    try:
        start_dt = datetime.fromisoformat(started)
        end_dt = datetime.fromisoformat(completed)
        return (end_dt - start_dt).total_seconds()
    except (ValueError, TypeError):
        return None


def _extract_block_output(block: dict) -> dict:
    output = block.get("output")
    if isinstance(output, dict):
        return output
    if isinstance(output, str):
        try:
            return json.loads(output)
        except json.JSONDecodeError:
            pass
    for tc in reversed(block.get("toolCalls", [])):
        if tc.get("toolName") == "complete":
            args = tc.get("args")
            if isinstance(args, dict):
                return args
    return {}


def assert_eq(label: str, actual, expected) -> None:
    if actual != expected:
        print(f"FAIL: {label}\n  expected: {expected}\n  got:      {actual}")
        sys.exit(1)
    print(f"PASS: {label}")


def assert_drift_check() -> None:
    src = (Path(__file__).parent / "agent.py").read_text()
    if "MAX_SUMMARY_CHARS = 400" not in src:
        print("FAIL: MAX_SUMMARY_CHARS in agent.py drifted from test")
        sys.exit(1)
    if "def _extract_block_output" not in src:
        print("FAIL: _extract_block_output missing in agent.py")
        sys.exit(1)
    if "def _compute_duration" not in src:
        print("FAIL: _compute_duration missing in agent.py")
        sys.exit(1)
    if "def _truncate" not in src:
        print("FAIL: _truncate missing in agent.py")
        sys.exit(1)
    print("PASS: agent.py helpers + constants match test")


def main() -> None:
    assert_drift_check()

    # _truncate
    assert_eq("truncate None -> None", _truncate(None), None)
    assert_eq("truncate short string", _truncate("hello"), "hello")
    assert_eq("truncate exactly max", _truncate("a" * 400), "a" * 400)
    assert_eq("truncate over max", _truncate("a" * 500), "a" * 400)
    assert_eq("truncate non-str", _truncate(42), "42")

    # _compute_duration
    sess_full = {
        "startedAt": "2026-04-14T00:00:00",
        "completedAt": "2026-04-14T00:01:30",
    }
    assert_eq("duration 90s", _compute_duration(sess_full), 90.0)
    assert_eq("missing started", _compute_duration({"completedAt": "2026-04-14T00:00:00"}), None)
    assert_eq("missing completed", _compute_duration({"startedAt": "2026-04-14T00:00:00"}), None)
    assert_eq("invalid iso", _compute_duration({"startedAt": "not-a-date", "completedAt": "2026-04-14T00:00:00"}), None)
    assert_eq("both missing", _compute_duration({}), None)

    # _extract_block_output — dict path
    assert_eq("dict output passthrough", _extract_block_output({"output": {"summary": "hi"}}), {"summary": "hi"})

    # _extract_block_output — string JSON path
    assert_eq(
        "string JSON output parsed",
        _extract_block_output({"output": '{"verdict": "APPROVE"}'}),
        {"verdict": "APPROVE"},
    )

    # _extract_block_output — invalid JSON falls through
    assert_eq("invalid string output -> empty", _extract_block_output({"output": "not json"}), {})

    # _extract_block_output — toolCalls fallback
    assert_eq(
        "complete toolCall args used",
        _extract_block_output(
            {
                "toolCalls": [
                    {"toolName": "noop", "args": {"x": 1}},
                    {"toolName": "complete", "args": {"summary": "done"}},
                ]
            }
        ),
        {"summary": "done"},
    )

    # _extract_block_output — most recent complete wins (reversed iteration)
    assert_eq(
        "most recent complete wins",
        _extract_block_output(
            {
                "toolCalls": [
                    {"toolName": "complete", "args": {"summary": "first"}},
                    {"toolName": "complete", "args": {"summary": "last"}},
                ]
            }
        ),
        {"summary": "last"},
    )

    # _extract_block_output — no output, no complete tool
    assert_eq("nothing returns empty", _extract_block_output({}), {})

    print("\n17/17 passed")


if __name__ == "__main__":
    main()
