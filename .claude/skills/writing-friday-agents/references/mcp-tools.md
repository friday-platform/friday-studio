# MCP tools

MCP (Model Context Protocol) reaches external systems — GitHub, Postgres, Notion, time, etc. Declare servers in the decorator; call tools through `ctx.tools`.

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

Mock by passing a fake `call_tool` / `list_tools` to a `Tools` instance. See SDK `tests/test_tools.py` — it mocks the WIT functions (not the wrapper) and uses a dataclass mimicking componentize-py's `_Err` for failures.
