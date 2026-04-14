"""Unit tests for corpus_appender.py.

Run with: python3 agents/reflector/test_corpus_appender.py
"""

from __future__ import annotations

import json
import sys
from typing import Any

from corpus_appender import CORPUS_NAME, CorpusAppender
from reflection_schema import ReflectionEntry


class MockResponse:
    def __init__(self, status: int, body: dict[str, Any] | None = None) -> None:
        self.status = status
        self._body = body or {}

    def json(self) -> dict[str, Any]:
        return self._body


class MockHttp:
    def __init__(self, response: MockResponse | None = None, raise_exc: Exception | None = None) -> None:
        self.calls: list[dict[str, Any]] = []
        self._response = response or MockResponse(200, {"id": "test"})
        self._raise_exc = raise_exc

    def fetch(self, url: str, *, method: str, body: str | None = None,
              headers: dict[str, str] | None = None, timeout_ms: int = 10000) -> MockResponse:
        self.calls.append({
            "url": url,
            "method": method,
            "body": body,
            "headers": headers,
        })
        if self._raise_exc:
            raise self._raise_exc
        return self._response


def assert_eq(label: str, actual: object, expected: object) -> None:
    if actual != expected:
        print(f"FAIL: {label}\n  expected: {expected}\n  got:      {actual}")
        sys.exit(1)
    print(f"PASS: {label}")


def _make_entry(**overrides: Any) -> ReflectionEntry:
    defaults = {
        "text": "Test reflection summary",
        "target_workspace_id": "grilled_xylem",
        "target_session_id": "session-abc",
        "finding_type": "INFO",
        "severity": "LOW",
        "proposed_action": "none",
    }
    defaults.update(overrides)
    return ReflectionEntry(**defaults)


def test_calls_correct_url() -> None:
    http = MockHttp()
    appender = CorpusAppender(platform_url="http://localhost:8080", http=http)
    entry = _make_entry()
    result = appender.append_reflection(workspace_id="thick_endive", entry=entry)

    assert_eq("returns True on success", result, True)
    assert_eq("one HTTP call", len(http.calls), 1)
    call = http.calls[0]
    assert_eq(
        "correct URL",
        call["url"],
        f"http://localhost:8080/api/memory/thick_endive/narrative/{CORPUS_NAME}",
    )
    assert_eq("method is POST", call["method"], "POST")
    assert_eq("content-type header", call["headers"], {"Content-Type": "application/json"})


def test_sends_narrative_entry_payload() -> None:
    http = MockHttp()
    appender = CorpusAppender(platform_url="http://localhost:8080", http=http)
    entry = _make_entry(text="Found skill gap")
    appender.append_reflection(workspace_id="thick_endive", entry=entry)

    body = json.loads(http.calls[0]["body"])
    assert_eq("body.text", body["text"], "Found skill gap")
    assert_eq("body.author", body["author"], "reflector")
    assert_eq("body has id", "id" in body, True)
    assert_eq("body has createdAt", "createdAt" in body, True)
    assert_eq("metadata.finding_type", body["metadata"]["finding_type"], "INFO")
    assert_eq("metadata.severity", body["metadata"]["severity"], "LOW")
    assert_eq("metadata.target_workspace_id", body["metadata"]["target_workspace_id"], "grilled_xylem")
    assert_eq("metadata.target_session_id", body["metadata"]["target_session_id"], "session-abc")


def test_returns_false_on_http_error() -> None:
    http = MockHttp(response=MockResponse(500, {"error": "internal"}))
    appender = CorpusAppender(platform_url="http://localhost:8080", http=http)
    entry = _make_entry()
    result = appender.append_reflection(workspace_id="thick_endive", entry=entry)
    assert_eq("returns False on 500", result, False)


def test_returns_false_on_network_exception() -> None:
    http = MockHttp(raise_exc=ConnectionError("timeout"))
    appender = CorpusAppender(platform_url="http://localhost:8080", http=http)
    entry = _make_entry()
    result = appender.append_reflection(workspace_id="thick_endive", entry=entry)
    assert_eq("returns False on exception", result, False)


def test_strips_trailing_slash_from_url() -> None:
    http = MockHttp()
    appender = CorpusAppender(platform_url="http://localhost:8080/", http=http)
    entry = _make_entry()
    appender.append_reflection(workspace_id="thick_endive", entry=entry)
    assert_eq(
        "no double slash",
        "//api" not in http.calls[0]["url"],
        True,
    )


def test_idempotent_entries_same_id() -> None:
    http = MockHttp()
    appender = CorpusAppender(platform_url="http://localhost:8080", http=http)
    e1 = _make_entry(session_id="s1", run_id="r1", step_index=0)
    e2 = _make_entry(session_id="s1", run_id="r1", step_index=0)
    appender.append_reflection(workspace_id="thick_endive", entry=e1)
    appender.append_reflection(workspace_id="thick_endive", entry=e2)

    body1 = json.loads(http.calls[0]["body"])
    body2 = json.loads(http.calls[1]["body"])
    assert_eq("idempotent: same id on replay", body1["id"], body2["id"])


def main() -> None:
    test_calls_correct_url()
    test_sends_narrative_entry_payload()
    test_returns_false_on_http_error()
    test_returns_false_on_network_exception()
    test_strips_trailing_slash_from_url()
    test_idempotent_entries_same_id()
    print("\nAll tests passed")


if __name__ == "__main__":
    main()
