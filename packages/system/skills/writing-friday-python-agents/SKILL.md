---
name: writing-friday-python-agents
description: >
  Authoring guide for Python user agents (type:"user") on the Friday
  platform via the friday-agent-sdk. Covers the @agent decorator,
  AgentContext capabilities (ctx.llm, ctx.http, ctx.tools, ctx.stream),
  structured input parsing, result types, and the NATS subprocess
  execution model. Load when an agent.py exists in scope, when imports
  from friday_agent_sdk are present, when an @agent decorator is being
  authored or modified, or when upsert_agent was just called with
  type:user. Do NOT load to decide whether to author a user agent —
  that decision belongs in the workspace-chat agent_types rules.
vendored-from: friday-platform/agent-sdk@832d539ded2c87d1a2c4ee91a2cfc8407b68eb74
vendored-path: packages/python/skills/writing-friday-python-agents/
vendored-version: 0.1.9
---

<!--
  This skill is vendored from the friday-agent-sdk repo. Edits should land
  upstream first; scripts/sync-sdk-skill.ts re-vendors for the pinned
  FRIDAY_AGENT_SDK_VERSION (see tools/friday-launcher/paths.go).
-->

# Writing Friday Python Agents

Friday agents are single-file Python modules that the platform spawns as native
subprocesses and communicates with via NATS. The SDK is a normal Python package
installed into your environment. There are no compile-time or WASM steps.

The mental model: your Python code runs as a normal process. All I/O that crosses
network boundaries or needs credentials routes through **host capabilities** the
platform provides — LLM generation, HTTP requests, MCP tools, and progress
streaming. You declare what you need in the `@agent` decorator, and the platform
wires it up at execution time via `AgentContext`.

## Every Agent Looks Like This

```python
from friday_agent_sdk import agent, ok, AgentContext, run

@agent(
    id="my-agent",
    version="1.0.0",
    description="What this agent does — the planner reads this to decide when to invoke it",
)
def execute(prompt: str, ctx: AgentContext):
    # Your logic here
    return ok({"result": "data"})

if __name__ == "__main__":
    run()
```

Three things are non-negotiable:

1. **The `@agent` decorator** with at least `id`, `version`, `description`.
2. **`run()` in `__main__`** — this is the NATS entry point. Without it, the
   process spawns and immediately exits. `run()` checks `FRIDAY_VALIDATE_ID`
   (registration) or `FRIDAY_SESSION_ID` (execution), connects to NATS, and
   handles the protocol.
3. **Return `ok()` or `err()`** — never return raw dicts/strings.

## Capabilities Quick Reference

All capabilities live on `AgentContext` and are always initialized. They may be
stubs in test contexts, but never `None`.

