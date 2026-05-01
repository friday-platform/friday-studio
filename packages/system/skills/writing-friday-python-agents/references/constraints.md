# Agent Constraints, Casing Rules, and Common Mistakes

## Table of Contents

- [Environment and Extension Guidance](#environment-and-extension-guidance)
- [Casing Rules](#casing-rules)
- [Build Pipeline](#build-pipeline)
- [Common Mistakes and Fixes](#common-mistakes-and-fixes)
- [One Agent Per Module](#one-agent-per-module)
- [Streaming LLM Responses](#streaming-llm-responses)

---

## Environment and Extension Guidance

### What's available

The full Python environment is available. The `friday-agent-sdk` and the Python standard library work out of the box. You can also `pip install` additional pure-Python packages.

Native C extensions work too if the Python environment has the required libraries:

| Available                                    | Notes                                           |
| -------------------------------------------- | ----------------------------------------------- |
| `json`, `re`, `dataclasses`, `collections`   | Standard library — always safe                  |
| `datetime`, `uuid`, `base64`, `urllib.parse` | Standard library — always safe                  |
| `pydantic`                                   | Works if pydantic-core is installed natively    |
| `numpy`, `pandas`                            | Work if compiled libraries are present          |
| `requests`, `httpx`, `urllib.request`        | Technically possible — but discouraged          |
| `ssl`, `socket`                              | Technically possible — but discouraged          |
| `subprocess`, `os.system`                    | Technically possible — but strongly discouraged |

### Why host capabilities are still recommended

Even though native extensions work, you should still use `ctx.llm`, `ctx.http`, and `ctx.tools` for I/O:

| Use Host Capability Instead Of    | Reason                                                     |
| --------------------------------- | ---------------------------------------------------------- |
| `ctx.http.fetch()` vs `requests`  | Host manages TLS, audit logging, rate limits, 5MB cap      |
| `ctx.llm.generate()` vs `openai`  | Host manages API keys, provider routing, token quotas      |
| `ctx.tools.call()` vs direct API  | MCP servers run centrally; credentials managed by host     |
| `ctx.stream.progress()` vs prints | UI integration; no direct stdout access in production      |
| `ctx.env` vs `os.environ`         | Only variables declared in `@agent` decorator are injected |

### The rule of thumb

Use the Python standard library for data manipulation. Use host capabilities for any I/O that crosses a network boundary or requires credentials. This keeps your agent portable, auditable, and independent of environment-specific API keys.

---

## Casing Rules

The SDK spans a Python/JavaScript boundary. Casing conventions differ on each side, and the bridge layer handles conversion for decorator metadata automatically.

### Your code (Python side)

| Context          | Convention   | Example                                                |
| ---------------- | ------------ | ------------------------------------------------------ |
| Decorator kwargs | `snake_case` | `display_name`, `input_schema`, `use_workspace_skills` |
| Dataclass fields | `snake_case` | `issue_key`, `max_results`                             |
| Function names   | `snake_case` | `_handle_view`, `_build_auth`                          |
| Variable names   | `snake_case` | `api_key`, `response_data`                             |

### Dict values passed to host

| Context               | Convention  | Example                                   |
| --------------------- | ----------- | ----------------------------------------- |
| Environment `linkRef` | `camelCase` | `{"linkRef": {"provider": "..."}}`        |
| MCP transport config  | `camelCase` | `{"type": "stdio", "command": "..."}`     |
| Stream event data     | `camelCase` | `{"toolName": "agent", "content": "..."}` |

### What the bridge converts automatically

The `_bridge.py` module converts decorator metadata to camelCase when serializing for the host:

- `display_name` → `displayName`
- `use_workspace_skills` → `useWorkspaceSkills`
- `input_schema` → `inputSchema` (after JSON Schema extraction)

You don't need to worry about this conversion — just use snake_case in Python and the bridge handles it.

---

## Build Pipeline

`atlas agent register` handles the full pipeline:

```
agent.py → spawn with FRIDAY_VALIDATE_ID → metadata.json over NATS
         → copy source dir to ~/.friday/local/agents/{id}@{version}/
         → write metadata.json sidecar
         → reload registry
```

You don't run NATS directly. If registration fails, the error message includes the phase (`prereqs`, `validate`, `write`) and details.

---

## Common Mistakes and Fixes

### Missing `run()` entry point

```python
# WRONG — agent starts but immediately exits, never subscribes to NATS
from friday_agent_sdk import agent, ok

@agent(id="my-agent", version="1.0.0", description="...")
def execute(prompt, ctx):
    return ok("hello")
# No run() — process exits before handling any request
```

```python
# CORRECT — run() subscribes to NATS and handles the execute request
from friday_agent_sdk import agent, ok, run

@agent(id="my-agent", version="1.0.0", description="...")
def execute(prompt, ctx):
    return ok("hello")

if __name__ == "__main__":
    run()
```

### Old `Agent` import from deleted class

```python
# WRONG — _bridge.Agent was deleted in the NATS rewrite
from friday_agent_sdk._bridge import Agent  # noqa: F401
```

```python
# CORRECT — no special import needed; run() is the entry point
from friday_agent_sdk import agent, ok, run
```

### Returning raw values instead of ok/err

```python
# WRONG — the SDK doesn't know how to serialize raw dicts
@agent(id="my-agent", version="1.0.0", description="...")
def execute(prompt, ctx):
    return {"result": "data"}
```

```python
# CORRECT
@agent(id="my-agent", version="1.0.0", description="...")
def execute(prompt, ctx):
    return ok({"result": "data"})
```

### Using pydantic for schemas

```python
# WRONG — pydantic-core is a Rust C extension; may not be installed
from pydantic import BaseModel

class Config(BaseModel):
    url: str
```

```python
# CORRECT — dataclasses are stdlib and always available
from dataclasses import dataclass

@dataclass
class Config:
    url: str
```

### Confusing generate_object schema format

```python
# WRONG — generate_object takes a JSON Schema dict, not a dataclass
@dataclass
class Output:
    summary: str

result = ctx.llm.generate_object(messages=[...], schema=Output)
```

```python
# CORRECT — JSON Schema dict
result = ctx.llm.generate_object(
    messages=[...],
    schema={
        "type": "object",
        "properties": {"summary": {"type": "string"}},
        "required": ["summary"],
    },
)
```

Note: `parse_input` takes dataclasses for validation. `generate_object` takes JSON Schema dicts for LLM constraint. Different tools, different schema formats.

### Using parse_input with non-dataclass

```python
# WRONG — parse_input schema must be a dataclass
class Config:
    url: str

config = parse_input(prompt, Config)  # TypeError
```

```python
# CORRECT
from dataclasses import dataclass

@dataclass
class Config:
    url: str

config = parse_input(prompt, Config)  # works
```

### Multiple agents in one module

```python
# WRONG — raises RuntimeError at import time
@agent(id="agent-a", version="1.0.0", description="...")
def handle_a(prompt, ctx):
    return ok("a")

@agent(id="agent-b", version="1.0.0", description="...")
def handle_b(prompt, ctx):
    return ok("b")
```

One agent per file. Split into separate modules:

```
agents/
  view-agent/agent.py
  search-agent/agent.py
  create-agent/agent.py
```

---

## One Agent Per Module

The registry enforces a singleton pattern. When `@agent` decorates a function, it registers with `_registry.py`. A second `@agent` call in the same module raises `RuntimeError`. This is by design — each `.py` file registers one agent identity.

If you need multiple related agents, create separate files:

```
agents/
  view-agent/agent.py
  search-agent/agent.py
  create-agent/agent.py
```

---

## Streaming LLM Responses

Not yet supported. `ctx.llm.generate()` blocks until the full response is ready.

For long-running agents, use `ctx.stream.progress()` to emit status updates between LLM calls so the UI shows activity:

```python
ctx.stream.progress("Analyzing document structure...")
structure = ctx.llm.generate(messages=[...])

ctx.stream.progress("Generating summary...")
summary = ctx.llm.generate(messages=[...])
```
