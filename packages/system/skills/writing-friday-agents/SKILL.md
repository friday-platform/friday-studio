---
name: writing-friday-agents
description: "Write, edit, or debug a Friday agent using the `friday_agent_sdk` Python SDK. Use when creating a new agent, adding LLM/HTTP/MCP capabilities, fixing agent errors, or any work mentioning `@agent`, `AgentContext`, `ctx.llm` / `ctx.http` / `ctx.tools` / `ctx.stream`, `ok()`/`err()`, `parse_input`/`parse_operation`, or the agent `run()` entry point. Use even when the user says \"write a Python function that does X\" inside an `agents/` directory or any Friday agent project. Friday agents run as Python subprocesses with no direct LLM, HTTP, or MCP access — authoring patterns are non-obvious. Consult this skill before writing code."
user-invocable: false
---

# Writing Friday agents

## Mental model

A Friday agent is a Python file spawned as a subprocess per invocation. The host sends one `agents.{sessionId}.execute` NATS message; the agent handles it and exits.

```python
def execute(prompt: str, ctx: AgentContext) -> OkResult | ErrResult:
    ...
```

The process has a real Python environment — stdlib + `friday_agent_sdk`. All I/O through `ctx`. Each invocation spawns a fresh process; module-level state never persists between calls.

Handler can be sync or async. Capabilities (`ctx.llm`, `ctx.http`, `ctx.tools`, `ctx.stream`) are always initialized — they raise `RuntimeError` if called outside the host, never silently return `None`.

## Canonical boilerplate

Copy `assets/agent-template.py` or start from this:

```python
from dataclasses import dataclass

from friday_agent_sdk import AgentContext, agent, err, ok, parse_input


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

    response = ctx.llm.generate(
        messages=[{"role": "user", "content": data.task}],
        model="anthropic:claude-haiku-4-5",
    )
    return ok({"reply": response.text})


if __name__ == "__main__":
    from friday_agent_sdk import run
    run()
```

Non-obvious:
- `if __name__ == "__main__": run()` is required. It's the entry point — the host spawns `python agent.py` and this block connects to NATS and handles the request.
- Handler is sync by default; `async def execute` also works.
- One `@agent` per file. A second raises `RuntimeError`.
- Return `ok(...)` or `err(...)`. Raw dicts/strings fail the result serializer.

## Worked example — LLM + tools + streaming

`assets/hello-py.py` shows the most common pattern together: stream intent/progress while listing available tools and calling the LLM.

```python
from friday_agent_sdk import AgentContext, agent, err, ok


@agent(id="hello-py", version="1.0.0", description="...")
def execute(prompt: str, ctx: AgentContext):
    ctx.stream.intent(f'Processing: "{prompt}"')      # visible in Stream tab immediately

    tools = ctx.tools.list()
    ctx.stream.progress(f"Found {len(tools)} tool(s).")

    ctx.stream.progress("Calling LLM...")
    try:
        response = ctx.llm.generate(
            messages=[
                {"role": "system", "content": "Reply in 1-2 sentences."},
                {"role": "user", "content": prompt},
            ],
            model="anthropic:claude-haiku-4-5",
        )
    except Exception as e:
        return err(f"LLM call failed: {e}")

    return ok({"reply": response.text, "model": response.model})


if __name__ == "__main__":
    from friday_agent_sdk import run
    run()
```

Key points: `stream.intent` fires before any blocking work; tool listing and LLM are both fallible so wrap each; `model=` on the call takes priority over the decorator `llm=` field.

## Picking a capability

| Need | Use | Reference |
|---|---|---|
| Generate text or structured objects | `ctx.llm.generate` / `ctx.llm.generate_object` | `capabilities.md`, `structured-output.md` |
| Call an external HTTP API | `ctx.http.fetch` | `capabilities.md` |
| GitHub/Postgres/Notion/etc. integration | `ctx.tools.call` + `mcp={...}` decorator | `mcp-tools.md` |
| Web scraping / page fetch | `ctx.http.fetch` — try first; add MCP browser server only when JS rendering is required | `capabilities.md` |
| Progress to user | `ctx.stream.intent` / `ctx.stream.progress` | `capabilities.md` |
| API tokens/secrets | `ctx.env["MY_TOKEN"]` + `environment=` decorator | `capabilities.md` |

Reaching for `requests`, `httpx`, `anthropic`, `openai` — stop. Route through `ctx`.

`ctx.tools.call` takes two arguments — the tool name is flat across all declared MCP servers, no server prefix:

```python
result = ctx.tools.call("read_file", {"path": "/tmp/data.json"})
```

## Parsing the prompt

`prompt` is an enriched markdown string with embedded payloads, not a clean dict.

