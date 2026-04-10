"""The @agent decorator — registers a handler function with metadata."""

from typing import Any, Callable

from friday_agent_sdk._registry import AgentRegistration, register_agent


def agent(
    *,
    id: str,
    version: str,
    description: str,
    display_name: str | None = None,
    summary: str | None = None,
    constraints: str | None = None,
    examples: list[str] | None = None,
    input_schema: type | None = None,
    output_schema: type | None = None,
    environment: dict[str, Any] | None = None,
    mcp: dict[str, Any] | None = None,
    llm: dict[str, Any] | None = None,
    use_workspace_skills: bool = False,
) -> Callable[..., Any]:
    """Decorator that registers a function as a Friday agent."""

    def decorator(fn: Callable[..., Any]) -> Callable[..., Any]:
        registration = AgentRegistration(
            id=id,
            version=version,
            description=description,
            handler=fn,
            display_name=display_name,
            summary=summary,
            constraints=constraints,
            examples=examples,
            input_schema=input_schema,
            output_schema=output_schema,
            environment=environment,
            mcp=mcp,
            llm=llm,
            use_workspace_skills=use_workspace_skills,
        )
        register_agent(registration)
        return fn

    return decorator
