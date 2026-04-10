"""Tests for StreamEmitter — ctx.stream.progress() / intent() / emit()."""

import json
from unittest.mock import MagicMock

from friday_agent_sdk._types import StreamEmitter


class TestEmit:
    def test_emit_dict_serializes_to_json(self):
        mock = MagicMock()
        stream = StreamEmitter(stream_emit=mock)

        stream.emit("custom-event", {"key": "value"})

        mock.assert_called_once_with("custom-event", '{"key": "value"}')

    def test_emit_string_passes_through(self):
        mock = MagicMock()
        stream = StreamEmitter(stream_emit=mock)

        stream.emit("custom-event", "raw payload")

        mock.assert_called_once_with("custom-event", "raw payload")


class TestProgress:
    def test_emits_data_tool_progress(self):
        mock = MagicMock()
        stream = StreamEmitter(stream_emit=mock)

        stream.progress("Analyzing task")

        event_type, data = mock.call_args[0]
        assert event_type == "data-tool-progress"
        parsed = json.loads(data)
        assert parsed == {"toolName": "agent", "content": "Analyzing task"}

    def test_custom_tool_name(self):
        mock = MagicMock()
        stream = StreamEmitter(stream_emit=mock)

        stream.progress("Running query", tool_name="sql-executor")

        _, data = mock.call_args[0]
        parsed = json.loads(data)
        assert parsed["toolName"] == "sql-executor"
        assert parsed["content"] == "Running query"

    def test_default_tool_name_is_agent(self):
        mock = MagicMock()
        stream = StreamEmitter(stream_emit=mock)

        stream.progress("Working...")

        _, data = mock.call_args[0]
        assert json.loads(data)["toolName"] == "agent"


class TestIntent:
    def test_emits_data_intent(self):
        mock = MagicMock()
        stream = StreamEmitter(stream_emit=mock)

        stream.intent("I will review the PR")

        event_type, data = mock.call_args[0]
        assert event_type == "data-intent"
        parsed = json.loads(data)
        assert parsed == {"content": "I will review the PR"}
