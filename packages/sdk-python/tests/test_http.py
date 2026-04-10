"""Tests for Http wrapper — ctx.http.fetch().

componentize-py unwraps result<T, E>: Ok returns T directly, Err raises
an Err(str) exception with a .value attribute.
"""

import json
from dataclasses import dataclass
from unittest.mock import MagicMock

import pytest

from friday_agent_sdk._types import Http, HttpError, HttpResponse


@dataclass(frozen=True)
class _Err(Exception):
    """Simulates componentize_py_types.Err for native tests."""

    value: str


def _ok_response(**overrides) -> str:
    """Build a valid HTTP response JSON string."""
    data = {
        "status": 200,
        "headers": {"content-type": "application/json"},
        "body": '{"ok": true}',
    }
    data.update(overrides)
    return json.dumps(data)


class TestFetch:
    def test_serializes_request_correctly(self):
        mock = MagicMock(return_value=_ok_response())
        http = Http(http_fetch=mock)

        http.fetch("https://example.com/api")

        sent = json.loads(mock.call_args[0][0])
        assert sent["url"] == "https://example.com/api"
        assert sent["method"] == "GET"

    def test_returns_http_response(self):
        mock = MagicMock(return_value=_ok_response())
        http = Http(http_fetch=mock)

        result = http.fetch("https://example.com/api")

        assert isinstance(result, HttpResponse)
        assert result.status == 200
        assert result.headers == {"content-type": "application/json"}
        assert result.body == '{"ok": true}'

    def test_optional_params_omitted_when_none(self):
        mock = MagicMock(return_value=_ok_response())
        http = Http(http_fetch=mock)

        http.fetch("https://example.com")

        sent = json.loads(mock.call_args[0][0])
        assert "headers" not in sent
        assert "body" not in sent
        assert "timeout_ms" not in sent

    def test_optional_params_included_when_set(self):
        mock = MagicMock(return_value=_ok_response())
        http = Http(http_fetch=mock)

        http.fetch(
            "https://example.com",
            method="POST",
            headers={"Authorization": "Bearer tok"},
            body='{"data": 1}',
            timeout_ms=5000,
        )

        sent = json.loads(mock.call_args[0][0])
        assert sent["method"] == "POST"
        assert sent["headers"] == {"Authorization": "Bearer tok"}
        assert sent["body"] == '{"data": 1}'
        assert sent["timeout_ms"] == 5000

    def test_json_helper_parses_body(self):
        mock = MagicMock(return_value=_ok_response(body='{"items": [1, 2, 3]}'))
        http = Http(http_fetch=mock)

        result = http.fetch("https://example.com")

        assert result.json() == {"items": [1, 2, 3]}

    def test_json_helper_raises_on_invalid_json(self):
        mock = MagicMock(return_value=_ok_response(body="not json"))
        http = Http(http_fetch=mock)

        result = http.fetch("https://example.com")

        with pytest.raises(json.JSONDecodeError):
            result.json()

    def test_raises_http_error_with_e_value(self):
        mock = MagicMock(side_effect=_Err("connection refused"))
        http = Http(http_fetch=mock)

        with pytest.raises(HttpError, match="connection refused"):
            http.fetch("https://example.com")

    def test_http_error_is_exception(self):
        assert issubclass(HttpError, Exception)

    def test_empty_headers_and_body_defaults(self):
        mock = MagicMock(
            return_value=json.dumps({"status": 204})
        )
        http = Http(http_fetch=mock)

        result = http.fetch("https://example.com")

        assert result.headers == {}
        assert result.body == ""
