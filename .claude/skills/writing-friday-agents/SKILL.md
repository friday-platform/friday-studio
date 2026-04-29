---
name: writing-friday-agents
description: "Write, edit, or debug a Friday agent using the `friday_agent_sdk` Python SDK. Use when creating a new agent, adding LLM/HTTP/MCP capabilities, fixing `ctx.llm is None` errors, debugging agent build failures, or any work mentioning `@agent`, `AgentContext`, `ctx.llm` / `ctx.http` / `ctx.tools` / `ctx.stream`, `ok()`/`err()`, `parse_input`/`parse_operation`, or the `_bridge` import. Use even when the user says \"write a Python function that does X\" inside `packages/python/examples/`, an `agents/` directory, or any Friday agent project. Friday user agents run as subprocess processes via NATS — authoring patterns are non-obvious. Consult this skill before writing code."
user-invocable: false
---

# Writing Friday agents

## Mental model

A Friday agent is a sync Python function that runs as a subprocess via NATS:

```python
def execute(prompt: str, ctx: AgentContext) -> OkResult | ErrResult:
    ...
```

All I/O — LLM, HTTP, MCP tools, UI streaming — goes through `ctx`. Each invocation is a fresh import; module-level state never persists.

Treat the agent as a pure function with four capability hooks. `import requests`, `import anthropic`, `pip install pydantic`, module caches, threading — all fail.

## Canonical boilerplate

Copy `assets/agent-template.py` or start from this:

```python
from dataclasses import dataclass

from friday_agent_sdk import AgentContext, agent, err, ok, parse_input, run


@dataclass
class Input:
    task: str


@agent(
    id="my-agent",
    version="0.1.0",
    description="One-line description of what this agent does.",
)
def execute(prompt: str, ctx: AgentContext):
    try:
        data = parse_input(prompt, Input)
    except ValueError as e:
        return err(f"Invalid input: {e}")

    if ctx.llm is None:
        return err("LLM capability not available")

    response = ctx.llm.generate(
        messages=[{"role": "user", "content": data.task}],
        model="anthropic:claude-haiku-4-5",
    )
    return ok({"reply": response.text})


if __name__ == "__main__":
    run()
```

Non-obvious:
- `if __name__ == "__main__": run()` block is required. Without it the subprocess exits immediately on launch and no agent is registered.
- Handler can be sync or async (`def execute` or `async def execute`) — both work.
- One `@agent` per file. A second raises `RuntimeError`.
- Return `ok(...)` or `err(...)`. Raw dicts/strings fail.

## Picking a capability

| Need | Use | Reference |
|---|---|---|
| Generate text or structured objects | `ctx.llm.generate` / `ctx.llm.generate_object` | `capabilities.md`, `structured-output.md` |
| Call an external HTTP API | `ctx.http.fetch` | `capabilities.md` |
| GitHub/Postgres/Notion/etc. integration | `ctx.tools.call` + `mcp={...}` decorator | `mcp-tools.md` |
| Progress to user | `ctx.stream.intent` / `ctx.stream.progress` | `capabilities.md` |
| API tokens/secrets | `ctx.env["MY_TOKEN"]` + `environment=` decorator | `capabilities.md` |

Reaching for `requests`, `httpx`, `anthropic`, `openai`, or any non-stdlib package — stop. Route through `ctx`.

## Parsing the prompt

`prompt` is an enriched markdown string with embedded payloads, not a clean dict.

- `parse_input(prompt, MyDataclass)` — single payload shape
- `parse_operation(prompt, {"op1": Op1, "op2": Op2})` — discriminated union on `operation` field
- `parse_input(prompt)` — raw dict or `None` when JSON is optional

Schemas must be `@dataclass`es. Pydantic is blocked. See `references/input-parsing.md`.

## Returning results

- `ok(data)` — any JSON-serializable value. Dicts with named fields are standard.
- `ok(data, extras=AgentExtras(reasoning="...", artifact_refs=[...], outline_refs=[...]))` — optional metadata.
- `err("clear, actionable message")` — plain string. No structured errors cross the WIT boundary.

Wrap capability calls — `LlmError`, `HttpError`, `ToolCallError` — and return `err()` at the boundary.

## Top footguns

1. **Missing `if __name__ == "__main__": run()`.** Process exits immediately; no agent registered. Every agent file needs this.
2. **Reaching for `requests`/`httpx`/`anthropic`/`pydantic`.** Use `ctx.http` / `ctx.llm` / dataclasses.
3. **Assuming state persists.** Every call re-imports the module. Persist through MCP tools or returned data.
4. **Returning a raw value.** `return "hi"` fails. Wrap in `ok()`.
5. **Two `@agent` decorators in one file.** `RuntimeError`. Split into separate files.
6. **Skipping null checks on `ctx.llm` / `ctx.http` / `ctx.tools`.** They can be `None`. Return an `err()`.
7. **Pydantic schemas for `parse_input`.** Use dataclasses. Pydantic imports are blocked.

## When to read a reference

- `references/capabilities.md` — `ctx.*` API: signatures, return types, errors, limits
- `references/input-parsing.md` — `parse_input` vs `parse_operation`, validation
- `references/structured-output.md` — JSON Schema for `generate_object`
- `references/mcp-tools.md` — server config, tool-calling loop, LLM-driven tool use
- `references/sandbox-constraints.md` — what's blocked and why

Load only when the task touches that area. SKILL.md alone covers the first-try path for a simple agent.

## Unsure what shape the agent should take

Check `packages/python/examples/` for representative patterns — echo, LLM-only, LLM+HTTP, MCP tools, operation dispatch. Matching an existing example is the right first move.