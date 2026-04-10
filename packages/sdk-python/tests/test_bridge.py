"""Tests for the Agent bridge shim — WIT delegation to registered handler."""

import json
from dataclasses import dataclass

import pytest

from friday_agent_sdk._registry import (
    AgentRegistration,
    _reset_registry,
    register_agent,
)
from friday_agent_sdk._result import AgentExtras, ArtifactRef, OutlineRef, err, ok


def _is_ok(result) -> bool:
    """Check if result is the ok variant (works with both WIT and fallback types)."""
    return type(result).__name__ in ("AgentResult_Ok", "_AgentResult") and (
        not hasattr(result, "tag") or result.tag == "ok"
    )


def _is_err(result) -> bool:
    """Check if result is the err variant (works with both WIT and fallback types)."""
    return type(result).__name__ in ("AgentResult_Err", "_AgentResult") and (
        not hasattr(result, "tag") or result.tag == "err"
    )


@pytest.fixture(autouse=True)
def clean_registry():
    _reset_registry()
    yield
    _reset_registry()


def _register(handler, **kwargs):
    """Register a handler with minimal defaults."""
    defaults = {"id": "test-agent", "version": "1.0.0", "description": "test"}
    defaults.update(kwargs)
    register_agent(AgentRegistration(handler=handler, **defaults))


def _minimal_context_json():
    return json.dumps({"env": {}, "config": {}})


class TestGetMetadata:
    def test_required_fields(self):
        from friday_agent_sdk._bridge import Agent

        _register(lambda p, c: ok("x"))
        meta = json.loads(Agent().get_metadata())
        assert meta["id"] == "test-agent"
        assert meta["version"] == "1.0.0"
        assert meta["description"] == "test"

    def test_optional_fields_omitted_when_none(self):
        from friday_agent_sdk._bridge import Agent

        _register(lambda p, c: ok("x"))
        meta = json.loads(Agent().get_metadata())
        assert "displayName" not in meta
        assert "summary" not in meta
        assert "constraints" not in meta
        assert meta["expertise"] == {"examples": []}

    def test_optional_fields_included_when_set(self):
        from friday_agent_sdk._bridge import Agent

        _register(
            lambda p, c: ok("x"),
            display_name="Test Agent",
            summary="A test agent",
            constraints="be nice",
            examples=["example 1"],
        )
        meta = json.loads(Agent().get_metadata())
        assert meta["displayName"] == "Test Agent"
        assert meta["summary"] == "A test agent"
        assert meta["constraints"] == "be nice"
        assert meta["expertise"] == {"examples": ["example 1"]}

    def test_camel_case_keys(self):
        from friday_agent_sdk._bridge import Agent

        _register(
            lambda p, c: ok("x"),
            display_name="DN",
        )
        meta = json.loads(Agent().get_metadata())
        # Must be camelCase, not snake_case
        assert "displayName" in meta
        assert "display_name" not in meta

    def test_environment_mcp_llm_passthrough(self):
        from friday_agent_sdk._bridge import Agent

        env = {"required": [{"name": "API_KEY"}]}
        mcp_conf = {"servers": []}
        llm_conf = {"provider": "anthropic"}
        _register(
            lambda p, c: ok("x"),
            environment=env,
            mcp=mcp_conf,
            llm=llm_conf,
        )
        meta = json.loads(Agent().get_metadata())
        assert meta["environment"] == env
        assert meta["mcp"] == mcp_conf
        assert meta["llm"] == llm_conf

    def test_use_workspace_skills_omitted_when_false(self):
        from friday_agent_sdk._bridge import Agent

        _register(lambda p, c: ok("x"))
        meta = json.loads(Agent().get_metadata())
        assert "useWorkspaceSkills" not in meta

    def test_use_workspace_skills_emitted_when_true(self):
        from friday_agent_sdk._bridge import Agent

        _register(lambda p, c: ok("x"), use_workspace_skills=True)
        meta = json.loads(Agent().get_metadata())
        assert meta["useWorkspaceSkills"] is True

    def test_json_schema_passthrough(self):
        from friday_agent_sdk._bridge import Agent

        _register(
            lambda p, c: ok("x"),
            input_json_schema={"type": "object"},
            output_json_schema={"type": "string"},
        )
        meta = json.loads(Agent().get_metadata())
        assert meta["inputSchema"] == {"type": "object"}
        assert meta["outputSchema"] == {"type": "string"}


