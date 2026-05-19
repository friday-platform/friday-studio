# Friday Agent Examples

Annotated examples from simplest to most complex. Each demonstrates a different
capability pattern.

## Table of Contents

- [Tier 0: Reading Signal Payloads (HTTP / webhook signal-direct)](#tier-0-reading-signal-payloads)
- [Tier 1: Minimal Agent (echo)](#tier-1-minimal-agent)
- [Tier 2: LLM Generation](#tier-2-llm-generation)
- [Tier 3: HTTP API Integration](#tier-3-http-api-integration)
- [Tier 4: MCP Tools](#tier-4-mcp-tools)
- [Tier 5: Multi-Operation Dispatch](#tier-5-multi-operation-dispatch)
- [Tier 6: Consuming Upstream Step Output (ctx.input)](#tier-6-consuming-upstream-step-output)
- [Patterns Summary](#patterns-summary)

---

## Tier 0: Reading Signal Payloads

When an HTTP signal fires your agent directly (no upstream FSM step,
no `inputFrom`), the request body lands in `ctx.input.config`. This is
the most common case for webhook handlers — Bitbucket / Jira / Stripe /
anything fired through `/hook/raw/{workspaceId}/{signalId}` ends up
here.

**Do NOT use `parse_input(prompt)` for the signal payload** — that
function scrapes JSON out of the enriched prompt string, which holds the
agent's action config (`{config: {prompt, outputTo, ...}}`), not the
webhook body. Reading `prompt` returns top-level key `config` and you
end up parsing the wrong dict.

The right pattern:

```python
from friday_agent_sdk import agent, ok, err, AgentContext, run

@agent(id="echo-webhook", version="1.0.0", description="Echo the webhook body")
def execute(prompt: str, ctx: AgentContext):
    # ctx.input.config: signal payload (auto-seeded from the trigger).
    # Falls back to ctx.input.raw if a different invocation path filled it.
    payload = ctx.input.config or ctx.input.raw
    if not isinstance(payload, dict):
        return err(f"Expected JSON object payload, got {type(payload).__name__}")

    # Now read fields from the actual webhook body.
    summary = f"Got webhook with top-level keys: {list(payload.keys())}"
    return ok({"summary": summary, "payload": payload})


if __name__ == "__main__":
    run()
```

Why both? `ctx.input.config` is the canonical slot for signal-direct
invocations and `inputFrom`-chained steps. `ctx.input.raw` is the
unwrapped root — present when the runtime didn't wrap the payload under
`config`. The `or` covers both safely.

Workspace wiring for this case:

```yaml
signals:
  my-webhook:
    provider: http
    config: { path: /my-webhook }
    schema: { type: object, additionalProperties: true }

jobs:
  handle-webhook:
    triggers: [{ signal: my-webhook }]
    fsm:
      initial: idle
      states:
        idle:
          'on':
            my-webhook: { target: process }
        process:
          entry:
            - type: agent
              agentId: echo-webhook
              outputTo: webhook-result
            - type: emit
              event: DONE
          'on':
            DONE: { target: done }
        done:
          type: final
```

Note the FSM has `initial: idle` (not the agent's state). The signal
triggers a transition from `idle → process`, and the entry action runs
the agent. Using `initial: process` with the agent in entry triggers
"Missing sessionId in signal context" because the runtime hasn't bound
signal context to the initial-state entry actions yet.

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

## Tier 6: Consuming Upstream Step Output

When the action is wired into an FSM with `inputFrom: <doc-id>`, the upstream
step's output arrives in `ctx.input`, NOT in `prompt`. Use `ctx.input.get(...)`
for compact payloads and `ctx.input.artifact_json(...)` when the upstream
producer compacted bulky data into artifact refs.

Workspace wiring (for context — this is what makes `ctx.input` populated):

```yaml
jobs:
  daily-brief:
    fsm:
      initial: idle
      states:
        idle:
          on: { run-brief: { target: fetch } }
        fetch:
          entry:
            - type: agent
              agentId: gmail-fetcher
              outputTo: emails-result
            - type: emit
              event: DONE
          on: { DONE: { target: count } }
        count:
          entry:
            - type: agent
              agentId: email-counter # ← the agent below
              inputFrom: emails-result
          type: final
```

The downstream agent:

```python
from friday_agent_sdk import agent, ok, err, AgentContext, ToolCallError, run

@agent(
    id="email-counter",
    version="1.0.0",
    description="Counts emails from an upstream fetcher and returns top-line stats",
)
def execute(prompt: str, ctx: AgentContext):
    # First try the compact value the producer wrote into outputTo
    payload = ctx.input.get("emails-result")

    # When the producer compacted bulky data into an artifact, hydrate it
    if not isinstance(payload, dict) or "emails" not in payload:
        try:
            payload = ctx.input.artifact_json("emails-result")
        except (ValueError, ToolCallError) as e:
            return err(f"No upstream emails to count: {e}")

    emails = payload.get("emails", []) if isinstance(payload, dict) else []
    return ok({
        "count": len(emails),
        "first_subject": emails[0].get("subject") if emails else None,
    })


if __name__ == "__main__":
    run()
```

Key points:

- `ctx.input.get("doc-id")` returns the upstream step's compact `outputTo`
  payload. The `doc-id` is the upstream `outputTo` value, not a guess.
- `ctx.input.artifact_json("doc-id")` resolves artifact refs the producer
  attached, fetching the underlying JSON through `get_artifact`. Use this
  when the compact payload is a summary + refs rather than the full data.
- An empty `ctx.input` means the action wasn't wired with `inputFrom` — check
  the FSM job, or look in `prompt` if the data was passed on the signal
  payload instead.
- Do NOT ask upstream producers to inline large payloads to avoid `ctx.input`;
  hydrate refs in the consumer instead.

---

## Patterns Summary

| Pattern             | When to use                                  | Key imports                          |
| ------------------- | -------------------------------------------- | ------------------------------------ |
| Echo/passthrough    | Testing, simple transforms                   | `ok, run`                            |
| LLM generation      | Text analysis, classification, summarization | `ok, err, LlmError, run`             |
| HTTP integration    | External API calls                           | `ok, err, HttpError, run`            |
| MCP tools           | Pre-built service integrations               | `ok, err, ToolCallError, run`        |
| Multi-operation     | Agents handling multiple distinct tasks      | `ok, err, parse_operation, run`      |
| Upstream-step input | Agent is wired with `inputFrom: <doc-id>`    | `ctx.input.get / artifact_json`      |
| Structured output   | When you need typed JSON from LLM            | `generate_object` + JSON Schema dict |
| Streaming progress  | Long-running tasks                           | `ctx.stream.progress()`              |
