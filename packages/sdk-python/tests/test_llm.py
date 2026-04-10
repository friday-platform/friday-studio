"""Tests for Llm wrapper — ctx.llm.generate() and ctx.llm.generate_object().

componentize-py unwraps result<T, E>: Ok returns T directly, Err raises
an Err(str) exception with a .value attribute.
"""

import json
from dataclasses import dataclass
from unittest.mock import MagicMock

import pytest

from friday_agent_sdk._types import Llm, LlmError, LlmResponse


@dataclass(frozen=True)
class _Err(Exception):
    """Simulates componentize_py_types.Err for native tests."""

    value: str


def _ok_response(**overrides) -> str:
    """Build a valid LLM response JSON string."""
    data = {
        "text": "hello",
        "object": None,
        "model": "anthropic:claude-haiku-4-5",
        "usage": {"input_tokens": 10, "output_tokens": 5},
        "finish_reason": "end_turn",
    }
    data.update(overrides)
    return json.dumps(data)


class TestGenerate:
    def test_serializes_request_correctly(self):
        mock = MagicMock(return_value=_ok_response())
        llm = Llm(llm_generate=mock)

        llm.generate(
            messages=[{"role": "user", "content": "hi"}],
            model="anthropic:claude-haiku-4-5",
        )

        sent = json.loads(mock.call_args[0][0])
        assert sent["messages"] == [{"role": "user", "content": "hi"}]
        assert sent["model"] == "anthropic:claude-haiku-4-5"

    def test_returns_llm_response(self):
        mock = MagicMock(return_value=_ok_response())
        llm = Llm(llm_generate=mock)

        result = llm.generate(
            messages=[{"role": "user", "content": "hi"}],
            model="anthropic:claude-haiku-4-5",
        )

        assert isinstance(result, LlmResponse)
        assert result.text == "hello"
        assert result.model == "anthropic:claude-haiku-4-5"
        assert result.usage == {"input_tokens": 10, "output_tokens": 5}
        assert result.finish_reason == "end_turn"

    def test_optional_params_omitted_when_none(self):
        mock = MagicMock(return_value=_ok_response())
        llm = Llm(llm_generate=mock)

        llm.generate(messages=[{"role": "user", "content": "hi"}])

        sent = json.loads(mock.call_args[0][0])
        assert "model" not in sent
        assert "max_tokens" not in sent
        assert "temperature" not in sent
        assert "provider_options" not in sent

    def test_optional_params_included_when_set(self):
        mock = MagicMock(return_value=_ok_response())
        llm = Llm(llm_generate=mock)

        llm.generate(
            messages=[{"role": "user", "content": "hi"}],
            max_tokens=100,
            temperature=0.5,
        )

        sent = json.loads(mock.call_args[0][0])
        assert sent["max_tokens"] == 100
        assert sent["temperature"] == 0.5

    def test_provider_options_included_when_set(self):
        mock = MagicMock(return_value=_ok_response())
        llm = Llm(llm_generate=mock)

        llm.generate(
            messages=[{"role": "user", "content": "hi"}],
            provider_options={"anthropic": {"system_prompt": "be helpful"}},
        )

        sent = json.loads(mock.call_args[0][0])
        assert sent["provider_options"] == {
            "anthropic": {"system_prompt": "be helpful"},
        }

    def test_raises_llm_error_with_e_value(self):
        mock = MagicMock(side_effect=_Err("model not found"))
        llm = Llm(llm_generate=mock)

        with pytest.raises(LlmError, match="model not found"):
            llm.generate(
                messages=[{"role": "user", "content": "hi"}],
                model="anthropic:claude-haiku-4-5",
            )

    def test_llm_error_is_exception(self):
        assert issubclass(LlmError, Exception)


class TestGenerateObject:
    def test_returns_llm_response_with_object(self):
        mock = MagicMock(
            return_value=_ok_response(
                text=None,
                object={"name": "Alice", "age": 30},
            )
        )
        llm = Llm(llm_generate=mock)

        result = llm.generate_object(
            messages=[{"role": "user", "content": "extract name and age"}],
            schema={"type": "object", "properties": {"name": {}, "age": {}}},
            model="anthropic:claude-haiku-4-5",
        )

        assert isinstance(result, LlmResponse)
        assert result.object == {"name": "Alice", "age": 30}
        assert result.text is None
        assert result.usage == {"input_tokens": 10, "output_tokens": 5}

    def test_includes_output_schema_in_request(self):
        mock = MagicMock(return_value=_ok_response(text=None, object={"x": 1}))
        llm = Llm(llm_generate=mock)

        schema = {"type": "object", "properties": {"x": {"type": "integer"}}}
        llm.generate_object(
            messages=[{"role": "user", "content": "give x"}],
            schema=schema,
            model="anthropic:claude-haiku-4-5",
        )

        sent = json.loads(mock.call_args[0][0])
        assert sent["output_schema"] == schema

    def test_raises_llm_error_on_failure(self):
        mock = MagicMock(side_effect=_Err("schema validation failed"))
        llm = Llm(llm_generate=mock)

        with pytest.raises(LlmError, match="schema validation failed"):
            llm.generate_object(
                messages=[{"role": "user", "content": "hi"}],
                schema={"type": "object"},
            )

    def test_provider_options_included_when_set(self):
        mock = MagicMock(return_value=_ok_response(text=None, object={"x": 1}))
        llm = Llm(llm_generate=mock)

        llm.generate_object(
            messages=[{"role": "user", "content": "give x"}],
            schema={"type": "object", "properties": {"x": {"type": "integer"}}},
            provider_options={"claude-code": {"env": {"FOO": "bar"}}},
        )

        sent = json.loads(mock.call_args[0][0])
        assert sent["provider_options"] == {
            "claude-code": {"env": {"FOO": "bar"}},
        }

    def test_provider_options_omitted_when_none(self):
        mock = MagicMock(return_value=_ok_response(text=None, object={"x": 1}))
        llm = Llm(llm_generate=mock)

        llm.generate_object(
            messages=[{"role": "user", "content": "give x"}],
            schema={"type": "object"},
        )

        sent = json.loads(mock.call_args[0][0])
        assert "provider_options" not in sent


class TestLlmConfig:
    def test_config_not_sent_in_request(self):
        """Agent LLM config is host-side metadata, not sent per-request."""
        mock = MagicMock(return_value=_ok_response())
        llm = Llm(
            llm_generate=mock,
            agent_llm_config={"model": "anthropic:claude-haiku-4-5"},
        )

        llm.generate(messages=[{"role": "user", "content": "hi"}])

        sent = json.loads(mock.call_args[0][0])
        # config is stored on Llm but not serialized into the request
        assert "agent_llm_config" not in sent
