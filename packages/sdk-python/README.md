# friday-agent-sdk

Python SDK for authoring Friday WASM agents. Write a decorated function, compile
to WASM, run on the Friday runtime with host-provided capabilities.

## Quick Start

```python
from friday_agent_sdk import agent, ok, err

@agent(id="my-agent", version="1.0.0", description="Does a thing")
def execute(prompt, ctx):
    result = ctx.llm.generate(
        model="anthropic:claude-haiku-4-5",
        messages=[{"role": "user", "content": prompt}],
    )
    return ok({"answer": result.text})
```

Build and install:

```bash
atlas agent build ./my-agent
```

That's it. The agent is now discoverable by the Friday runtime.

## API

### `@agent` Decorator

Registers a handler function with metadata. One agent per module.

```python
@agent(
    id="slack-poster",                    # Required. Stable kebab-case identifier.
    version="1.0.0",                      # Required. Semver.
    description="Posts to Slack via MCP",  # Required. What the agent does.
    display_name="Slack Poster",          # Optional. Human-readable name.
    summary="Post messages to Slack",     # Optional. Short one-liner.
    constraints="Requires Slack token",   # Optional. Usage constraints.
    examples=[                            # Optional. For planner discovery.
        "Post to #general: shipping v2",
        "DM @alice: build is green",
    ],
    input_schema=MyDataclass,             # Optional. Dataclass for typed input.
    output_schema=MyOutput,               # Optional. Dataclass for typed output.
    environment={...},                    # Optional. Env var declarations (camelCase dicts).
    mcp={...},                            # Optional. MCP server declarations (camelCase dicts).
    llm={"provider": "anthropic"},        # Optional. Default LLM config.
)
def execute(prompt, ctx):
    ...
```

Top-level kwargs use `snake_case` (Pythonic). Nested dict values use `camelCase`
(matching the host-side Zod schemas).

### Result Helpers

Tagged union return types. An agent handler must return `ok()` or `err()`.

```python
from friday_agent_sdk import ok, err

# Success — data is serialized to JSON automatically
ok({"key": "value"})           # dict
ok(MyDataclass(field="val"))   # dataclass → dataclasses.asdict()
ok("plain string")             # string passthrough

# Error
err("something went wrong")
```

### Context Object

The `ctx` argument provides access to host capabilities and execution data.

```python
ctx.tools     # Tools | None    — MCP tool invocation
ctx.llm       # Llm | None      — LLM generation via host
ctx.http      # Http | None     — Outbound HTTP via host
ctx.env       # dict[str, str]  — Environment variables
ctx.config    # dict            — Agent config from workspace.yml
ctx.session   # SessionData     — id, workspace_id, user_id, datetime
ctx.output_schema  # dict | None — JSON Schema for structured output
```

### `ctx.tools` — MCP Tools

```python
# Call a tool. Returns a dict. Raises ToolCallError on failure.
result = ctx.tools.call("slack_post_message", {"channel": "#ops", "text": "hi"})

# List available tools.
tools = ctx.tools.list()  # list[ToolDefinition]
for t in tools:
    print(t.name, t.description)
```

### `ctx.llm` — LLM Generation

Call LLMs through the host's `@atlas/llm` registry. The agent never touches
HTTP or API keys — the host handles networking.

```python
# Text generation
response = ctx.llm.generate(
    model="anthropic:claude-haiku-4-5",
    messages=[{"role": "user", "content": "summarize this"}],
    max_tokens=500,
    temperature=0.3,
)
print(response.text)    # generated text
print(response.model)   # actual model used
print(response.usage)   # {"prompt_tokens": N, "completion_tokens": N}

# Structured output — returns response.object instead of response.text
response = ctx.llm.generate_object(
    model="anthropic:claude-haiku-4-5",
    messages=[{"role": "user", "content": "extract entities"}],
    schema={"type": "object", "properties": {"names": {"type": "array", "items": {"type": "string"}}}},
)
print(response.object)  # {"names": ["Alice", "Bob"]}
```

Model can be fully qualified (`"anthropic:claude-haiku-4-5"`) or bare
(`"claude-haiku-4-5"`) when the decorator sets `llm={"provider": "anthropic"}`.

