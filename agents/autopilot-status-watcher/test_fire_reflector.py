"""Unit tests for reflector firing logic in autopilot-status-watcher."""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import MagicMock

import pytest

from agent import (
    DURATION_THRESHOLD_MS,
    REFLECTOR_SIGNAL,
    REFLECTOR_TARGET_WS,
    _fire_reflector,
    _should_fire_reflector,
    execute,
)


def _make_ctx(
    http_responses: dict[str, tuple[int, Any]] | None = None,
) -> MagicMock:
    """Build a mock ctx with configurable HTTP responses keyed by URL substring."""
    ctx = MagicMock()
    ctx.config = {
        "platformUrl": "http://test:8080",
        "kernel_workspace_id": "kernel_ws",
        "dispatch_log_memory": "dispatch-log",
        "backlog_memory": "autopilot-backlog",
    }
    responses = http_responses or {}

    def fake_fetch(url: str, **kwargs: Any) -> MagicMock:
        for pattern, (status, body) in responses.items():
            if pattern in url:
                resp = MagicMock()
                resp.status = status
                resp.body = json.dumps(body) if body is not None else ""
                return resp
        resp = MagicMock()
        resp.status = 404
        resp.body = "null"
        return resp

    ctx.http.fetch = fake_fetch
    return ctx


def _dispatch_entry(
    task_id: str,
    session_id: str = "sess-1",
    target_ws: str = "target_ws",
    priority: int = 50,
    task_brief: str = "test brief",
) -> dict[str, Any]:
    return {
        "id": task_id,
        "text": f"dispatch:{task_id}",
        "createdAt": "2026-04-14T10:00:00Z",
        "metadata": {
            "session_id": session_id,
            "target_workspace_id": target_ws,
            "dispatched_at": "2026-04-14T10:00:00Z",
            "priority": priority,
            "payload": {"task_brief": task_brief},
        },
    }


