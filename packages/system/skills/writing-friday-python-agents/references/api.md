# Friday Agent SDK — API Reference

Complete reference for the `friday_agent_sdk` Python package.

## Table of Contents

- [Public Exports](#public-exports)
- [@agent Decorator](#agent-decorator)
- [AgentContext](#agentcontext)
- [ctx.llm — Llm](#ctxllm)
- [ctx.http — Http](#ctxhttp)
- [ctx.tools — Tools](#ctxtools)
- [ctx.input — AgentInput](#ctxinput)
- [ctx.stream — StreamEmitter](#ctxstream)
- [Response Types](#response-types)
- [Result Types](#result-types)
- [Parse Utilities](#parse-utilities)
- [Exception Types](#exception-types)

---

## Public Exports

```python
from friday_agent_sdk import (
    # Decorator + entry point
    agent,
    run,

    # Parsing
    parse_input,
    parse_operation,

    # Result constructors + types
    ok, err,
    OkResult, ErrResult, AgentResult, AgentExtras,
    ArtifactRef, OutlineRef,

    # Context + structured input
    AgentContext,
    AgentInput, InputArtifactRef,
    SessionData,
    SkillDefinition,

    # Capability classes (rarely constructed by user code; useful for typing)
    Llm, Http, Tools, StreamEmitter,
    ToolDefinition,

    # Response types
    LlmResponse, HttpResponse,

    # Exceptions
    LlmError, HttpError, ToolCallError,

    # Version
    __version__,
)
```

---

## @agent Decorator

```python
def agent(
    *,
    id: str,                                    # Required — kebab-case unique identifier
    version: str,                               # Required — semver (e.g., "1.0.0")
    description: str,                           # Required — planner uses this for invocation decisions
    display_name: str | None = None,            # Human-friendly display name
    summary: str | None = None,                 # One-line summary
    constraints: str | None = None,             # What the agent cannot do
    examples: list[str] | None = None,          # Example prompts that invoke this agent
    environment: dict[str, Any] | None = None,  # Required/optional env vars
    mcp: dict[str, Any] | None = None,          # MCP server configurations
    llm: dict[str, Any] | None = None,          # Default LLM provider/model
    use_workspace_skills: bool = False,         # When True, host populates ctx.skills with workspace skills
) -> Callable
```

The decorator also accepts `input_schema: type | None` and `output_schema:
type | None` for forward compatibility, but neither is currently serialized to
the host — they are no-ops today. `ctx.output_schema` (below) is host-driven
and unrelated to these kwargs.

### use_workspace_skills

When set to `True`, the host attaches the workspace's resolved skills to
`ctx.skills` (a `list[SkillDefinition]` of `{name, description, instructions}`).
Leave it `False` if your agent does not consult workspace-defined skills — the
list is empty when this flag is off.

### environment

```python
environment={
    "required": [
        {
            "name": "API_KEY",
            "description": "API authentication key",
            "linkRef": {                          # optional — links to platform credential store
                "provider": "anthropic",
                "key": "api_key"
            }
        }
    ],
    "optional": [
        {"name": "DEBUG", "description": "Enable debug mode"}
    ]
}
```

### mcp

```python
mcp={
    "server-name": {
        "transport": {
            "type": "stdio",                      # only "stdio" supported currently
            "command": "npx",                     # command to start MCP server
            "args": ["-y", "@modelcontextprotocol/server-github"],
            "env": {                              # env vars passed to MCP server process
                "GITHUB_TOKEN": "{{env.GITHUB_TOKEN}}"  # references agent env var
            }
        }
    }
}
```

### llm

```python
llm={
    "provider": "anthropic",                    # LLM provider name
    "model": "claude-sonnet-4-6"                # default model (can be overridden per-call)
}
```

---

## AgentContext

```python
@dataclass
class AgentContext:
    env: dict[str, str]                 # Environment variables (always present, may be empty)
    config: dict                        # Agent-specific config from workspace (always present)
    skills: list[SkillDefinition]       # Workspace skills when use_workspace_skills=True, else []
    session: SessionData | None         # Session metadata
    output_schema: dict | None          # JSON Schema sent by the host on execute (e.g., from an FSM action's outputType); None when the host sends nothing
    input: AgentInput                   # Structured action input (always initialized)
    tools: Tools                        # MCP tool capability (always initialized)
    llm: Llm                            # LLM generation capability (always initialized)
    http: Http                          # HTTP fetch capability (always initialized)
    stream: StreamEmitter               # Progress streaming capability (always initialized)
```

`env`, `config`, `skills`, and `input` are guaranteed non-None. Capabilities are always initialized; they may be stubs in test contexts that raise `RuntimeError` if called without proper setup.

### SessionData

```python
@dataclass
class SessionData:
    id: str                         # Session identifier
    workspace_id: str               # Workspace this session belongs to
    user_id: str                    # User who initiated the session
    datetime: str                   # ISO datetime string
```

### SkillDefinition

```python
@dataclass
class SkillDefinition:
    name: str
    description: str
    instructions: str
```

Populated on `ctx.skills` when the agent is declared with `use_workspace_skills=True`.

---

## ctx.llm

### generate()

```python
def generate(
    messages: list[dict[str, str]],       # [{"role": "user", "content": "..."}]
    *,
    model: str | None = None,             # e.g., "anthropic:claude-sonnet-4-6"
    max_tokens: int | None = None,
    temperature: float | None = None,
    provider_options: dict | None = None,  # provider-specific options
) -> LlmResponse
```

Raises `LlmError` on failure.

### generate_object()

```python
def generate_object(
    messages: list[dict[str, str]],
    schema: dict,                          # JSON Schema for structured output
    *,
    model: str | None = None,
    max_tokens: int | None = None,
    temperature: float | None = None,
    provider_options: dict | None = None,
) -> LlmResponse
```

Returns `LlmResponse` with `.object` populated (dict) and `.text` as `None`.
Raises `LlmError` on failure.

---

## ctx.http

### fetch()

```python
def fetch(
    url: str,
    *,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    body: str | None = None,
    timeout_ms: int | None = None,
) -> HttpResponse
```

Raises `HttpError` on network-level failures. HTTP error status codes (4xx, 5xx)
do **not** raise — check `response.status` manually.

---

## ctx.tools

### list()

```python
def list() -> list[ToolDefinition]
```

```python
@dataclass
class ToolDefinition:
    name: str                       # Tool name (e.g., "create_issue")
    description: str                # What the tool does
    input_schema: dict              # JSON Schema for tool arguments
```

### call()

```python
def call(name: str, args: dict) -> dict
```

Raises `ToolCallError` on failure.

---

## ctx.input

Structured runtime input. `ctx.input` is the typed counterpart to the
`prompt` string: it exposes the compact `inputFrom`/config payload without
asking agents to scrape JSON out of markdown.

`raw` is populated from the host's execute payload (the `context.input`
section of the NATS execute message). When the host sends nothing structured,
`raw` is `{}` and every accessor returns the same empty-state shape.

```python
class AgentInput:
    raw: dict           # Full structured input as supplied by the host
    config: dict        # Shortcut for raw.get("config", {}) — the inputFrom-keyed dict

    def get(name: str | None = None, default: Any = None) -> Any: ...
    def require(name: str | None = None) -> Any: ...
    def artifact_refs(name: str | None = None) -> list[InputArtifactRef]: ...
    def artifact_json(name: str | None = None) -> Any: ...
```

Behavior notes:

- `get(name)` looks first in `raw["config"][name]` (the usual `inputFrom`
  shape) and falls back to `raw[name]`. Returns `default` when missing.
- `get()` with no name returns the full `raw` dict.
- `require(name)` raises `ValueError` if missing; `require()` with no name
  raises if `raw` is empty.
- `artifact_refs(name)` walks the selected payload and collects any
  `artifactRef` / `artifactRefs` entries into a deduplicated list. Useful
  when you want to introspect refs before fetching.
- `artifact_json(name)` resolves those refs through `get_artifact` and
  returns the parsed JSON — a single payload if one ref, a list if many.
  Raises `ValueError` when no refs are present and `ToolCallError` when
  `ctx.tools` is not initialized.

```python
@dataclass(frozen=True)
class InputArtifactRef:
    id: str
    type: str = "Artifact"
    summary: str = ""
```

`ctx.input` is intended for `inputFrom` upstream-step output. Signal-payload
fields the trigger fired with arrive in the `prompt` string — parse them with
`parse_input(prompt, ...)` instead.

---

## ctx.stream

### progress()

```python
def progress(content: str, *, tool_name: str | None = None) -> None
```

Emits a `data-tool-progress` event. `tool_name` defaults to `"agent"`.

### intent()

```python
def intent(content: str) -> None
```

Emits a `data-intent` event (high-level state change).

### emit()

```python
def emit(event_type: str, data: dict | str) -> None
```

Emits a raw stream event. `data` is JSON-serialized if it's a dict.

---

## Response Types

### LlmResponse

```python
@dataclass
class LlmResponse:
    text: str | None                # Generated text (None for generate_object)
    object: dict | None             # Structured output (None for generate)
    model: str                      # Model identifier used
    usage: dict                     # {"prompt_tokens": int, "completion_tokens": int}
    finish_reason: str              # e.g., "stop", "max_tokens"
```

### HttpResponse

```python
@dataclass
class HttpResponse:
    status: int                     # HTTP status code
    headers: dict[str, str]         # Response headers
    body: str                       # Response body as string

    def json(self) -> Any:          # Parse body as JSON
```

---

## Result Types

### ok()

```python
def ok(data: object, extras: AgentExtras | None = None) -> OkResult
```

`data` can be: dict, list, str, or a dataclass instance (auto-serialized).
`extras` is rarely needed — see source code for `AgentExtras` if you need it.

### err()

```python
def err(message: str) -> ErrResult
```

---

## Parse Utilities

### parse_input()

```python
@overload
def parse_input(prompt: str) -> dict: ...

@overload
def parse_input(prompt: str, schema: type[T]) -> T: ...
```

Extracts JSON from enriched prompt strings. Three-level fallback:

1. Balanced-brace JSON scan
2. Code-fenced `json` blocks
3. Entire prompt as JSON

With a dataclass `schema`: filters unknown keys, validates required fields,
returns typed instance. Raises `ValueError` if no JSON found, `TypeError` if
schema isn't a dataclass.

### parse_operation()

```python
def parse_operation(prompt: str, schemas: dict[str, type[T]]) -> T
```

Like `parse_input` but filters to JSON objects with an `"operation"` field and
dispatches to the matching schema. Raises `ValueError` if no valid operation
config found.

---

## Exception Types

```python
class ToolCallError(Exception): ...   # Raised by ctx.tools.call() on failure
class LlmError(Exception): ...        # Raised by ctx.llm.generate/generate_object on failure
class HttpError(Exception): ...        # Raised by ctx.http.fetch() on network failure
```

All exceptions carry the error message from the host as their string value.