### `ctx.http` — Outbound HTTP

Make HTTP requests through the host. The WASM sandbox has no network access —
this is the only way out.

```python
response = ctx.http.fetch(
    "https://api.example.com/data",
    method="GET",
    headers={"Authorization": f"Bearer {ctx.env['API_KEY']}"},
    timeout_ms=10000,
)
print(response.status)   # 200
print(response.body)     # raw string
data = response.json()   # parsed JSON (convenience method)
```

5MB response body limit. 30-second default timeout.

### Error Types

Each host capability has a typed exception:

```python
from friday_agent_sdk import ToolCallError, LlmError, HttpError

try:
    ctx.tools.call("maybe_broken", {})
except ToolCallError as e:
    return err(f"tool failed: {e}")

try:
    ctx.llm.generate(messages=[...], model="bad-model")
except LlmError as e:
    return err(f"LLM failed: {e}")

try:
    ctx.http.fetch("https://down.example.com")
except HttpError as e:
    return err(f"HTTP failed: {e}")
```

Uncaught exceptions are caught by the bridge and returned as `err()` results.
The agent never crashes the runtime.

## Architecture

### What Runs Where

The SDK is pure Python with zero dependencies. It runs inside a WASM sandbox.
The host runtime (TypeScript/Deno) provides all I/O through six capabilities.

```
┌─────────────────────────────────────────────────────┐
│ WASM Sandbox                                        │
│                                                     │
│  @agent handler ──→ SDK wrappers ──→ WIT boundary ──┼──→ Host Runtime
│  (your code)        (json plumbing)   (JSPI bridge) │    (real I/O)
│                                                     │
│  Pure Python only. No networking. No native deps.   │
└─────────────────────────────────────────────────────┘
```

| Runs inside WASM (Python) | Runs on host (TypeScript) |
|---|---|
| Your handler function | MCP tool invocation |
| JSON serialize/deserialize | LLM inference (@atlas/llm) |
| Dataclass construction | Outbound HTTP (fetch) |
| Error type mapping | Zod input validation |
| Result variant dispatch | Stream event routing |
| | Structured logging |

### SDK Runtime Responsibilities

The SDK does three things at runtime:

1. **Dispatch.** The bridge (`_bridge.py`) is the WASM entry point. It pulls
   the handler from the module-level registry, deserializes the context JSON,
   calls the handler, and maps `OkResult`/`ErrResult` to the WIT variant.

2. **JSON plumbing.** Each capability wrapper (`Tools`, `Llm`, `Http`)
   serializes Python dicts to JSON strings on the way out and deserializes
   JSON strings to Python dicts/dataclasses on the way back.

3. **Error unwrapping.** WIT `result<ok, err>` types are automatically
   converted to Python exceptions by componentize-py. The SDK catches these
   and re-raises as typed exceptions (`ToolCallError`, `LlmError`, `HttpError`).

The SDK does not validate metadata, do networking, parse schemas at runtime,
or know about MCP transports or LLM providers.

### WIT Contract

The WASM component implements the `friday:agent@0.1.0` world:

**Exports** (agent implements, host calls):

| Function | Signature | Purpose |
|---|---|---|
| `get-metadata` | `() -> string` | Returns JSON matching `CreateAgentConfig` |
| `execute` | `(prompt, context) -> agent-result` | Runs the agent handler |

**Imports** (host implements, agent calls):

| Function | Signature | Purpose |
|---|---|---|
| `call-tool` | `(name, args) -> result<string, string>` | Invoke MCP tool |
| `list-tools` | `() -> list<tool-definition>` | List available tools |
| `llm-generate` | `(request) -> result<string, string>` | LLM inference |
| `http-fetch` | `(request) -> result<string, string>` | Outbound HTTP |
| `log` | `(level, message)` | Structured logging |
| `stream-emit` | `(event-type, data)` | SSE events to UI |

All complex data crosses the boundary as JSON strings. Schema changes happen
in JSON, not WIT — avoids recompiling agents when fields are added.

### JSPI Async Bridging