class TestExecute:
    def test_ok_result_dispatches(self):
        from friday_agent_sdk._bridge import Agent

        _register(lambda prompt, ctx: ok({"echo": prompt}))
        result = Agent().execute("hello", _minimal_context_json())
        assert _is_ok(result)
        assert json.loads(result.value) == {"data": {"echo": "hello"}}

    def test_err_result_dispatches(self):
        from friday_agent_sdk._bridge import Agent

        _register(lambda prompt, ctx: err("something broke"))
        result = Agent().execute("hello", _minimal_context_json())
        assert _is_err(result)
        assert result.value == "something broke"

    def test_handler_exception_returns_error(self):
        from friday_agent_sdk._bridge import Agent

        def exploding_handler(prompt, ctx):
            raise ValueError("kaboom")

        _register(exploding_handler)
        result = Agent().execute("hello", _minimal_context_json())
        assert _is_err(result)
        assert "kaboom" in result.value

    def test_invalid_return_type_returns_error(self):
        from friday_agent_sdk._bridge import Agent

        _register(lambda prompt, ctx: "not a result type")
        result = Agent().execute("hello", _minimal_context_json())
        assert _is_err(result)
        assert "OkResult or ErrResult" in result.value

    def test_string_ok_data_in_envelope(self):
        from friday_agent_sdk._bridge import Agent

        _register(lambda prompt, ctx: ok("plain string"))
        result = Agent().execute("hi", _minimal_context_json())
        assert _is_ok(result)
        assert json.loads(result.value) == {"data": "plain string"}

    def test_dataclass_ok_data_serialized(self):
        from friday_agent_sdk._bridge import Agent

        @dataclass
        class Output:
            name: str
            count: int

        _register(lambda prompt, ctx: ok(Output(name="test", count=5)))
        result = Agent().execute("hi", _minimal_context_json())
        assert _is_ok(result)
        assert json.loads(result.value) == {"data": {"name": "test", "count": 5}}

    def test_context_passed_to_handler(self):
        from friday_agent_sdk._bridge import Agent

        captured = {}

        def capturing_handler(prompt, ctx):
            captured["env"] = ctx.env
            return ok("done")

        _register(capturing_handler)
        context = json.dumps({"env": {"KEY": "val"}, "config": {}})
        Agent().execute("hi", context)
        assert captured["env"] == {"KEY": "val"}

    def test_config_passed_to_handler(self):
        from friday_agent_sdk._bridge import Agent

        captured = {}

        def handler(prompt, ctx):
            captured["config"] = ctx.config
            return ok("done")

        _register(handler)
        context = json.dumps({"config": {"model": "opus", "temp": 0.5}})
        Agent().execute("hi", context)
        assert captured["config"] == {"model": "opus", "temp": 0.5}

    def test_session_passed_to_handler(self):
        from friday_agent_sdk._bridge import Agent

        captured = {}

        def handler(prompt, ctx):
            captured["session"] = ctx.session
            return ok("done")

        _register(handler)
        context = json.dumps(
            {
                "session": {
                    "id": "sess_1",
                    "workspace_id": "ws_1",
                    "user_id": "user_42",
                    "datetime": "2026-04-03T12:00:00Z",
                }
            }
        )
        Agent().execute("hi", context)
        assert captured["session"].id == "sess_1"
        assert captured["session"].workspace_id == "ws_1"
        assert captured["session"].user_id == "user_42"
        assert captured["session"].datetime == "2026-04-03T12:00:00Z"

    def test_output_schema_passed_to_handler(self):
        from friday_agent_sdk._bridge import Agent

        captured = {}

        def handler(prompt, ctx):
            captured["output_schema"] = ctx.output_schema
            return ok("done")

        _register(handler)
        schema = {"type": "object", "properties": {"answer": {"type": "string"}}}
        context = json.dumps({"output_schema": schema})
        Agent().execute("hi", context)
        assert captured["output_schema"] == schema

    def test_missing_session_is_none(self):
        from friday_agent_sdk._bridge import Agent

        captured = {}

        def handler(prompt, ctx):
            captured["session"] = ctx.session
            return ok("done")

        _register(handler)
        Agent().execute("hi", json.dumps({}))
        assert captured["session"] is None