- `parse_input(prompt, MyDataclass)` — single payload shape
- `parse_operation(prompt, {"op1": Op1, "op2": Op2})` — discriminated union on `operation` field
- `parse_input(prompt)` — raw dict or `None` when JSON is optional

Schemas must be `@dataclass`es. Pydantic is not installed in the agent environment. See `references/input-parsing.md`.

## Returning results

- `ok(data)` — any JSON-serializable value. Dicts with named fields are standard.
- `ok(data, extras=AgentExtras(reasoning="...", artifact_refs=[...], outline_refs=[...]))` — optional metadata.
- `err("clear, actionable message")` — plain string.

Wrap capability calls — `LlmError`, `HttpError`, `ToolCallError` — and return `err()` at the boundary.

## Top footguns

1. **Missing `if __name__ == "__main__": run()`.** Agent never connects to NATS. Host spawns it and times out.
2. **Reaching for `requests`/`httpx`/`anthropic`/`pydantic`.** Use `ctx.http` / `ctx.llm` / dataclasses.
3. **Assuming state persists.** Every call spawns a fresh process. Persist through MCP tools or returned data.
4. **Returning a raw value.** `return "hi"` fails. Wrap in `ok()`.
5. **Two `@agent` decorators in one file.** `RuntimeError`. Split into separate files.
6. **Pydantic schemas for `parse_input`.** Use dataclasses. Pydantic is not installed.
7. **Adding an MCP browser/fetch server when the workspace already has web tools.** If workspace-chat has `agent_web` or `web_fetch` in scope, prefer those for web research rather than wiring a new MCP server to the agent. Inside the agent, `ctx.http.fetch()` handles plain HTTP; only reach for an MCP browser server when the page requires JavaScript rendering.

## Registering an agent with Friday

`POST /api/agents/register { "entrypoint": "/abs/path/to/agent.py" }` — the daemon
spawns the agent with `FRIDAY_VALIDATE_ID`, reads its id/version/description from the
`@agent` decorator via NATS, copies all source files from the same directory to
`~/.atlas/agents/{id}@{version}/`, and hot-reloads the registry. **No daemon restart
required.**

```bash
curl -X POST http://localhost:8080/api/agents/register \
  -H "Content-Type: application/json" \
  -d '{"entrypoint": "/abs/path/to/agent.py"}'
# → {"ok": true, "agent": {"id": "my-agent", "version": "0.1.0", "path": "..."}}
```

CLI equivalent: `deno task atlas agent register ./my-agent/` (same HTTP call).

The agent file must be written to disk first — write it to a clean `/tmp/` subdirectory (the API copies the whole parent dir), then POST the entrypoint path.

On failure: `ok: false` + `error` string + `phase`. `phase: "validate"` = agent
didn't start or NATS handshake timed out (check for Python syntax errors, missing
imports). `phase: "write"` = filesystem error after validation.

**Wire into workspace** — once registered, reference it in `workspace.yml` and load
the `workspace-api` skill to add a job that invokes it:

```yaml
agents:
  my-agent:
    type: user
    agent: "my-agent"          # must match id in @agent decorator
    description: "What it does"
```

## Full end-to-end flow from chat

When a user asks you to build a workspace with a custom Python agent, load both
`writing-friday-agents` (for the agent code) and `workspace-api` (for the workspace
wiring) and follow this sequence:

1. Write the Python agent source using the boilerplate above.
2. Write it to a clean `/tmp/` subdirectory.
3. Call `POST /api/agents/register` — confirm `ok: true`.
4. Fetch the workspace config, add a `type: user` agent entry and a job FSM that
   invokes it, and write the updated config back to disk.

The `workspace-api` skill has the complete FSM and job schema; the key for custom
code agents is `type: user` with `agent:` matching the decorator id.

## When to read a reference

- `references/capabilities.md` — `ctx.*` API: signatures, return types, errors, limits
- `references/input-parsing.md` — `parse_input` vs `parse_operation`, validation
- `references/structured-output.md` — JSON Schema for `generate_object`
- `references/mcp-tools.md` — server config, tool-calling loop, LLM-driven tool use
- `references/sandbox-constraints.md` — what to avoid and why

Assets:
- `assets/agent-template.py` — minimal boilerplate with `parse_input`
- `assets/hello-py.py` — worked example: LLM + tool listing + streaming progress

Load only when the task touches that area. SKILL.md alone covers the first-try path for a simple agent.

## Unsure what shape the agent should take

Ask the user what the agent needs to do, then pick the simplest capability
combination from the table above (LLM-only, LLM+HTTP, MCP tools, operation
dispatch). Start from the boilerplate above and add only the capabilities
needed.
