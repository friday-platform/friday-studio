# MCP tools

MCP (Model Context Protocol) reaches external systems — GitHub, Postgres, Gmail, etc. Call tools through `ctx.tools`.

## Contents

- Workspace MCP vs decorator MCP — which to use
- Declaring additional servers — decorator shape
- Discovering tools — `ctx.tools.list()` returns definitions
- Calling a tool — `ctx.tools.call(name, input)`
- LLM-driven tool use — loop pattern with `response.text` parsing
- Errors — don't swallow; let the runtime surface them
- Testing — mocking `ctx.tools` in unit tests

## Workspace MCP vs decorator MCP

**User Python agents automatically inherit all MCP servers enabled in the workspace's `tools.mcp.servers`.** You do NOT need to declare them again in `@agent(mcp={...})`. The runtime merges workspace MCP + agent-declared MCP before passing them to `ctx.tools`.

```python
# Workspace has google-gmail in tools.mcp.servers — just call it directly:
@agent(id="inbox-agent", version="1.0.0", description="...")
def execute(prompt: str, ctx: AgentContext):
    result = ctx.tools.call("search_gmail_messages", {"query": "is:unread"})
    return ok({"emails": result})
```

Use `@agent(mcp={...})` only when:
- The server is **not** in the workspace `tools.mcp.servers`
- You need a server-specific override for this agent only

**Discovering tool names:** Use `list_mcp_tools({ serverId: "google-gmail" })` in chat to discover tool names. It returns prefixed names like `google-gmail/search_gmail_messages` — that prefix belongs in a `type: llm` agent's `config.tools` array, not in Python code. Strip the `{serverId}/` prefix when writing `ctx.tools.call(...)`: the Python agent always uses the bare name: `ctx.tools.call("search_gmail_messages", ...)`. At runtime, `ctx.tools.list()` also returns bare unprefixed names.

## Declaring additional servers

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
except ToolCallError as e:
    return err(f"Tool call failed: {e}")
```

Arguments must match the tool's `input_schema`.

**Return value format.** `ctx.tools.call()` returns the raw MCP content envelope — a dict, not a string:

```python
{"content": [{"type": "text", "text": "Message ID: abc123\nSubject: ..."}]}
```

Extract the text explicitly — never pass the dict to regex or string methods:

```python
def _get_text(result: dict) -> str:
    for item in result.get("content", []):
        if isinstance(item, dict) and item.get("type") == "text":
            return item.get("text", "")
    return ""
```

The text content format is server-defined — don't assume separators or structure. Probe the actual output (or check the MCP server source) before writing a parser against it.

**`isError` flag.** MCP servers return auth failures and other errors as a successful dict with `isError: True`:

```python
{"isError": True, "content": [{"type": "text", "text": "Error: 401 Unauthorized"}]}
```

This is **NOT** raised as `ToolCallError` — it comes back as a normal return value. Always check before using the result:

```python
result = ctx.tools.call("search_gmail_messages", {"query": "is:unread"})
if result.get("isError"):
    return err(f"Gmail error: {_get_text(result)}")
text = _get_text(result)
```

`ToolCallError` is raised only for daemon-level failures: unknown session, NATS timeout, or explicit `{"error": "..."}` responses from the runtime.

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
