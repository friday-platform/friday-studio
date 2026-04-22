# Capabilities (`ctx.llm` / `ctx.http` / `ctx.tools` / `ctx.stream`)

All external I/O goes through the host. `AgentContext` exposes four capabilities. Each is sync from the agent's view — WASM JSPI suspends and resumes. Never write `async`/`await` in the handler.

Any capability can be `None` (test harness, missing config, unsupported context). Check first; return `err()`.

## `ctx.llm` — LLM generation

```python
response = ctx.llm.generate(
    messages=[{"role": "user", "content": "..."}],
    model="anthropic:claude-haiku-4-5",   # optional if decorator sets default
    max_tokens=1000,
    temperature=0.7,
    provider_options={"anthropic": {...}},
)
# response.text, response.model, response.usage, response.finish_reason

response = ctx.llm.generate_object(
    messages=[...],
    schema={"type": "object", "properties": {...}, "required": [...]},
    model="anthropic:claude-haiku-4-5",
)
# response.object is the parsed dict; response.text is None
```

**Model resolution** — first wins:
1. `model=` on the call
2. `llm={"provider": ..., "model": ...}` in decorator
3. Raises if neither is set

**Structured output**: pass a JSON Schema dict to `generate_object`. See `structured-output.md`.

**Errors**: raises `LlmError`. Wrap and return `err()`.

**No streaming**: full response returns at once.

## `ctx.http` — HTTP fetch

```python
response = ctx.http.fetch(
    url="https://api.example.com/v1/things",
    method="POST",
    headers={"Authorization": f"Bearer {ctx.env['MY_TOKEN']}"},
    body='{"query": "..."}',   # string, not dict
    timeout_ms=5000,
)
# response.status, response.headers, response.body (str)
# response.json() parses JSON bodies
```

Constraints:
- 5 MB response body cap (host-enforced)
- 30s default timeout, override with `timeout_ms`
- `body` is a string — use `json.dumps(...)` for JSON
- `requests`/`httpx` blocked (both need the `ssl` module). `ctx.http.fetch` is the only egress.

**Errors**: raises `HttpError` on transport failure. Non-2xx statuses return normally — check `response.status`.

## `ctx.tools` — MCP tools

Configure servers in `@agent(mcp=...)`. At runtime:

```python
tools = ctx.tools.list()            # list[ToolDefinition]: .name, .description, .input_schema
result = ctx.tools.call(
    "get_current_time",
    {"timezone": "UTC"},
)
# result is a dict (MCP response already parsed)
```

**Errors**: raises `ToolCallError`. Always wrap — swallowing hides real failures. See `mcp-tools.md` for server config.

## `ctx.stream` — progress UI

```python
ctx.stream.intent("Analyzing the PR diff")           # high-level phase
ctx.stream.progress("Fetched 47 files", tool_name="fetch")  # detail within phase
ctx.stream.emit("custom-event", {"key": "value"})
```

Emit before expensive ops (LLM, HTTP, slow tools), at phase boundaries, after milestones. Skip tight loops, sub-100ms work, per-item progress ("1/50, 2/50..."). Keep messages 50–100 chars.

`intent` = phase. `progress` = detail. Emits are no-ops when capability is `None`.

## Other `ctx` fields

- `ctx.env: dict[str, str]` — env vars from `environment=` decorator. Read tokens here; never hardcode.
- `ctx.config: dict` — agent + workspace config, merged.
- `ctx.session: SessionData | None` — session metadata when invoked in a session.
- `ctx.output_schema: dict | None` — host-requested output schema, if specified.
