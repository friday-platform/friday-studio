# Sandbox constraints

Friday user agents run as subprocess processes (Python) that communicate with the daemon via NATS. The SDK provides a sandboxed execution model — all I/O goes through capability hooks.

## Mental model

An agent is a pure function `execute(prompt, ctx) -> ok|err`:
- Called once per request, fresh module state each time
- No filesystem, no network, no threads, no subprocesses
- Reaches outside only through `ctx.llm`, `ctx.http`, `ctx.tools`, `ctx.stream`
- Sync from its own view

Treat it as a stateless pure function with four capability hooks. That model predicts every constraint below.

## What's blocked

| Want to | Use instead |
|---|---|
| `import anthropic` / `openai` | `ctx.llm.generate(...)` |
| `import requests` / `httpx` | `ctx.http.fetch(...)` |
| `import pydantic` | `@dataclass` + `parse_input` |
| `import numpy` / `pandas` | No alternative — rework the problem |
| `open(path)` / `pathlib` | No filesystem |
| `threading.Thread` / `multiprocessing` | Single-threaded. Sequential only. |
| `asyncio.run(...)` in a sync `execute` | Use `async def execute` if you need async — both supported |
| `subprocess.run(...)` | Use an MCP tool |
| Module-level state across calls | Fresh import each invocation |
| Two `@agent` in one file | `RuntimeError` at import |

Root cause: most blocked packages depend on C extensions (`pydantic-core`, `ssl`, `numpy`) or OS features the sandbox lacks.

## What's allowed

- Python stdlib, minus OS/network/threading modules
- `dataclasses`, `json`, `re`, `textwrap`, `datetime`, `collections`, `enum`, `typing`, `math`, etc.
- `friday_agent_sdk`
- Pure-Python deps you vendor (rare, almost never worth it)

## Non-obvious conventions

### `__main__` block

```python
if __name__ == "__main__":
    run()
```

Required in every agent file. The daemon spawns the file as a subprocess; without this block the process exits immediately and never registers with NATS.

### One agent per module

Module-level registry; second `@agent` raises `RuntimeError`. Each file defines one agent. Two agents → two files.

### Stateless

```python
# BROKEN — counter resets every call
counter = 0

@agent(...)
def execute(prompt, ctx):
    global counter
    counter += 1
    return ok({"count": counter})
```

Every call re-imports. Counter is always 1. Persist through MCP tools or return data for the host.

### Strict return type

Handler must return `OkResult` or `ErrResult`:

```python
return "hi"                  # wrong
return {"text": "hi"}        # wrong
return ok({"text": "hi"})    # right
return ok("hi")              # right — data is any JSON-serializable value
```

### JSON at the WIT boundary

Return values, errors, tool args, tool results — all serialize to JSON strings. Non-serializable fields (file handles, lambdas, custom classes without `__dict__`) fail. Dataclasses, dicts, lists, primitives, `None` are safe.

### String errors

`err("message")` takes a plain string. No structured envelope across WIT. Encode type in the string (`err("validation: max_length out of range")`) or return `ok` with a status field.

### Capability null checks

`ctx.llm`, `ctx.http`, `ctx.tools`, `ctx.stream` can be `None`. Check and return `err()`:

```python
if ctx.llm is None:
    return err("LLM capability not available in this context")
```

`ctx.stream` emits no-op when absent, but null-checking is still good hygiene for branching logic.

## Short form

1. Sync or async function — both work.
2. No packages beyond `friday_agent_sdk` + stdlib.
3. `ctx.*` for all I/O.
4. Return `ok(...)` / `err(...)`.
5. `if __name__ == "__main__": run()` at end of file.
6. One agent per file.
