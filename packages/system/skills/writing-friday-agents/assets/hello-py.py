from friday_agent_sdk import AgentContext, agent, err, ok


@agent(
    id="hello-py",
    version="1.0.0",
    description="Minimal worked example — LLM + tool listing + streaming progress.",
)
def execute(prompt: str, ctx: AgentContext):
    ctx.stream.intent(f'Processing: "{prompt}"')

    tools = ctx.tools.list()
    ctx.stream.progress(f"Found {len(tools)} available tool(s).")

    ctx.stream.progress("Calling LLM...")
    try:
        response = ctx.llm.generate(
            messages=[
                {"role": "system", "content": "You are a concise assistant. Reply in 1-2 sentences."},
                {"role": "user", "content": prompt},
            ],
            model="anthropic:claude-haiku-4-5",
        )
    except Exception as e:
        return err(f"LLM call failed: {e}")

    ctx.stream.progress(f"LLM responded ({response.model}, {response.usage.get('outputTokens', '?')} tokens).")

    tool_summary = (
        ", ".join(t.name for t in tools[:5]) + ("..." if len(tools) > 5 else "")
        if tools
        else "none"
    )

    return ok({
        "reply": response.text or "",
        "toolsAvailable": tool_summary,
        "model": response.model,
    })


if __name__ == "__main__":
    from friday_agent_sdk import run
    run()
