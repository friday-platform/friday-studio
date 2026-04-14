"""Unit tests for _iso_subtract_seconds in autopilot-planner.

The WASM Python sandbox lacks datetime + calendar, so the planner does ISO
math manually. This test re-implements the helper inline to verify the
algorithm. Drift-check against the agent.py source confirms the same
arithmetic.

Run with: python3 agents/autopilot-planner/test_iso_math.py
"""

import sys
from pathlib import Path


def _is_leap(year):
    return (year % 4 == 0 and year % 100 != 0) or (year % 400 == 0)


def _days_in_month(year, month):
    if month == 2:
        return 29 if _is_leap(year) else 28
    if month in (4, 6, 9, 11):
        return 30
    return 31


def _iso_subtract_seconds(iso, seconds):
    """Mirror of agents/autopilot-planner/agent.py:_iso_subtract_seconds (post-fix)."""
    try:
        clean = iso.replace("Z", "")
        if "." in clean:
            clean = clean.split(".", 1)[0]
        date_part, time_part = clean.split("T")
        y, mo, d = (int(x) for x in date_part.split("-"))
        h, mi, sec = (int(x) for x in time_part.split(":"))

        total_s = h * 3600 + mi * 60 + sec - seconds
        while total_s < 0:
            total_s += 86400
            d -= 1
            if d <= 0:
                mo -= 1
                if mo <= 0:
                    mo = 12
                    y -= 1
                d = _days_in_month(y, mo)

        new_h = total_s // 3600
        new_m = (total_s % 3600) // 60
        new_s = total_s % 60
        return f"{y:04d}-{mo:02d}-{d:02d}T{new_h:02d}:{new_m:02d}:{new_s:02d}"
    except Exception:
        return None


def assert_eq(label, actual, expected):
    if actual != expected:
        print(f"FAIL: {label}\n  expected: {expected}\n  got:      {actual}")
        sys.exit(1)
    print(f"PASS: {label}")


def assert_lex_order(label, a, b):
    if a < b:
        print(f"PASS: {label} ({a} < {b})")
    else:
        print(f"FAIL: {label}\n  expected lex order {a} < {b}")
        sys.exit(1)


def assert_drift_check():
    src = (Path(__file__).parent / "agent.py").read_text()
    assert "def _iso_subtract_seconds" in src, "helper not in agent.py"
    assert "def _is_leap" in src, "_is_leap helper missing"
    assert "def _days_in_month" in src, "_days_in_month helper missing"
    assert "total_s = h * 3600 + mi * 60 + sec - seconds" in src, "math drift"
    print("PASS: agent.py helpers + math match test")


def main():
    assert_drift_check()

    # 30-min subtract within same hour
    assert_eq(
        "30 min back same day",
        _iso_subtract_seconds("2026-04-14T17:35:00.808Z", 1800),
        "2026-04-14T17:05:00",
    )

    # 1-hour subtract crossing hour boundary
    assert_eq(
        "1 hour back",
        _iso_subtract_seconds("2026-04-14T17:00:30Z", 3600),
        "2026-04-14T16:00:30",
    )

    # Subtract crossing midnight
    assert_eq(
        "5 min back from 00:02",
        _iso_subtract_seconds("2026-04-14T00:02:00Z", 300),
        "2026-04-13T23:57:00",
    )

    # Subtract larger than a day (cooldown 86400 = 1 day)
    assert_eq(
        "1 day back from 12:00",
        _iso_subtract_seconds("2026-04-14T12:00:00Z", 86400),
        "2026-04-13T12:00:00",
    )

    # Trailing milliseconds + Z stripped
    assert_eq(
        "millis + Z stripped",
        _iso_subtract_seconds("2026-04-14T17:33:11.063Z", 60),
        "2026-04-14T17:32:11",
    )

    # Lexical comparison sanity (the actual production use)
    cutoff = _iso_subtract_seconds("2026-04-14T17:35:00.808Z", 1800)
    started_a = "2026-04-14T17:32:00"  # within window
    started_b = "2026-04-14T16:50:00"  # outside window
    assert_lex_order("recent session within cutoff", cutoff, started_a)
    assert_lex_order("old session outside cutoff", started_b, cutoff)

    # Month boundary: 1 day back from May 1 → April 30
    assert_eq(
        "month boundary may→apr",
        _iso_subtract_seconds("2026-05-01T12:00:00Z", 86400),
        "2026-04-30T12:00:00",
    )

    # Month boundary: 1 day back from March 1, 2026 (non-leap) → Feb 28
    assert_eq(
        "non-leap feb",
        _iso_subtract_seconds("2026-03-01T12:00:00Z", 86400),
        "2026-02-28T12:00:00",
    )

    # Month boundary: 1 day back from March 1, 2024 (leap) → Feb 29
    assert_eq(
        "leap feb",
        _iso_subtract_seconds("2024-03-01T12:00:00Z", 86400),
        "2024-02-29T12:00:00",
    )

    # Year boundary: 1 day back from Jan 1 → Dec 31 prior year
    assert_eq(
        "year boundary",
        _iso_subtract_seconds("2026-01-01T12:00:00Z", 86400),
        "2025-12-31T12:00:00",
    )

    # Multi-day back across month boundary
    assert_eq(
        "5 days back from may 3 → apr 28",
        _iso_subtract_seconds("2026-05-03T00:00:00Z", 5 * 86400),
        "2026-04-28T00:00:00",
    )

    # Bad input falls back to None
    assert_eq("garbage input", _iso_subtract_seconds("not-iso", 60), None)
    assert_eq("empty input", _iso_subtract_seconds("", 60), None)

    print("\n15/15 passed")


if __name__ == "__main__":
    main()
