"""Minimal Friday agent scaffold. Copy and fill in."""

from dataclasses import dataclass

from friday_agent_sdk import AgentContext, agent, err, ok, parse_input
from friday_agent_sdk._bridge import Agent  # noqa: F401 — componentize-py needs this


@dataclass
class Input:
    task: str


@agent(
    id="my-agent",
    version="0.1.0",
    description="One-line description of what this agent does.",
)
def execute(prompt: str, ctx: AgentContext):
    try:
        data = parse_input(prompt, Input)
    except ValueError as e:
        return err(f"Invalid input: {e}")

    if ctx.llm is None:
        return err("LLM capability not available")

    response = ctx.llm.generate(
        messages=[{"role": "user", "content": data.task}],
        model="anthropic:claude-haiku-4-5",
    )
    return ok({"reply": response.text})
