# MCP tools

MCP (Model Context Protocol) reaches external systems — GitHub, Postgres, Notion, time, etc. Declare servers in the decorator; call tools through `ctx.tools`.

## Contents

- Declaring servers — decorator shape, env vars, credential refs
- Discovering tools — `ctx.tools.list()` returns definitions
- Calling a tool — `ctx.tools.call(name, input)`
- LLM-driven tool use — loop pattern with `response.text` parsing
- Errors — don't swallow; let the runtime surface them
- Testing — mocking `ctx.tools` in unit tests

## Declaring servers

```python
@agent(
    id="release-notes",
    version="1.0.0",
    description="...",
    mcp={
        "github": {
            "transport": {
                "type": "stdio",
                "command": "npx",
                "args": ["-y", "@modelcontextprotocol/server-github"],
            },
        },
        "time": {
            "transport": {
                "type": "stdio",
                "command": "uvx",
                "args": ["mcp-server-time", "--local-timezone", "UTC"],
            },
        },
    },
)
def execute(prompt, ctx):
    ...
```

Multiple servers merge tool namespaces. Only `stdio` transport is supported; `sse` is planned.

## Discovering tools

```python
tools = ctx.tools.list()
# list[ToolDefinition]: .name, .description, .input_schema
```

Use when dispatching dynamically or exposing the list to the LLM. For hardcoded workflows, skip `list()` and call by name.

## Calling a tool

```python
from friday_agent_sdk import ToolCallError

try:
    result = ctx.tools.call(
        "get_current_time",
        {"timezone": "America/Los_Angeles"},
    )
    # result: dict (MCP response, already parsed)
except ToolCallError as e:
    return err(f"Tool call failed: {e}")
```

Arguments must match the tool's `input_schema`.

## LLM-driven tool use

Let the LLM pick a tool, execute, loop:

```python
tools = ctx.tools.list()
tool_specs = [
    {"name": t.name, "description": t.description, "input_schema": t.input_schema}
    for t in tools
]

response = ctx.llm.generate(
    messages=[
        {"role": "system", "content": "You have these tools: " + json.dumps(tool_specs)},
        {"role": "user", "content": prompt},
    ],
)
# Parse tool choice from response.text, call ctx.tools.call, loop.
```

No baked-in tool-calling loop — orchestrate it yourself. One or two rounds of (think → call → observe) usually suffice. Stream progress between rounds (`ctx.stream.intent("Calling github:create_issue")`).

## Errors

`ToolCallError` is the only raise from `call()`. Message contains the MCP server's error. Never swallow:

```python
# Bad — hides failures
try:
    result = ctx.tools.call("create_issue", args)
except ToolCallError:
    result = {}

# Good
try:
    result = ctx.tools.call("create_issue", args)
except ToolCallError as e:
    return err(f"GitHub create_issue failed: {e}")
```

## Testing

Mock by passing fake callables to a `Tools` instance directly:

```python
from friday_agent_sdk import AgentContext, ToolCallError
from friday_agent_sdk._types import Tools

def fake_call(name, args_json):
    if name == "get_current_time":
        return '{"time": "2026-01-01T00:00:00Z"}'
    raise ToolCallError(f"unknown tool: {name}")

ctx = AgentContext(tools=Tools(call_tool=fake_call, list_tools=lambda: []))
```

See SDK `tests/test_tools.py` for working examples.
