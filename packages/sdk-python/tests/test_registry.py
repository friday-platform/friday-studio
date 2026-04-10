"""Tests for agent registry — register and retrieve agent registrations."""

import pytest

from friday_agent_sdk._registry import (
    AgentRegistration,
    _reset_registry,
    get_registered_agent,
    register_agent,
)


@pytest.fixture(autouse=True)
def clean_registry():
    """Reset module-level registry between tests."""
    _reset_registry()
    yield
    _reset_registry()


def _dummy_handler(prompt, ctx):
    return None


class TestRegisterAgent:
    def test_registers_with_required_fields(self):
        reg = AgentRegistration(
            id="test-agent",
            version="1.0.0",
            description="A test agent",
            handler=_dummy_handler,
        )
        register_agent(reg)
        retrieved = get_registered_agent()
        assert retrieved.id == "test-agent"
        assert retrieved.version == "1.0.0"
        assert retrieved.description == "A test agent"
        assert retrieved.handler is _dummy_handler

    def test_optional_fields_default_to_none(self):
        reg = AgentRegistration(
            id="minimal",
            version="0.1.0",
            description="Minimal agent",
            handler=_dummy_handler,
        )
        register_agent(reg)
        retrieved = get_registered_agent()
        assert retrieved.display_name is None
        assert retrieved.summary is None
        assert retrieved.constraints is None
        assert retrieved.examples is None
        assert retrieved.input_schema is None
        assert retrieved.output_schema is None
        assert retrieved.input_json_schema is None
        assert retrieved.output_json_schema is None
        assert retrieved.environment is None
        assert retrieved.mcp is None
        assert retrieved.llm is None
        assert retrieved.use_workspace_skills is False

    def test_duplicate_registration_raises(self):
        reg = AgentRegistration(
            id="first",
            version="1.0.0",
            description="First",
            handler=_dummy_handler,
        )
        register_agent(reg)
        with pytest.raises(RuntimeError, match="already registered"):
            register_agent(reg)


class TestGetRegisteredAgent:
    def test_raises_when_no_agent_registered(self):
        with pytest.raises(RuntimeError, match="No agent registered"):
            get_registered_agent()
