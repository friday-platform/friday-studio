"""Tests for serialize_data() — dict, dataclass, string → Python objects."""

from dataclasses import dataclass

from friday_agent_sdk._serialize import serialize_data


class TestSerializeData:
    def test_dict_passthrough(self):
        result = serialize_data({"key": "value", "num": 42})
        assert result == {"key": "value", "num": 42}

    def test_string_passthrough(self):
        result = serialize_data("plain text")
        assert result == "plain text"

    def test_dataclass_to_dict(self):
        @dataclass
        class Output:
            name: str
            count: int

        result = serialize_data(Output(name="test", count=3))
        assert result == {"name": "test", "count": 3}

    def test_nested_dataclass(self):
        @dataclass
        class Inner:
            x: int

        @dataclass
        class Outer:
            inner: Inner
            label: str

        result = serialize_data(Outer(inner=Inner(x=7), label="nested"))
        assert result == {"inner": {"x": 7}, "label": "nested"}

    def test_list_passthrough(self):
        result = serialize_data([1, 2, 3])
        assert result == [1, 2, 3]
