"""Module-level agent registration — one agent per WASM component."""

from dataclasses import dataclass, field
from typing import Any, Callable


@dataclass
class AgentRegistration:
    """Stores everything the @agent decorator captures."""

    id: str
    version: str
    description: str
    handler: Callable[..., Any]
    display_name: str | None = field(default=None)
    summary: str | None = field(default=None)
    constraints: str | None = field(default=None)
    examples: list[str] | None = field(default=None)
    input_schema: type | None = field(default=None)
    output_schema: type | None = field(default=None)
    input_json_schema: dict[str, Any] | None = field(default=None)
    output_json_schema: dict[str, Any] | None = field(default=None)
    environment: dict[str, Any] | None = field(default=None)
    mcp: dict[str, Any] | None = field(default=None)
    llm: dict[str, Any] | None = field(default=None)
    use_workspace_skills: bool = field(default=False)


_registered_agent: AgentRegistration | None = None


def register_agent(registration: AgentRegistration) -> None:
    """Register an agent. Raises if one is already registered."""
    global _registered_agent
    if _registered_agent is not None:
        raise RuntimeError(
            f"Agent already registered: {_registered_agent.id}. "
            "Only one @agent per module is supported."
        )
    _registered_agent = registration


def get_registered_agent() -> AgentRegistration:
    """Retrieve the registered agent. Raises if none registered."""
    if _registered_agent is None:
        raise RuntimeError("No agent registered. Use the @agent decorator.")
    return _registered_agent


def _reset_registry() -> None:
    """Reset registry state — for tests only."""
    global _registered_agent
    _registered_agent = None
