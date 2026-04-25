"""Minimal Friday agent scaffold. Copy and fill in."""

from dataclasses import dataclass

from friday_agent_sdk import AgentContext, agent, err, ok, parse_input


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

    response = ctx.llm.generate(
        messages=[{"role": "user", "content": data.task}],
        model="anthropic:claude-haiku-4-5",
    )
    return ok({"reply": response.text})


if __name__ == "__main__":
    from friday_agent_sdk import run
    run()