class TestExecuteExtras:
    def test_extras_none_produces_data_only_envelope(self):
        from friday_agent_sdk._bridge import Agent

        _register(lambda prompt, ctx: ok({"answer": 42}))
        result = Agent().execute("hi", _minimal_context_json())
        parsed = json.loads(result.value)
        assert parsed == {"data": {"answer": 42}}
        assert "artifactRefs" not in parsed
        assert "outlineRefs" not in parsed
        assert "reasoning" not in parsed

    def test_extras_with_reasoning(self):
        from friday_agent_sdk._bridge import Agent

        extras = AgentExtras(reasoning="I thought about it")
        _register(lambda prompt, ctx: ok("result", extras=extras))
        result = Agent().execute("hi", _minimal_context_json())
        parsed = json.loads(result.value)
        assert parsed["data"] == "result"
        assert parsed["reasoning"] == "I thought about it"

    def test_extras_with_artifact_refs(self):
        from friday_agent_sdk._bridge import Agent

        refs = [ArtifactRef(id="art-1", type="document", summary="A doc")]
        extras = AgentExtras(artifact_refs=refs)
        _register(lambda prompt, ctx: ok("done", extras=extras))
        result = Agent().execute("hi", _minimal_context_json())
        parsed = json.loads(result.value)
        assert parsed["artifactRefs"] == [
            {"id": "art-1", "type": "document", "summary": "A doc"}
        ]

    def test_extras_with_outline_refs(self):
        from friday_agent_sdk._bridge import Agent

        refs = [
            OutlineRef(
                service="google-calendar",
                title="Meeting",
                content="Standup at 9am",
                artifact_id="art-2",
                artifact_label="Calendar",
            )
        ]
        extras = AgentExtras(outline_refs=refs)
        _register(lambda prompt, ctx: ok("done", extras=extras))
        result = Agent().execute("hi", _minimal_context_json())
        parsed = json.loads(result.value)
        assert parsed["outlineRefs"] == [
            {
                "service": "google-calendar",
                "title": "Meeting",
                "content": "Standup at 9am",
                "artifactId": "art-2",
                "artifactLabel": "Calendar",
            }
        ]

    def test_outline_ref_omits_none_fields(self):
        from friday_agent_sdk._bridge import Agent

        refs = [OutlineRef(service="slack", title="Channel update")]
        extras = AgentExtras(outline_refs=refs)
        _register(lambda prompt, ctx: ok("done", extras=extras))
        result = Agent().execute("hi", _minimal_context_json())
        parsed = json.loads(result.value)
        outline = parsed["outlineRefs"][0]
        assert outline == {"service": "slack", "title": "Channel update"}
        assert "content" not in outline
        assert "artifactId" not in outline
        assert "artifactLabel" not in outline

    def test_full_extras_envelope(self):
        from friday_agent_sdk._bridge import Agent

        extras = AgentExtras(
            reasoning="Analyzed the PR",
            artifact_refs=[ArtifactRef(id="a1", type="code", summary="Patch")],
            outline_refs=[OutlineRef(service="github", title="PR #42")],
        )
        _register(lambda prompt, ctx: ok({"status": "ok"}, extras=extras))
        result = Agent().execute("hi", _minimal_context_json())
        parsed = json.loads(result.value)
        assert parsed["data"] == {"status": "ok"}
        assert parsed["reasoning"] == "Analyzed the PR"
        assert len(parsed["artifactRefs"]) == 1
        assert len(parsed["outlineRefs"]) == 1
