"""Tests for ok()/err() result helpers and OkResult/ErrResult types."""

from friday_agent_sdk._result import ErrResult, OkResult, err, ok


class TestOk:
    def test_ok_with_dict(self):
        result = ok({"key": "val"})
        assert isinstance(result, OkResult)
        assert result.data == {"key": "val"}

    def test_ok_with_string(self):
        result = ok("plain string")
        assert isinstance(result, OkResult)
        assert result.data == "plain string"

    def test_ok_with_dataclass(self):
        from dataclasses import dataclass

        @dataclass
        class Output:
            name: str

        output = Output(name="test")
        result = ok(output)
        assert isinstance(result, OkResult)
        assert result.data == output

    def test_ok_is_not_err(self):
        result = ok("data")
        assert not isinstance(result, ErrResult)


class TestErr:
    def test_err_with_message(self):
        result = err("boom")
        assert isinstance(result, ErrResult)
        assert result.error == "boom"

    def test_err_is_not_ok(self):
        result = err("fail")
        assert not isinstance(result, OkResult)


class TestTaggedUnionDispatch:
    """Verify isinstance dispatch works for bridge-style switching."""

    def test_dispatch_ok(self):
        result = ok({"x": 1})
        if isinstance(result, OkResult):
            tag = "ok"
        elif isinstance(result, ErrResult):
            tag = "err"
        assert tag == "ok"

    def test_dispatch_err(self):
        result = err("bad")
        if isinstance(result, OkResult):
            tag = "ok"
        elif isinstance(result, ErrResult):
            tag = "err"
        assert tag == "err"
