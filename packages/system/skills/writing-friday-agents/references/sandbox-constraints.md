# Agent constraints

Friday agents run as short-lived Python subprocesses. The host spawns `python agent.py`, the agent handles one NATS request, then exits. This is a real Python environment — but I/O still goes through `ctx`.

## Mental model

An agent is a function `execute(prompt, ctx) -> ok|err`:
- Spawned once per invocation, fresh process each time
- Real Python: stdlib + `friday_agent_sdk` (NATS is an internal SDK dependency — not a separately importable package)
- All LLM, HTTP, and MCP I/O goes through `ctx` — not `requests`, not `anthropic`
- Handler can be sync or async
- State does not persist between calls (new process each time)

## What to avoid

| Want to | Use instead |
|---|---|
| `import anthropic` / `openai` | `ctx.llm.generate(...)` |
| `import requests` / `httpx` | `ctx.http.fetch(...)` |
| `import pydantic` | `@dataclass` + `parse_input` — pydantic not installed |
| Module-level state across calls | Fresh process each invocation — persist via MCP tools or returned data |
| Two `@agent` in one file | `RuntimeError` at import |

Root cause for routing through `ctx`: the host enforces rate limiting, credential injection, audit logging, and capability access control. Bypassing `ctx` also breaks portability — agents don't know which LLM provider or API keys the workspace is configured with.

## Entry point

Every agent file needs:

```python
if __name__ == "__main__":
    from friday_agent_sdk import run
    run()
```

The host spawns `python agent.py`. Without this block, the process exits immediately without connecting to NATS.

## One agent per module

Module-level registry; second `@agent` raises `RuntimeError`. Two agents → two files.

## Stateless

```python
# BROKEN — counter resets every call (new process)
counter = 0

@agent(...)
def execute(prompt, ctx):
    global counter
    counter += 1
    return ok({"count": counter})
```

Every call spawns a new process. Counter is always 1. Persist through MCP tools or return data for the host.

## Strict return type

Handler must return `OkResult` or `ErrResult`:

```python
return "hi"                  # wrong
return {"text": "hi"}        # wrong
return ok({"text": "hi"})    # right
return ok("hi")              # right — data is any JSON-serializable value
```

## JSON at the result boundary

Return values, errors, tool args, tool results — all serialize to JSON. Non-serializable fields (file handles, lambdas, custom classes without `__dict__`) fail. Dataclasses, dicts, lists, primitives, `None` are safe.

## String errors

`err("message")` takes a plain string. Encode type in the string (`err("validation: max_length out of range")`) or return `ok` with a status field.

## Short form

1. Pure function — sync or async both fine.
2. Use `ctx.*` for all LLM, HTTP, and MCP I/O.
3. Return `ok(...)` / `err(...)`.
4. One `@agent` per file.
5. Always include `if __name__ == "__main__": run()`.
