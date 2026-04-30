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
| GitHub/Postgres/Notion/etc. (workspace-enabled) | `ctx.tools.call` — workspace MCP tools auto-available | `mcp-tools.md` |
| GitHub/Postgres/Notion/etc. (not workspace-enabled) | `ctx.tools.call` + `mcp={...}` decorator to add the server | `mcp-tools.md` |
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
8. **Declaring workspace MCP in the decorator.** If the workspace already has a server in `tools.mcp.servers` (e.g., `google-gmail`), the agent gets it automatically — no `@agent(mcp={...})` needed. Only use the decorator for servers that are NOT enabled at the workspace level.
9. **Treating `ctx.tools.call()` result as a string.** It returns a dict: `{"content": [{"type": "text", "text": "..."}]}`. Extract text explicitly — see `references/mcp-tools.md`.
10. **Not checking `isError` before using MCP results.** Auth failures and MCP errors return `{"isError": True, "content": [...error text...]}` — this is NOT raised as `ToolCallError`. Always check `result.get("isError")` first or you'll silently process an error message as real data.
11. **Using `list_mcp_tools` names verbatim in `ctx.tools.call`.** `list_mcp_tools` returns prefixed names (`google-gmail/search_gmail_messages`) — the prefix is correct for `type: llm` agent `config.tools`. Strip it for Python agents: `ctx.tools.call("search_gmail_messages", ...)` not `ctx.tools.call("google-gmail/search_gmail_messages", ...)`.
12. **Treating "registered" as "working".** A successful `POST /api/agents/register` only confirms the `@agent` decorator parsed and the NATS handshake succeeded — nothing about the actual handler ran. Skipping the validation invoke means the first failure surfaces during a real user invocation against real data, and you've corrupted the user's mental model of the workspace. Always exercise via `POST /api/agents/:id/run` with at least one fixture before wiring into a job. See `references/validating.md`.

## Registering an agent with Friday

`POST /api/agents/register { "entrypoint": "/abs/path/to/agent.py" }` — the daemon
spawns the agent with `FRIDAY_VALIDATE_ID`, reads its id/version/description from the
`@agent` decorator via NATS, copies all source files from the same directory to
`~/.friday/local/agents/{id}@{version}/`, and hot-reloads the registry. **No daemon restart
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

**Wire into workspace** — once registered AND validated (see below), reference it in
`workspace.yml` and load the `workspace-api` skill to add a job that invokes it:

```yaml
agents:
  my-agent:
    type: user
    agent: "my-agent"          # must match id in @agent decorator
    description: "What it does"
```

## Validating before wiring into a workspace

`POST /api/agents/register` confirms the decorator parsed — it does not exercise
the handler. Before adding the agent to a workspace job, invoke it directly with
representative input and at least one stress input (chosen specifically to break
the agent — long content, embedded newlines, batch sizes that stress LLM token
limits):

```bash
# Pure-logic test (MCP disabled — fast, no side effects)
curl -N -X POST http://localhost:8080/api/agents/my-agent/run \
  -H "Content-Type: application/json" \
  -d '{"input": "<your fixture>"}'

# Workspace-context test (real MCP servers, real credentials, real side effects)
curl -N -X POST 'http://localhost:8080/api/agents/my-agent/run?workspaceId=ws_id' \
  -H "Content-Type: application/json" \
  -d '{"input": "<your fixture>"}'
```

The endpoint streams SSE: `progress` events from `ctx.stream.*`, then a single
`result` (on `ok()`) or `error` (on `err()` or exception), then `done`. If the
result envelope is right and the streamed progress events make sense, the agent
works. If MCP tools are involved and the workspace has real credentials, the
test exercises them end-to-end — same code path as production.

**Two fixtures, minimum:**

1. **Representative** — what a typical real invocation looks like.
2. **Stress** — chosen specifically to break the agent. Long strings
   (>1000 chars), embedded newlines/quotes/control chars, batch sizes that
   stress LLM token limits, missing optional fields, empty arrays. Most agent
   failures (especially around `generate_object` and JSON parsing) only
   surface under input shapes a clean fixture won't have. The mindset is
   *"what input do I suspect might break this?"* — then run it.

Skip this step → the first failure is a real user invocation against real
data. Don't let "registered: ok" trick you into thinking you're done. See
`references/validating.md` for fixture patterns and what to inspect in stream
events.

## Full end-to-end flow from chat

When a user asks you to build a workspace with a custom Python agent, load both
`writing-friday-agents` (for the agent code) and `workspace-api` (for the workspace
wiring) and follow this sequence:

1. If the agent needs external services (Gmail, GitHub, etc.), call `enable_mcp_server` to
   add them to `tools.mcp.servers` first. The Python agent inherits these automatically —
   no decorator config needed.
2. Call `list_mcp_tools({ serverId })` to discover tool names and their `inputSchema`. Read the inputSchema for each tool you'll call — it gives the exact parameter names and types. Don't guess parameter names from descriptions; wrong names cause validation errors at runtime (pydantic for Python MCP servers, Zod for TypeScript ones).
3. Write the Python agent source using the boilerplate above. Use `ctx.tools.call("tool_name", args)` directly.
4. Write it to a clean `/tmp/` subdirectory.
5. Call `POST /api/agents/register` — confirm `ok: true`.
6. Validate via `POST /api/agents/:id/run?workspaceId=…` with at least one
   representative fixture and one stress fixture (see "Validating before wiring
   into a workspace" above). Confirm the `result` event matches what the job
   downstream expects. Iterate on the agent code until both fixtures pass.
7. Fetch the workspace config, add a `type: user` agent entry and a job FSM that
   invokes it, and write the updated config back to disk.

The `workspace-api` skill has the complete FSM and job schema; the key for custom
code agents is `type: user` with `agent:` matching the decorator id.

## When to read a reference

- `references/capabilities.md` — `ctx.*` API: signatures, return types, errors, limits
- `references/input-parsing.md` — `parse_input` vs `parse_operation`, validation
- `references/structured-output.md` — JSON Schema for `generate_object`
- `references/mcp-tools.md` — server config, tool-calling loop, LLM-driven tool use
- `references/sandbox-constraints.md` — what to avoid and why
- `references/validating.md` — fixture-driven invoke loop, stress inputs, what to inspect in stream events

Assets:
- `assets/agent-template.py` — minimal boilerplate with `parse_input`
- `assets/hello-py.py` — worked example: LLM + tool listing + streaming progress

Load only when the task touches that area. SKILL.md alone covers the first-try path for a simple agent.

## Unsure what shape the agent should take

Ask the user what the agent needs to do, then pick the simplest capability
combination from the table above (LLM-only, LLM+HTTP, MCP tools, operation
dispatch). Start from the boilerplate above and add only the capabilities
needed.
