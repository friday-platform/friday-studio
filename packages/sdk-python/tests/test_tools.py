"""Tests for Tools wrapper — ctx.tools.call() and ctx.tools.list().

componentize-py unwraps result<T, E>: Ok returns T directly, Err raises
an Err(str) exception with a .value attribute.
"""

import json
from dataclasses import dataclass
from unittest.mock import MagicMock

import pytest

from friday_agent_sdk._types import ToolCallError, ToolDefinition, Tools


@dataclass(frozen=True)
class _Err(Exception):
    """Simulates componentize_py_types.Err for native tests."""

    value: str


class TestToolCall:
    def test_success_returns_parsed_dict(self):
        mock_call = MagicMock(return_value=json.dumps({"result": "ok"}))
        tools = Tools(call_tool=mock_call, list_tools=MagicMock())

        result = tools.call("my_tool", {"key": "val"})

        assert result == {"result": "ok"}
        mock_call.assert_called_once_with("my_tool", json.dumps({"key": "val"}))

    def test_error_raises_tool_call_error(self):
        mock_call = MagicMock(side_effect=_Err("tool not found"))
        tools = Tools(call_tool=mock_call, list_tools=MagicMock())

        with pytest.raises(ToolCallError, match="tool not found"):
            tools.call("missing_tool", {})

    def test_args_json_serialized(self):
        mock_call = MagicMock(return_value=json.dumps({}))
        tools = Tools(call_tool=mock_call, list_tools=MagicMock())

        tools.call("t", {"nested": {"a": [1, 2]}})

        sent_json = mock_call.call_args[0][1]
        assert json.loads(sent_json) == {"nested": {"a": [1, 2]}}

    def test_tool_call_error_is_exception(self):
        assert issubclass(ToolCallError, Exception)

    def test_tool_call_error_carries_message(self):
        err = ToolCallError("something broke")
        assert str(err) == "something broke"


class TestToolList:
    def test_returns_tool_definitions(self):
        @dataclass
        class WitToolDef:
            name: str
            description: str
            input_schema: str

        mock_list = MagicMock(
            return_value=[
                WitToolDef(
                    name="search",
                    description="Search the web",
                    input_schema=json.dumps({"type": "object"}),
                ),
            ]
        )
        tools = Tools(call_tool=MagicMock(), list_tools=mock_list)

        result = tools.list()

        assert len(result) == 1
        assert isinstance(result[0], ToolDefinition)
        assert result[0].name == "search"
        assert result[0].description == "Search the web"
        assert result[0].input_schema == {"type": "object"}

    def test_empty_list(self):
        tools = Tools(call_tool=MagicMock(), list_tools=MagicMock(return_value=[]))

        result = tools.list()

        assert result == []

    def test_multiple_tools(self):
        @dataclass
        class WitToolDef:
            name: str
            description: str
            input_schema: str

        mock_list = MagicMock(
            return_value=[
                WitToolDef(name="a", description="Tool A", input_schema="{}"),
                WitToolDef(name="b", description="Tool B", input_schema="{}"),
            ]
        )
        tools = Tools(call_tool=MagicMock(), list_tools=mock_list)

        result = tools.list()

        assert len(result) == 2
        assert result[0].name == "a"
        assert result[1].name == "b"
