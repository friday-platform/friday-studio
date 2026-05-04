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
vendored-from: friday-platform/agent-sdk@a10ca4ef6fd8af3f716ad29a9723425d7505477f
vendored-path: packages/python/skills/writing-friday-python-agents/
vendored-version: 0.1.5
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

| Capability  | Access        | What it does                                              |
| ----------- | ------------- | --------------------------------------------------------- |
| LLM         | `ctx.llm`     | Generate text or structured objects via host LLM registry |
| HTTP        | `ctx.http`    | Make outbound HTTP requests (TLS handled by host)         |
| MCP Tools   | `ctx.tools`   | Call MCP server tools (GitHub, Jira, databases, etc.)     |
| Streaming   | `ctx.stream`  | Emit progress/intent events to the UI                     |
| Environment | `ctx.env`     | Read environment variables (API keys, config)             |
| Config      | `ctx.config`  | Agent-specific configuration from workspace               |
| Session     | `ctx.session` | Session metadata (id, workspace_id, user_id, datetime)    |

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

### Memory — `memory_save` / `memory_read` (platform tools)

The host injects platform memory tools into every agent's tool surface
automatically — no MCP declaration needed. Most-used:

```python
# Append a single fact. The store handles persistence + ordering.
# `why` is required — articulate which future request benefits.
ctx.tools.call("memory_save", {
    "memoryName": "preferences",
    "text": "Always archive newsletters from substack.com",
    "why": "future newsletter-handling decisions skip the prompt + use this rule",
})

# Read recent entries. (The 20 most recent narrative entries are
# auto-injected into the LLM-side prompt every turn — Python agents
# don't see those, so call memory_read explicitly when you need
# durable state across runs.)
result = ctx.tools.call("memory_read", {
    "memoryName": "preferences",
    "limit": 50,
})
```

**Append semantics — one call per fact, never read-concat-write.**

```python
# ✅ Correct — one fact per call. Concurrent writers compose cleanly.
for fact, reason in new_preferences:
    ctx.tools.call("memory_save", {
        "memoryName": "preferences", "text": fact, "why": reason,
    })

# ❌ Wrong — read-concat-write. Concurrent writers clobber each other,
#    fights the platform's append/dedup logic, and the next run starts
#    from a stale snapshot.
existing = ctx.tools.call("memory_read", {"memoryName": "preferences"})
combined = existing["text"] + "\n" + "\n".join(p[0] for p in new_preferences)
ctx.tools.call("memory_save", {
    "memoryName": "preferences", "text": combined, "why": "rollup",
})
```

**Footgun: `ToolCallError` on validation failure.** `ctx.tools.call`
raises if the store isn't declared in `workspace.yml`, if the entry
exceeds size limits, or if the host rejects the write. Never swallow
with bare `except Exception` — that silently drops writes. Surface
the error through `err()` or let it propagate.

```python
from friday_agent_sdk import ToolCallError

try:
    ctx.tools.call("memory_save", {
        "memoryName": "preferences", "text": fact, "why": "user just stated this preference",
    })
except ToolCallError as e:
    return err(f"memory_save failed: {e}")
```

**Stores must use the `narrative` strategy.** Friday's runtime today
only implements narrative storage; stores declared with other strategies
(`retrieval`, `dedup`, `kv`) exist in the schema but throw at write time.
If you're authoring a workspace, just use narrative.

### ctx.stream — Progress Events

```python
ctx.stream.progress("Analyzing document...", tool_name="analysis")
ctx.stream.intent("Switching to code review phase")
ctx.stream.emit("custom-event", {"key": "value"})  # raw event
```

Emit progress _before_ expensive operations so the UI shows what's happening.

## Structured Input Handling

Friday sends "enriched prompts" — markdown with embedded JSON containing task
details, signal data, and context. Code agents need to extract structured data
from these.

### parse_input — Simple extraction

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
- `ctx.tools.call()` instead of direct API calls — MCP servers run centrally
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

## Getting Agents Into Friday

### Register via the daemon HTTP API

Register your agent by POSTing the entrypoint's absolute path to the daemon:

```bash
curl -X POST http://localhost:8080/api/agents/register \
  -H 'Content-Type: application/json' \
  -d '{"entrypoint": "/abs/path/to/your-agent/agent.py"}'
```

`entrypoint` must be an absolute path. The daemon spawns it with
`FRIDAY_VALIDATE_ID`, collects metadata over NATS, copies the source directory
into the agents registry (under `{FRIDAY_HOME}/agents/{id}@{version}/` — the
home dir is mid-migration from `~/.atlas` to `~/.friday/local`), and reloads
the registry. No compilation step — the agent process is spawned per
invocation and communicates with the host via NATS request/reply.

The register response returns `agent.path` (the install dir). To look up the
source path of an existing agent, query `GET /api/agents/:id` and read
`sourceLocation` rather than constructing the path from a constant.

The Friday daemon listens on `localhost:8080` by default (configurable via
the `FRIDAY_PORT` env var or the `--port` flag if you started the daemon
manually).

### Test directly

Execute an agent without going through the full FSM pipeline. Replace
`my-agent` with your agent id (the `id=` value from the `@agent` decorator):

```bash
curl -s -X POST "http://localhost:8080/api/agents/my-agent/run?workspaceId=user" \
  -H 'Content-Type: application/json' \
  -d '{"input": "test prompt"}'
```

Or via the playground API on `localhost:5200`:

```bash
curl -s -X POST http://localhost:5200/api/agents/my-agent/run \
  -H 'Content-Type: application/json' \
  -d '{"input": "test prompt"}'
```

### Workspace Configuration

Register your agent in `workspace.yml`:

```yaml
agents:
  - id: my-agent
    type: user
```

Friday adds the `user:` prefix automatically — you specify `my-agent`,
Friday resolves it to `user:my-agent`.

## Casing Convention

This is a subtle but real source of bugs:

- **Decorator kwargs**: `snake_case` (Pythonic) — `display_name`, `input_schema`, `use_workspace_skills`
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
