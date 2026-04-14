"""Unit tests for status_update helper.

Tests the pure logic of post_in_progress — idempotency, NarrativeEntry shape,
correct metadata. Uses mock ctx objects instead of the real SDK.

Run with: python3 agents/autopilot-planner/test_status_update.py
"""

import json
import sys
from pathlib import Path


class MockHttpResponse:
    def __init__(self, status, body=""):
        self.status = status
        self.body = body


class MockHttp:
    def __init__(self):
        self.calls = []
        self._responses = []

    def add_response(self, resp):
        self._responses.append(resp)

    def fetch(self, url, method="GET", headers=None, body=None, timeout_ms=5000):
        self.calls.append({"url": url, "method": method, "headers": headers, "body": body})
        if self._responses:
            return self._responses.pop(0)
        return MockHttpResponse(200, "[]")


class MockCtx:
    def __init__(self):
        self.http = MockHttp()


def post_in_progress(ctx, corpus_url, task_id, dispatched_session_id, now_iso=None):
    """Mirror of status_update.post_in_progress for testing without WASM imports."""
    try:
        resp = ctx.http.fetch(corpus_url, method="GET", timeout_ms=5000)
        if resp.status == 200:
            entries = json.loads(resp.body or "[]")
            if isinstance(entries, list):
                for entry in entries:
                    if not isinstance(entry, dict):
                        continue
                    meta = entry.get("metadata") or {}
                    if (
                        entry.get("id") == task_id
                        and meta.get("status") == "in_progress"
                    ):
                        return False
    except Exception:
        pass

    body = json.dumps({
        "id": task_id,
        "text": f"Task {task_id} dispatched to session {dispatched_session_id}",
        "createdAt": now_iso or "",
        "metadata": {
            "status": "in_progress",
            "task_id": task_id,
            "dispatched_session_id": dispatched_session_id,
        },
    })
    try:
        resp = ctx.http.fetch(
            corpus_url,
            method="POST",
            headers={"Content-Type": "application/json"},
            body=body,
            timeout_ms=5000,
        )
        return resp.status == 200 or resp.status == 201
    except Exception:
        return False


def assert_eq(label, actual, expected):
    if actual != expected:
        print(f"FAIL: {label}\n  expected: {expected}\n  got:      {actual}")
        sys.exit(1)
    print(f"PASS: {label}")


def test_drift_check():
    """Verify status_update.py source matches the test's logic."""
    src = (Path(__file__).parent / "status_update.py").read_text()
    assert 'meta.get("status") == "in_progress"' in src, "idempotency check missing"
    assert 'entry.get("id") == task_id' in src, "task_id check missing"
    assert '"status": "in_progress"' in src, "status field missing"
    assert '"dispatched_session_id"' in src, "session_id field missing"
    print("PASS: status_update.py source matches test expectations")


def test_appends_entry_when_none_exists():
    ctx = MockCtx()
    ctx.http.add_response(MockHttpResponse(200, "[]"))
    ctx.http.add_response(MockHttpResponse(200, ""))

    result = post_in_progress(ctx, "http://test/corpus", "task-1", "sess-abc", "2026-04-14T12:00:00Z")
    assert_eq("appends when empty", result, True)

    assert_eq("makes 2 HTTP calls", len(ctx.http.calls), 2)
    assert_eq("first call is GET", ctx.http.calls[0]["method"], "GET")
    assert_eq("second call is POST", ctx.http.calls[1]["method"], "POST")

    posted = json.loads(ctx.http.calls[1]["body"])
    assert_eq("id == task_id", posted["id"], "task-1")
    assert_eq("has text", isinstance(posted["text"], str), True)
    assert_eq("has createdAt", posted["createdAt"], "2026-04-14T12:00:00Z")
    assert_eq("metadata.status", posted["metadata"]["status"], "in_progress")
    assert_eq("metadata.task_id", posted["metadata"]["task_id"], "task-1")
    assert_eq("metadata.dispatched_session_id", posted["metadata"]["dispatched_session_id"], "sess-abc")


def test_idempotent_skips_duplicate():
    ctx = MockCtx()
    existing = json.dumps([{
        "id": "task-1",
        "text": "Task task-1 dispatched to session old-sess",
        "createdAt": "2026-04-14T10:00:00Z",
        "metadata": {"status": "in_progress", "task_id": "task-1", "dispatched_session_id": "old-sess"},
    }])
    ctx.http.add_response(MockHttpResponse(200, existing))

    result = post_in_progress(ctx, "http://test/corpus", "task-1", "sess-new")
    assert_eq("skips duplicate", result, False)
    assert_eq("only 1 HTTP call (GET, no POST)", len(ctx.http.calls), 1)


def test_different_task_id_still_appends():
    ctx = MockCtx()
    existing = json.dumps([{
        "id": "task-1",
        "text": "...",
        "createdAt": "...",
        "metadata": {"status": "in_progress", "task_id": "task-1", "dispatched_session_id": "s1"},
    }])
    ctx.http.add_response(MockHttpResponse(200, existing))
    ctx.http.add_response(MockHttpResponse(201, ""))

    result = post_in_progress(ctx, "http://test/corpus", "task-2", "sess-xyz")
    assert_eq("different task_id appends", result, True)
    assert_eq("2 HTTP calls", len(ctx.http.calls), 2)


def test_narrative_entry_shape_contract():
    """Verify the emitted NarrativeEntry matches the TypeScript interface shape."""
    ctx = MockCtx()
    ctx.http.add_response(MockHttpResponse(200, "[]"))
    ctx.http.add_response(MockHttpResponse(200, ""))

    post_in_progress(ctx, "http://test/corpus", "t1", "s1", "2026-04-14T00:00:00Z")
    posted = json.loads(ctx.http.calls[1]["body"])

    assert_eq("shape has id (string)", isinstance(posted.get("id"), str), True)
    assert_eq("shape has text (string)", isinstance(posted.get("text"), str), True)
    assert_eq("shape has createdAt (string)", isinstance(posted.get("createdAt"), str), True)
    assert_eq("shape has metadata (dict)", isinstance(posted.get("metadata"), dict), True)
    author = posted.get("author")
    assert_eq("shape author is None or str", author is None or isinstance(author, str), True)


def main():
    test_drift_check()
    test_appends_entry_when_none_exists()
    test_idempotent_skips_duplicate()
    test_different_task_id_still_appends()
    test_narrative_entry_shape_contract()

    print("\n5/5 passed")


if __name__ == "__main__":
    main()
