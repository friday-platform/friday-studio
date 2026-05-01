# Friday Agent Examples

Annotated examples from simplest to most complex. Each demonstrates a different
capability pattern.

## Table of Contents

- [Tier 1: Minimal Agent (echo)](#tier-1-minimal-agent)
- [Tier 2: LLM Generation](#tier-2-llm-generation)
- [Tier 3: HTTP API Integration](#tier-3-http-api-integration)
- [Tier 4: MCP Tools](#tier-4-mcp-tools)
- [Tier 5: Multi-Operation Dispatch](#tier-5-multi-operation-dispatch)
- [Patterns Summary](#patterns-summary)

---

## Tier 1: Minimal Agent

The absolute minimum. No capabilities, just echoes input.

```python
from friday_agent_sdk import agent, ok, run

@agent(id="echo", version="1.0.0", description="Echoes input")
def execute(prompt, ctx):
    return ok(prompt)


if __name__ == "__main__":
    run()
```

Key points:

- `run()` in `__main__` is the entry point — without it, the agent exits immediately
- `prompt` and `ctx` don't need type annotations (but they help)
- `ok()` wraps any serializable value

---

## Tier 2: LLM Generation

Text analysis agent using structured output.

```python
from friday_agent_sdk import agent, ok, err, AgentContext, LlmError, run

OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"},
        "key_points": {"type": "array", "items": {"type": "string"}},
        "sentiment": {"type": "string", "enum": ["positive", "negative", "neutral"]},
    },
    "required": ["summary", "key_points", "sentiment"],
}

@agent(
    id="text-analyzer",
    version="1.0.0",
    description="Analyzes text and returns structured summary, key points, and sentiment",
    llm={"provider": "anthropic", "model": "claude-haiku-4-5"},
)
def execute(prompt: str, ctx: AgentContext):
    try:
        result = ctx.llm.generate_object(
            messages=[
                {"role": "user", "content": f"Analyze the following text:\n\n{prompt}"}
            ],
            schema=OUTPUT_SCHEMA,
        )
        return ok(result.object)
    except LlmError as e:
        return err(f"LLM generation failed: {e}")


if __name__ == "__main__":
    run()
```

Key points:

- JSON Schema dict for `generate_object` (not a dataclass — that's for `parse_input`)
- `llm` in decorator sets default provider/model — no per-call `model` needed
- Error handling wraps LLM calls

---

## Tier 3: HTTP API Integration

Agent that calls an external API using environment variables for auth.

```python
import json
import base64
from friday_agent_sdk import agent, ok, err, AgentContext, HttpError, run

@agent(
    id="weather-check",
    version="1.0.0",
    description="Checks weather for a given city using OpenWeatherMap API",
    environment={
        "required": [
            {"name": "WEATHER_API_KEY", "description": "OpenWeatherMap API key"}
        ]
    },
)
def execute(prompt: str, ctx: AgentContext):
    api_key = ctx.env.get("WEATHER_API_KEY", "")
    if not api_key:
        return err("WEATHER_API_KEY not configured")

    city = prompt.strip()

    try:
        response = ctx.http.fetch(
            f"https://api.openweathermap.org/data/2.5/weather?q={city}&appid={api_key}&units=metric",
        )
    except HttpError as e:
        return err(f"Network error: {e}")

    if response.status >= 400:
        return err(f"Weather API error {response.status}: {response.body[:200]}")

    data = response.json()
    return ok({
        "city": data.get("name"),
        "temperature": data.get("main", {}).get("temp"),
        "description": data.get("weather", [{}])[0].get("description"),
        "humidity": data.get("main", {}).get("humidity"),
    })


if __name__ == "__main__":
    run()
```

Key points:

- `environment` declares required env vars — platform prompts user to configure
- `ctx.env` reads them at runtime
- Network errors raise `HttpError`; HTTP status errors don't — check `response.status`
- `response.json()` is a convenience for `json.loads(response.body)`

---

## Tier 4: MCP Tools

Agent that uses an MCP server to interact with external services.

```python
from friday_agent_sdk import agent, ok, err, AgentContext, ToolCallError, run

@agent(
    id="time-agent",
    version="1.0.0",
    description="Gets current time in any timezone using MCP time server",
    mcp={
        "time": {
            "transport": {
                "type": "stdio",
                "command": "uvx",
                "args": ["mcp-server-time", "--local-timezone", "UTC"],
            }
        }
    },
)
def execute(prompt: str, ctx: AgentContext):
    # List available tools to understand what's available
    tools = ctx.tools.list()
    tool_names = [t.name for t in tools]

    if "get_current_time" not in tool_names:
        return err(f"get_current_time not found. Available: {tool_names}")

    try:
        result = ctx.tools.call("get_current_time", {"timezone": prompt.strip() or "UTC"})
        return ok({"time_result": result})
    except ToolCallError as e:
        return err(f"Tool call failed: {e}")


if __name__ == "__main__":
    run()
```

Key points:

- MCP servers declared in decorator `mcp` param
- `{{env.VAR}}` syntax for passing env vars to MCP server processes
- `ctx.tools.list()` returns `ToolDefinition` objects for discovery
- `ctx.tools.call(name, args_dict)` invokes a tool and returns a dict

---

## Tier 5: Multi-Operation Dispatch

Agent that handles multiple operation types via discriminated dataclass schemas.
This is the pattern used by the Jira and GitHub agents.

```python
import json
from dataclasses import dataclass
from friday_agent_sdk import agent, ok, err, parse_operation, AgentContext, run


@dataclass
class ViewConfig:
    operation: str
    item_id: str

@dataclass
class SearchConfig:
    operation: str
    query: str
    max_results: int = 50

@dataclass
class CreateConfig:
    operation: str
    title: str
    description: str | None = None
    labels: list[str] | None = None

OPERATIONS: dict[str, type] = {
    "view": ViewConfig,
    "search": SearchConfig,
    "create": CreateConfig,
}


def _handle_view(config: ViewConfig, ctx: AgentContext):
    response = ctx.http.fetch(
        f"https://api.example.com/items/{config.item_id}",
        headers={"Authorization": f"Bearer {ctx.env['API_TOKEN']}"},
    )
    if response.status >= 400:
        return err(f"API error {response.status}: {response.body[:500]}")
    return ok({"operation": "view", "success": True, "data": response.json()})


def _handle_search(config: SearchConfig, ctx: AgentContext):
    response = ctx.http.fetch(
        "https://api.example.com/search",
        method="POST",
        headers={
            "Authorization": f"Bearer {ctx.env['API_TOKEN']}",
            "Content-Type": "application/json",
        },
        body=json.dumps({"q": config.query, "limit": min(config.max_results, 100)}),
    )
    if response.status >= 400:
        return err(f"API error {response.status}: {response.body[:500]}")
    return ok({"operation": "search", "success": True, "data": response.json()})


def _handle_create(config: CreateConfig, ctx: AgentContext):
    payload = {"title": config.title}
    if config.description:
        payload["description"] = config.description
    if config.labels:
        payload["labels"] = config.labels

    response = ctx.http.fetch(
        "https://api.example.com/items",
        method="POST",
        headers={
            "Authorization": f"Bearer {ctx.env['API_TOKEN']}",
            "Content-Type": "application/json",
        },
        body=json.dumps(payload),
    )
    if response.status >= 400:
        return err(f"API error {response.status}: {response.body[:500]}")
    return ok({"operation": "create", "success": True, "data": response.json()})


@agent(
    id="item-manager",
    version="1.0.0",
    description="Manages items via REST API — view, search, and create operations",
    environment={
        "required": [{"name": "API_TOKEN", "description": "API authentication token"}]
    },
)
def execute(prompt: str, ctx: AgentContext):
    try:
        config = parse_operation(prompt, OPERATIONS)
    except ValueError as e:
        return err(str(e))

    match config.operation:
        case "view": return _handle_view(config, ctx)
        case "search": return _handle_search(config, ctx)
        case "create": return _handle_create(config, ctx)


if __name__ == "__main__":
    run()
```

Key points:

- Dataclasses define operation schemas — each must have an `operation: str` field
- `parse_operation` finds JSON with `"operation"` field and dispatches to matching schema
- `match` statement for clean dispatch
- Each handler returns `ok()` or `err()` for consistent shape
- Operation response includes `"operation"` and `"success"` fields by convention

---

## Patterns Summary

| Pattern            | When to use                                  | Key imports                          |
| ------------------ | -------------------------------------------- | ------------------------------------ |
| Echo/passthrough   | Testing, simple transforms                   | `ok, run`                            |
| LLM generation     | Text analysis, classification, summarization | `ok, err, LlmError, run`             |
| HTTP integration   | External API calls                           | `ok, err, HttpError, run`            |
| MCP tools          | Pre-built service integrations               | `ok, err, ToolCallError, run`        |
| Multi-operation    | Agents handling multiple distinct tasks      | `ok, err, parse_operation, run`      |
| Structured output  | When you need typed JSON from LLM            | `generate_object` + JSON Schema dict |
| Streaming progress | Long-running tasks                           | `ctx.stream.progress()`              |