WIT defines all functions as synchronous, but the host implementations for
`call-tool`, `llm-generate`, and `http-fetch` are async (they do real I/O).
JSPI (JavaScript Promise Integration) bridges this gap transparently:

1. Python calls `ctx.tools.call()` — synchronous from Python's perspective
2. The WIT boundary invokes the host function
3. JSPI **suspends** the WASM stack (the module pauses)
4. The host function executes asynchronously (MCP call, LLM API, HTTP fetch)
5. When the Promise resolves, JSPI **resumes** the WASM stack
6. Python gets the return value as if the call was synchronous

The `jco transpile` build step configures this with `--async-mode jspi` flags.
Agent authors never think about async — it just works.

### Error Handling: Defense in Depth

Two layers ensure agent failures are always data, never crashes:

**Layer 1 — SDK bridge** (`_bridge.py`): Wraps the handler in `try/except
Exception`. Python errors (KeyError, ValueError, application bugs) are
converted to `AgentResult_Err` with readable messages. Handles the common case.

**Layer 2 — Host executor** (`CodeAgentExecutor`): Wraps the entire WASM
`execute()` call in `try/catch`. WASM traps (OOM, stack overflow, timeout) that
escape the Python layer are converted to `AgentResult.err`. Handles catastrophic
failures.

An agent failure always produces an `AgentResult`, never an unhandled exception.

### Build Pipeline

`atlas agent build <dir>` wraps the compilation pipeline:

```
agent.py + SDK + WIT
    │
    ▼ componentize-py
agent.wasm (~18MB, includes CPython)
    │
    ▼ jco transpile --async-mode jspi
agent-js/ (ES module + WASM cores)
    │
    ▼ Zod validates getMetadata() output
    │
    ▼ atomic rename
~/.atlas/agents/{id}@{version}/
    ├── metadata.json
    ├── agent-js/
    │   ├── agent.js
    │   ├── agent.core*.wasm
    │   └── capabilities.js  (runtime trampoline)
    └── node_modules/
```

The build step is the validation enforcement point. `CreateAgentConfigValidationSchema`
(Zod) validates the metadata — same schemas that validate TypeScript agents
validate Python agents. Invalid metadata fails the build with actionable errors.

## Package Structure

```
friday_agent_sdk/
├── __init__.py       # Public API: agent, ok, err, AgentContext, errors
├── _decorator.py     # @agent decorator
├── _registry.py      # Module-level agent registration (one per module)
├── _bridge.py        # WIT boundary shim (componentize-py entry point)
├── _context.py       # build_context() — wires WIT imports to SDK wrappers
├── _result.py        # ok(), err(), OkResult, ErrResult
├── _serialize.py     # serialize_data() — dataclass/dict/string → JSON
└── _types.py         # AgentContext, Tools, Llm, Http, error types
```

```
wit/
└── agent.wit         # WIT contract (friday:agent@0.1.0)
```

```
wit_world/            # Generated by componentize-py (do not edit)
├── imports/
│   ├── capabilities.py   # Stub functions → WIT import trampolines at compile
│   └── types.py           # AgentResult_Ok, AgentResult_Err, ToolDefinition
└── exports/
    └── agent.py           # Empty (Agent class lives in _bridge.py)
```

## Constraints

- **Pure Python only.** The WASM sandbox (componentize-py) supports only pure
  Python packages. Native extensions (pydantic-core, numpy, httpx) are blocked.
- **No `import anthropic`.** Pydantic-core is a Rust extension. Use `ctx.llm`
  instead.
- **No direct networking.** No `requests`, no `urllib`, no sockets. Use
  `ctx.http.fetch()` for outbound HTTP.
- **Dataclasses for schemas, not Pydantic.** `input_schema` and `output_schema`
  accept `dataclass` classes or raw dicts (pre-built JSON Schema).
- **One agent per module.** The registry enforces this at import time.

## Running Tests

```bash
# Unit tests (native Python, no WASM)
cd packages/sdk-python && uv run pytest

# WASM round-trip tests (requires componentize-py + jco)
deno task test packages/sdk-python/tests/async-roundtrip.test.ts
```