def _session_data(
    status: str = "completed",
    job_name: str = "run-task",
    started_at: str = "2026-04-14T10:00:00Z",
    completed_at: str = "2026-04-14T10:01:00Z",
    duration_ms: int | None = None,
    tool_calls: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    blocks: list[dict[str, Any]] = []
    if tool_calls:
        blocks.append({"toolCalls": tool_calls})
    data: dict[str, Any] = {
        "status": status,
        "sessionId": "sess-1",
        "jobName": job_name,
        "startedAt": started_at,
        "completedAt": completed_at,
        "agentBlocks": blocks,
    }
    if duration_ms is not None:
        data["durationMs"] = duration_ms
    return data


class TestShouldFireReflector:
    def test_skips_reflect_on_last_run_job(self) -> None:
        session = _session_data(status="failed", job_name="reflect-on-last-run")
        assert _should_fire_reflector(session, {}) is False

    def test_skips_other_meta_jobs(self) -> None:
        for job in ("apply-reflection", "audit-orphans", "cross-session-reflect", "autopilot-tick"):
            session = _session_data(status="failed", job_name=job)
            assert _should_fire_reflector(session, {}) is False, f"should skip {job}"

    def test_fires_on_failed_session(self) -> None:
        session = _session_data(status="failed", job_name="run-task")
        assert _should_fire_reflector(session, {}) is True

    def test_fires_on_long_running_session(self) -> None:
        session = _session_data(
            status="completed",
            job_name="run-task",
            duration_ms=DURATION_THRESHOLD_MS + 1000,
        )
        assert _should_fire_reflector(session, {}) is True

    def test_fires_on_long_running_via_timestamps(self) -> None:
        session = _session_data(
            status="completed",
            job_name="run-task",
            started_at="2026-04-14T10:00:00Z",
            completed_at="2026-04-14T10:10:00Z",
        )
        assert _should_fire_reflector(session, {}) is True

    def test_skips_fast_successful_session(self) -> None:
        session = _session_data(
            status="completed",
            job_name="run-task",
            duration_ms=60000,
        )
        assert _should_fire_reflector(session, {}) is False

    def test_falls_back_to_entry_metadata_job_name(self) -> None:
        session: dict[str, Any] = {
            "status": "failed",
            "sessionId": "sess-1",
            "startedAt": "2026-04-14T10:00:00Z",
            "completedAt": "2026-04-14T10:01:00Z",
            "agentBlocks": [],
        }
        meta: dict[str, Any] = {"jobName": "reflect-on-last-run"}
        assert _should_fire_reflector(session, meta) is False


class TestFireReflector:
    def test_posts_correct_url_and_payload(self) -> None:
        posted: list[tuple[str, dict[str, Any]]] = []
        ctx = MagicMock()

        def capture_fetch(url: str, **kwargs: Any) -> MagicMock:
            posted.append((url, kwargs))
            resp = MagicMock()
            resp.status = 200
            return resp

        ctx.http.fetch = capture_fetch
        result = _fire_reflector(ctx, "http://test:8080", "sess-abc")
        assert result == 200
        assert len(posted) == 1
        url, kwargs = posted[0]
        assert f"/api/workspaces/{REFLECTOR_TARGET_WS}/signals/{REFLECTOR_SIGNAL}" in url
        body = json.loads(kwargs["body"])
        assert body == {"payload": {"session_id": "sess-abc"}}
        assert kwargs.get("timeout_ms") == 1500

    def test_returns_status_on_success(self) -> None:
        ctx = MagicMock()
        resp = MagicMock()
        resp.status = 200
        ctx.http.fetch.return_value = resp
        assert _fire_reflector(ctx, "http://test:8080", "sess-1") == 200

    def test_returns_error_string_on_exception(self) -> None:
        ctx = MagicMock()
        ctx.http.fetch.side_effect = Exception("connection timeout")
        result = _fire_reflector(ctx, "http://test:8080", "sess-1")
        assert isinstance(result, str)
        assert result.startswith("err: ")


class TestExecuteReflectorIntegration:
    def test_fires_reflector_on_failed_session(self) -> None:
        session = _session_data(status="failed", job_name="run-task")
        posted_urls: list[str] = []
        base_ctx = _make_ctx({
            "narrative/dispatch-log": (200, [_dispatch_entry("task-1")]),
            "narrative/autopilot-backlog": (200, []),
            "sessions/sess-1": (200, session),
        })
        original_fetch = base_ctx.http.fetch

        def tracking_fetch(url: str, **kwargs: Any) -> Any:
            if kwargs.get("method") == "POST" and "signals/reflect-on-last-run" in url:
                posted_urls.append(url)
            return original_fetch(url, **kwargs)

        base_ctx.http.fetch = tracking_fetch
        result = execute("observe", base_ctx)
        data = result.data
        assert len(posted_urls) == 1
        assert REFLECTOR_TARGET_WS in posted_urls[0]
        assert "reflector_fired" in data
        assert len(data["reflector_fired"]) == 1

    def test_does_not_fire_reflector_on_fast_success(self) -> None:
        session = _session_data(
            status="completed",
            job_name="run-task",
            duration_ms=60000,
        )
        posted_urls: list[str] = []
        base_ctx = _make_ctx({
            "narrative/dispatch-log": (200, [_dispatch_entry("task-1")]),
            "narrative/autopilot-backlog": (200, []),
            "sessions/sess-1": (200, session),
        })
        original_fetch = base_ctx.http.fetch

        def tracking_fetch(url: str, **kwargs: Any) -> Any:
            if kwargs.get("method") == "POST" and "signals/reflect-on-last-run" in url:
                posted_urls.append(url)
            return original_fetch(url, **kwargs)

        base_ctx.http.fetch = tracking_fetch
        result = execute("observe", base_ctx)
        data = result.data
        assert len(posted_urls) == 0
        assert data.get("reflector_fired", []) == []
