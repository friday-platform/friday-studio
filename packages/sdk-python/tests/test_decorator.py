"""Tests for @agent decorator — registration and metadata storage."""

import pytest

from friday_agent_sdk._decorator import agent
from friday_agent_sdk._registry import _reset_registry, get_registered_agent


@pytest.fixture(autouse=True)
def clean_registry():
    _reset_registry()
    yield
    _reset_registry()


class TestAgentDecorator:
    def test_registers_handler_with_required_fields(self):
        @agent(id="my-agent", version="1.0.0", description="Does things")
        def execute(prompt, ctx):
            return None

        reg = get_registered_agent()
        assert reg.id == "my-agent"
        assert reg.version == "1.0.0"
        assert reg.description == "Does things"
        assert reg.handler is execute

    def test_preserves_function_identity(self):
        @agent(id="test", version="1.0.0", description="test")
        def my_func(prompt, ctx):
            return "hello"

        # Decorated function should still be callable
        assert my_func("prompt", None) == "hello"

    def test_stores_optional_metadata(self):
        @agent(
            id="full-agent",
            version="2.0.0",
            description="Full featured",
            display_name="Full Agent",
            summary="A fully featured agent",
            constraints="Must have API key",
            examples=["Do thing A", "Do thing B"],
        )
        def execute(prompt, ctx):
            return None

        reg = get_registered_agent()
        assert reg.display_name == "Full Agent"
        assert reg.summary == "A fully featured agent"
        assert reg.constraints == "Must have API key"
        assert reg.examples == ["Do thing A", "Do thing B"]

    def test_stores_input_and_output_schema(self):
        from dataclasses import dataclass

        @dataclass
        class MyInput:
            name: str

        @dataclass
        class MyOutput:
            result: str

        @agent(
            id="schema-agent",
            version="1.0.0",
            description="With schemas",
            input_schema=MyInput,
            output_schema=MyOutput,
        )
        def execute(inp, ctx):
            return None

        reg = get_registered_agent()
        assert reg.input_schema is MyInput
        assert reg.output_schema is MyOutput

    def test_stores_environment_and_mcp(self):
        env_config = {
            "required": [{"name": "API_KEY", "description": "The API key"}]
        }
        mcp_config = {
            "slack": {"transport": {"type": "stdio", "command": "npx"}}
        }

        @agent(
            id="env-agent",
            version="1.0.0",
            description="With env",
            environment=env_config,
            mcp=mcp_config,
        )
        def execute(prompt, ctx):
            return None

        reg = get_registered_agent()
        assert reg.environment == env_config
        assert reg.mcp == mcp_config

    def test_stores_llm_config(self):
        llm_config = {"provider": "anthropic", "model": "claude-sonnet-4-20250514"}

        @agent(
            id="llm-agent",
            version="1.0.0",
            description="With LLM",
            llm=llm_config,
        )
        def execute(prompt, ctx):
            return None

        reg = get_registered_agent()
        assert reg.llm == llm_config

    def test_use_workspace_skills_defaults_false(self):
        @agent(id="default-agent", version="1.0.0", description="test")
        def execute(prompt, ctx):
            return None

        reg = get_registered_agent()
        assert reg.use_workspace_skills is False

    def test_stores_use_workspace_skills(self):
        @agent(
            id="skills-agent",
            version="1.0.0",
            description="With skills",
            use_workspace_skills=True,
        )
        def execute(prompt, ctx):
            return None

        reg = get_registered_agent()
        assert reg.use_workspace_skills is True
