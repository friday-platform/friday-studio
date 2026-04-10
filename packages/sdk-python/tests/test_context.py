"""Tests for build_context() — constructs AgentContext from raw JSON dict."""

from friday_agent_sdk._context import build_context
from friday_agent_sdk._types import AgentContext, SessionData


class TestBuildContext:
    def test_full_context(self):
        raw = {
            "env": {"API_KEY": "secret"},
            "config": {"temperature": 0.7},
            "session": {
                "id": "sess-1",
                "workspace_id": "ws-1",
                "user_id": "user-1",
                "datetime": "2026-01-01T00:00:00Z",
            },
            "output_schema": {"type": "object"},
        }
        ctx = build_context(raw)
        assert isinstance(ctx, AgentContext)
        assert ctx.env == {"API_KEY": "secret"}
        assert ctx.config == {"temperature": 0.7}
        assert isinstance(ctx.session, SessionData)
        assert ctx.session.id == "sess-1"
        assert ctx.session.workspace_id == "ws-1"
        assert ctx.output_schema == {"type": "object"}

    def test_empty_context(self):
        ctx = build_context({})
        assert ctx.env == {}
        assert ctx.config == {}
        assert ctx.session is None
        assert ctx.output_schema is None

    def test_partial_context(self):
        raw = {"env": {"FOO": "bar"}}
        ctx = build_context(raw)
        assert ctx.env == {"FOO": "bar"}
        assert ctx.config == {}
        assert ctx.session is None

    def test_session_fields(self):
        raw = {
            "session": {
                "id": "s1",
                "workspace_id": "w1",
                "user_id": "u1",
                "datetime": "2026-04-02T12:00:00Z",
            }
        }
        ctx = build_context(raw)
        assert ctx.session is not None
        assert ctx.session.user_id == "u1"
        assert ctx.session.datetime == "2026-04-02T12:00:00Z"

    def test_llm_is_none_without_wit(self):
        """Without WIT bindings (native Python), llm is None."""
        ctx = build_context({})
        assert ctx.llm is None

    def test_http_is_none_without_wit(self):
        """Without WIT bindings (native Python), http is None."""
        ctx = build_context({})
        assert ctx.http is None

    def test_stream_available_with_wit_stubs(self):
        """stream-emit is a base WIT capability, available when stubs exist."""
        ctx = build_context({})
        assert ctx.stream is not None

    def test_llm_config_read_from_raw(self):
        """llm_config key in raw dict is read for LLM builder."""
        # Without WIT bindings, llm is None regardless of config,
        # but build_context should not error when llm_config is present.
        raw = {"llm_config": {"model": "anthropic:claude-haiku-4-5"}}
        ctx = build_context(raw)
        # In native mode, llm is None (no WIT), but no crash
        assert ctx.llm is None