| Capability  | Access        | What it does                                                                      |
| ----------- | ------------- | --------------------------------------------------------------------------------- |
| LLM         | `ctx.llm`     | Generate text or structured objects via host LLM registry                         |
| HTTP        | `ctx.http`    | Make outbound HTTP requests (TLS handled by host)                                 |
| MCP Tools   | `ctx.tools`   | Call MCP server tools (GitHub, Jira, databases, etc.)                             |
| Input       | `ctx.input`   | Read `inputFrom` upstream-step docs (NOT the signal payload — that's in `prompt`) |
| Streaming   | `ctx.stream`  | Emit progress/intent events to the UI                                             |
| Environment | `ctx.env`     | Read environment variables (API keys, config)                                     |
| Config      | `ctx.config`  | Agent-specific configuration from workspace                                       |
| Session     | `ctx.session` | Session metadata (id, workspace_id, user_id, datetime)                            |

### ctx.llm — LLM Generation

```python
# Text generation
response = ctx.llm.generate(
    messages=[{"role": "user", "content": "Summarize this document"}],
    model="anthropic:claude-sonnet-4-6",  # fully qualified
)
print(response.text)  # str

# Structured output — returns response.object (dict), response.text is None
response = ctx.llm.generate_object(
    messages=[{"role": "user", "content": "Extract key facts"}],
    schema={"type": "object", "properties": {"facts": {"type": "array", "items": {"type": "string"}}}},
    model="anthropic:claude-haiku-4-5",
)
print(response.object)  # dict matching schema
```

Pass a fully qualified model like `anthropic:claude-sonnet-4-6`, or set defaults
in the `llm` decorator param and omit the per-call `model`.

Optional params: `max_tokens`, `temperature`, `provider_options` (dict).

### ctx.http — Outbound HTTP

```python
response = ctx.http.fetch(
    "https://api.example.com/data",
    method="POST",
    headers={"Authorization": f"Bearer {ctx.env['API_KEY']}"},
    body='{"query": "test"}',
    timeout_ms=30000,
)
data = response.json()  # convenience method
# response.status (int), response.headers (dict), response.body (str)
```

The host handles TLS, audit logging, and rate limits. 5MB response body limit.
Note: HTTP status errors (4xx, 5xx) don't raise — check `response.status` manually.

### ctx.tools — MCP Tools

Declare MCP servers in the decorator, then call tools at runtime:

```python
@agent(
    id="my-agent", version="1.0.0", description="...",
    mcp={
        "github": {
            "transport": {
                "type": "stdio",
                "command": "npx",
                "args": ["-y", "@modelcontextprotocol/server-github"],
                "env": {"GITHUB_TOKEN": "{{env.GITHUB_TOKEN}}"}
            }
        }
    },
)
def execute(prompt: str, ctx: AgentContext):
    available = ctx.tools.list()  # list[ToolDefinition] — name, description, input_schema
    result = ctx.tools.call("create_issue", {"title": "Bug", "repo": "owner/repo"})
```

`{{env.VARIABLE}}` in MCP config references agent environment variables.
Currently only `stdio` transport is supported.

**Do not bypass `ctx.tools`.** Python agents must not call local MCP HTTP endpoints such as `http://localhost:8002/mcp`, hardcode bearer tokens, or guess provider-specific tool names. Use `ctx.tools.list()` to inspect the runtime tool surface and `ctx.tools.call(name, args)` to invoke it. Host-side tool calls are credentialed, audited, and recorded in session history; direct HTTP calls are invisible to Friday and commonly fail with unknown-tool or invalid-token errors.

If `ctx.tools.call` raises `ToolCallError("Unknown tool ...")`, list tools and fix the workspace/agent config rather than retrying a guessed name.

### Platform-injected tools

The host may inject additional tools into `ctx.tools` beyond what you declared
in `mcp={...}` — workflows like human-input elicitations, memory writes,
artifact handling. These are platform features, not SDK features; their names,
arg shapes, and semantics belong to whichever platform you're running on. Call
`ctx.tools.list()` at runtime to see what's actually available, and consult the
platform's own docs for which tools to call. The SDK contract is just
`ctx.tools.call(name, args) -> dict` and `ToolCallError` on failure.

### ctx.stream — Progress Events

```python
ctx.stream.progress("Analyzing document...", tool_name="analysis")
ctx.stream.intent("Switching to code review phase")
ctx.stream.emit("custom-event", {"key": "value"})  # raw event
```

Emit progress _before_ expensive operations so the UI shows what's happening.

## Structured Input Handling

A `type: user` agent receives input through one of two channels. Pick by how
the job is wired, not by preference:

| Channel              | Where it arrives | Read with                  | Use for                                          |
| -------------------- | ---------------- | -------------------------- | ------------------------------------------------ |
| Signal payload       | `prompt` string  | `parse_input(prompt, ...)` | Fields the trigger signal was fired with         |
| Upstream step output | `ctx.input`      | `ctx.input.get("doc-id")`  | `outputTo`/`inputFrom` handoff from a prior step |

`ctx.input` does NOT carry the signal payload — a job triggered by a signal
with no upstream producer has an empty `ctx.input`. If you guessed a key for
`ctx.input.get(...)` and got nothing back, you almost certainly wanted the
signal payload — read `prompt` with `parse_input` instead.

### ctx.input — Upstream step output

When the action declares `inputFrom`, use `ctx.input` rather than scraping the
prompt. Producers may compact bulky outputs into summary + artifact refs;
downstream agents dereference those refs through host capabilities instead of
asking the producer to inline large payloads.

```python
# Compact value (whatever the upstream step put in its outputTo doc)
payload = ctx.input.get("emails-result")

# Or, when the doc carries artifact refs, hydrate the JSON contents
payload = ctx.input.artifact_json("emails-result")
emails = payload.get("emails", [])
return ok({"count": len(emails)})
```

Useful methods (all take an optional `doc-id`; omit it to operate on the full
raw input):

- `ctx.input.get(name, default=None)` — compact input payload for an `inputFrom` document.
- `ctx.input.require(name)` — same, but raises `ValueError` if missing.
- `ctx.input.artifact_refs(name)` — artifact refs attached to the input.
- `ctx.input.artifact_json(name)` — fetch via `get_artifact` and parse JSON contents.

`prompt` still exists for natural-language task instructions and backwards
compatibility, but `parse_input(prompt)` is not the right abstraction for
multi-step `outputTo`/`inputFrom` handoffs.

### parse_input — Signal-payload extraction

```python
from friday_agent_sdk import parse_input

# Raw dict extraction
data = parse_input(prompt)  # returns dict

# Typed extraction with a dataclass schema
@dataclass
class TaskConfig:
    url: str
    max_retries: int = 3

config = parse_input(prompt, TaskConfig)  # returns TaskConfig instance
```

Extraction strategy (3-level fallback):

1. Balanced-brace JSON scan (handles nested objects)
2. Code-fenced ` ```json ` blocks
3. Entire prompt as JSON

Unknown keys are automatically filtered when using a dataclass schema.

### parse_operation — Discriminated dispatch

For agents that handle multiple operation types:

```python
from friday_agent_sdk import parse_operation
from dataclasses import dataclass

@dataclass
class ViewConfig:
    operation: str
    item_id: str

@dataclass
class SearchConfig:
    operation: str
    query: str
    max_results: int = 50

OPERATIONS = {
    "view": ViewConfig,
    "search": SearchConfig,
}

config = parse_operation(prompt, OPERATIONS)  # dispatches on "operation" field

match config.operation:
    case "view": return handle_view(config, ctx)
    case "search": return handle_search(config, ctx)
```

## Result Types

Always return `ok()` or `err()`. Never return raw values.

```python
from friday_agent_sdk import ok, err

# Simple success
return ok({"status": "done", "count": 42})

# Error
return err("Jira API returned 403: insufficient permissions")
```

`ok()` accepts any JSON-serializable data: dicts, lists, strings, dataclass
instances (auto-converted via `dataclasses.asdict`).

## The Execution Model — What You Cannot Do (And Why)

Your agent runs as a normal Python subprocess, so the standard library and most
installed packages work. The constraint is not a sandbox — it's that I/O should
route through host capabilities so the platform manages credentials, rate limits,
and audit logging centrally.

**Recommended — use host capabilities for I/O:**

- `ctx.http.fetch()` instead of `requests`/`httpx` — host manages TLS, logging, limits
- `ctx.llm.generate()` instead of `anthropic`/`openai` — host manages API keys, routing
- `ctx.tools.list()` + `ctx.tools.call()` instead of direct API/MCP HTTP calls — MCP servers run centrally and calls remain observable
- `ctx.stream.progress()` instead of `print()` — UI integration, not stdout
- `ctx.env` instead of `os.environ` — only declared variables are injected

**Available — Python standard library and installed packages:**

- `json`, `re`, `base64`, `urllib.parse`, `dataclasses`
- `collections`, `itertools`, `functools`, `typing`
- `math`, `datetime`, `uuid`, `hashlib`
- `pydantic` if installed, `numpy` if installed, etc.

When in doubt: if the operation touches a network boundary or needs credentials,
use the host capability. If it's pure data manipulation, standard library or
installed packages are fine.

## Getting Agents Into a Workspace

The SDK's job ends at the file: a registered `@agent` function plus
`run()` in `__main__`. How that file becomes a usable agent on the host
is a platform concern (Friday Studio's CLI, an in-tree dev daemon, a
deployment pipeline) — see your platform's docs for the registration
command, and do not have the agent code shell out to a daemon to
register itself.

Once the platform knows about it, reference it in `workspace.yml`:

```yaml
agents:
  - id: my-agent
    type: user
```

The `id` matches the `id=` value from the `@agent` decorator. The host
resolves `type: user` to the registered Python agent and routes
invocations into your `execute` function over NATS.

The agent process is spawned per invocation by the host; it sets
`FRIDAY_VALIDATE_ID` (registration) or `FRIDAY_SESSION_ID` (execution)
plus `NATS_URL`, and `run()` handles the rest. Your code should not
open its own NATS connection.

## Casing Convention

This is a subtle but real source of bugs:

- **Decorator kwargs**: `snake_case` (Pythonic) — `display_name`, `use_workspace_skills`
- **Dict values inside decorator**: `camelCase` (matches host Zod schemas) — `linkRef`, `displayName` inside environment dicts
- **MCP config keys**: `camelCase` in transport config
- **Result data**: your choice, but `snake_case` is conventional for Python agents

The bridge layer (`_bridge.py`) handles converting decorator metadata to
camelCase for the host automatically. You don't need to worry about the boundary
— just follow the convention above.

## References

For deeper dives, read these reference files:

- **`references/api.md`** — Complete API reference: every decorator param, every
  context field, every method signature and return type
- **`references/examples.md`** — Annotated example agents from simple (echo) to
  complex (Jira multi-operation, GitHub PR operations)
- **`references/constraints.md`** — Full list of constraints, casing rules,
  build pipeline details, and common mistakes with fixes
