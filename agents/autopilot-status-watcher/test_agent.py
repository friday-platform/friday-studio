"""Unit tests for autopilot-status-watcher validator integration."""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import MagicMock

import pytest

from agent import (
    _extract_changed_files,
    _fire_post_session_validator,
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
    tool_calls: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    blocks = []
    if tool_calls:
        blocks.append({"toolCalls": tool_calls})
    return {"status": status, "sessionId": "sess-1", "agentBlocks": blocks}


class TestExtractChangedFiles:
    def test_extracts_write_and_edit_paths(self) -> None:
        data = _session_data(tool_calls=[
            {"toolName": "Write", "args": {"file_path": "/a.ts"}},
            {"toolName": "Edit", "args": {"path": "/b.ts"}},
            {"toolName": "fs_write", "args": {"file_path": "/c.ts"}},
        ])
        assert _extract_changed_files(data) == ["/a.ts", "/b.ts", "/c.ts"]

    def test_returns_empty_for_no_tool_calls(self) -> None:
        data = _session_data(tool_calls=[])
        assert _extract_changed_files(data) == []

    def test_deduplicates(self) -> None:
        data = _session_data(tool_calls=[
            {"toolName": "Write", "args": {"file_path": "/a.ts"}},
            {"toolName": "Edit", "args": {"path": "/a.ts"}},
        ])
        assert _extract_changed_files(data) == ["/a.ts"]


class TestFirePostSessionValidator:
    def test_returns_result_on_200(self) -> None:
        ctx = _make_ctx({"signals/post-session-validate": (200, {"validated": True})})
        result = _fire_post_session_validator(ctx, "http://test:8080", "kernel_ws", {"test": True})
        assert result == {"validated": True}

    def test_returns_none_on_non_200(self) -> None:
        ctx = _make_ctx({"signals/post-session-validate": (500, None)})
        result = _fire_post_session_validator(ctx, "http://test:8080", "kernel_ws", {"test": True})
        assert result is None

    def test_returns_none_on_exception(self) -> None:
        ctx = MagicMock()
        ctx.http.fetch.side_effect = Exception("timeout")
        result = _fire_post_session_validator(ctx, "http://test:8080", "kernel_ws", {})
        assert result is None


class TestExecuteValidatorIntegration:
    def test_completed_with_changed_files_fires_validator(self) -> None:
        session = _session_data(
            status="completed",
            tool_calls=[{"toolName": "Write", "args": {"file_path": "/changed.ts"}}],
        )
        ctx = _make_ctx({
            "narrative/dispatch-log": (200, [_dispatch_entry("task-1")]),
            "narrative/autopilot-backlog": (200, []),
            "sessions/sess-1": (200, session),
            "signals/post-session-validate": (200, {"validated": True, "results": [], "discoveriesAppended": 0}),
        })
        result = execute("observe", ctx)
        assert result is not None
        data = result.get("data") or result
        observations = data.get("observations", [])
        assert len(observations) == 1
        assert observations[0]["marked"] == "delegated-to-validator"

    def test_completed_no_changed_files_marks_directly(self) -> None:
        session = _session_data(status="completed", tool_calls=[])
        post_calls: list[str] = []
        base_ctx = _make_ctx({
            "narrative/dispatch-log": (200, [_dispatch_entry("task-2")]),
            "narrative/autopilot-backlog": (200, []),
            "sessions/sess-1": (200, session),
        })
        original_fetch = base_ctx.http.fetch

        def tracking_fetch(url: str, **kwargs: Any) -> Any:
            if kwargs.get("method") == "POST" and "autopilot-backlog" in url:
                post_calls.append(url)
            return original_fetch(url, **kwargs)

        base_ctx.http.fetch = tracking_fetch
        result = execute("observe", base_ctx)
        data = result.get("data") or result
        observations = data.get("observations", [])
        assert len(observations) == 1
        assert observations[0]["marked"] == "completed"
        assert len(post_calls) >= 1

    def test_failed_session_marks_blocked_directly(self) -> None:
        session = _session_data(
            status="failed",
            tool_calls=[{"toolName": "Write", "args": {"file_path": "/changed.ts"}}],
        )
        ctx = _make_ctx({
            "narrative/dispatch-log": (200, [_dispatch_entry("task-3")]),
            "narrative/autopilot-backlog": (200, []),
            "sessions/sess-1": (200, session),
        })
        result = execute("observe", ctx)
        data = result.get("data") or result
        observations = data.get("observations", [])
        assert len(observations) == 1
        assert observations[0]["marked"] == "blocked"

    def test_validator_timeout_falls_back_to_direct_marking(self) -> None:
        session = _session_data(
            status="completed",
            tool_calls=[{"toolName": "Write", "args": {"file_path": "/changed.ts"}}],
        )
        ctx = _make_ctx({
            "narrative/dispatch-log": (200, [_dispatch_entry("task-4")]),
            "narrative/autopilot-backlog": (200, []),
            "sessions/sess-1": (200, session),
            "signals/post-session-validate": (500, None),
        })
        result = execute("observe", ctx)
        data = result.get("data") or result
        observations = data.get("observations", [])
        assert len(observations) == 1
        assert observations[0]["marked"] == "completed"
