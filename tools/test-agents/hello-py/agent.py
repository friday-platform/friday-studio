"""
hello-py: Python test agent exercising LLM + tools via the NATS protocol.

Requires friday_agent_sdk. From a checkout of friday-platform/agent-sdk:
    pip install -e ./packages/python
"""

from friday_agent_sdk import AgentContext, agent, err, ok


@agent(
    id="hello-py",
    version="1.0.0",
    description="Python test agent — calls LLM and lists tools, streams progress.",
)
def execute(prompt: str, ctx: AgentContext):
    # Stream intent so the Stream tab shows activity immediately
    ctx.stream.intent(f'Processing: "{prompt}"')

    # List available tools and stream what we find
    tools = ctx.tools.list()
    ctx.stream.progress(f"Found {len(tools)} available tool(s).")

    # Call the LLM
    ctx.stream.progress("Calling LLM...")
    try:
        response = ctx.llm.generate(
            messages=[
                {
                    "role": "system",
                    "content": "You are a concise assistant. Reply in 1-2 sentences.",
                },
                {"role": "user", "content": prompt},
            ],
            model="anthropic:claude-haiku-4-5",
        )
    except Exception as e:
        return err(f"LLM call failed: {e}")

    llm_text = response.text or ""
    ctx.stream.progress(f"LLM responded ({response.model}, {response.usage.get('outputTokens', '?')} tokens).")

    tool_summary = (
        ", ".join(t.name for t in tools[:5]) + ("..." if len(tools) > 5 else "")
        if tools
        else "none"
    )

    return ok({
        "reply": llm_text,
        "toolsAvailable": tool_summary,
        "model": response.model,
    })


if __name__ == "__main__":
    from friday_agent_sdk import run
    run()
