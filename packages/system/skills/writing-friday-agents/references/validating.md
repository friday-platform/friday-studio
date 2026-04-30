# Validating an agent before wiring it into a workspace

`POST /api/agents/register` confirms the `@agent` decorator parsed and the NATS
handshake succeeded. It does **not** exercise the handler. The first time the
handler actually runs is whatever invokes it next — and if that's a real user
invocation against real data, the user discovers your bug.

This page is the validation loop: how to invoke the agent directly, what
fixtures to run, what to inspect, and how to iterate.

## The endpoint

```
POST /api/agents/:id/run                        # MCP disabled (pure-logic test)
POST /api/agents/:id/run?workspaceId=<ws_id>    # Real workspace MCP + creds
```

Body:

```json
{
  "input": "<the prompt string the agent will receive>",
  "env": { "MY_VAR": "value" }   // optional — same shape as @agent(environment=…)
}
```

Response: SSE stream with these event types:

- `progress` — every `ctx.stream.intent(...)` / `ctx.stream.progress(...)` call
- `result` — once, on `ok(...)`. Payload is the dict you passed to `ok()`.
- `error` — once, on `err(...)` or unhandled exception. Payload `{error: string}`.
- `done` — once, with `{durationMs: number}`. Always fires.

Either `result` or `error` will appear, then `done`. If neither appears before
`done`, the agent crashed in the SDK layer (rare — usually a missing
`if __name__ == "__main__": run()` block).

## Two fixtures, minimum

### 1. Representative

What a typical real invocation looks like. The point of this fixture is *did
the happy path work end-to-end* — input parsed, capabilities called, result
returned in the expected shape.

A prompt the workspace job actually sends, with the real Signal Data block —
not a hand-crafted minimal example.

### 2. Stress

A fixture chosen specifically to break the agent — the input you'd be afraid
to run because you suspect it might fail. Most failures live here, especially
around `generate_object`, JSON parsing of LLM output, and feeding raw external
content back into prompts. A clean test fixture won't have the newlines,
quotes, or sheer size that real production data does — so a clean fixture
passing tells you almost nothing about whether the agent will survive its
first real invocation.

Common stress shapes:

- **Long strings** — input >1000 chars, or a content field carrying a real
  external payload (document body, page contents, transcript). Tests
  truncation, token limits, and string handling.
- **Embedded newlines and quotes** — `"line one\nline two\n\"quoted\""` inside
  a string field. Tests JSON repair and prompt escaping.
- **Control characters** — `\x00` through `\x1f`, BOM markers, zero-width
  spaces. Tests input sanitization.
- **Batch size** — if the agent processes N items in one LLM call, run with
  N=20 and check the response doesn't truncate mid-JSON. `max_tokens` defaults
  truncate large structured outputs without warning.
- **Empty / missing optional fields** — `{}`, `null`, missing keys. Tests
  dataclass defaults and `parse_input` error paths.
- **Repeated runs** — invoke the same fixture twice. Module-level state
  doesn't persist between subprocess invocations (that's a feature), but
  workspace-level state (memory writes, artifact creation) does. Confirm the
  second run handles already-existing state gracefully.

Don't write all of these for every agent — pick the ones that match the
agent's actual exposure. An agent that takes a single short string and
returns a single classification doesn't need the batch-size test; an agent
that ingests external payloads (web pages, documents, message bodies) and
feeds them into an LLM does.

## What to inspect

For each fixture, check:

1. **Result envelope shape.** Does the `result` payload have the keys the
   workspace job expects? Wrong shape → job downstream sees `undefined`,
   silent failure.
2. **Stream events.** Are `intent`/`progress` calls firing in the right order?
   No events between two slow operations means you're missing user-visible
   progress.
3. **Error path.** For the stress fixture, if it's *meant* to error, does the
   `error` event have an actionable message? `"Invalid input: missing field
   'task'"` is good. `"Error: 'NoneType' has no attribute 'foo'"` is not —
   wrap the failing call and return `err()` with context.
4. **Side effects** (workspace mode only). If the agent calls `memory_save`,
   `artifacts_create`, sends Slack, etc. — check those happened against the
   workspace, and that re-running doesn't cause duplicates.
5. **Duration.** A 60-second LLM call where you expected 5s usually means
   `max_tokens` isn't set or the prompt is too large. Cheaper to find here
   than in production.

## Iterate

1. Run fixture → fails.
2. Read the `error` event, fix the agent code (NOT the fixture).
3. Re-register with a bumped version: `POST /api/agents/register` with the
   updated source. The daemon hot-reloads — no restart.
4. Re-run the fixture. Repeat until both representative and stress pass.

Bump the agent's `version` field on every iteration so registrations don't
collide. Keep the version low (`0.1.1`, `0.1.2`) until validation passes —
only the version that ships into the job needs a clean number.

## When to skip workspace-context tests

Pure-logic agents (LLM-only, deterministic transforms, no MCP) get full
coverage from the no-`workspaceId` invocation. Skip the workspace test in that
case — it adds nothing and can't fail differently.

Add the workspace test whenever the agent calls `ctx.tools.call(...)`. The
no-`workspaceId` invocation rejects every tool call, which exercises the
agent's error-handling-on-tool-failure code, but not the success path.

## When the workbench UI is faster than curl

The agent-playground workbench (`/agents/built-in/<agent-id>`) wraps this
endpoint with:

- A workspace selector (matches the `workspaceId` query param)
- Run history persisted to sessionStorage
- Trace inspection (LLM calls, durations, tokens)
- Prompt history (arrow-up to recall recent fixtures)

For interactive iteration, it's faster than re-running curl. For automated
validation in a CI/script context or reproducibility, curl is unambiguous.

## Known limitation: decorator-only MCP

If the agent declares MCP servers via `@agent(mcp={...})` that are *not*
enabled at the workspace level, the validation invoke honors them — same
resolution as production. But unconfigured Link credentials will fail at
startup with a credential error, before the handler runs. That's the same
failure mode production has; treat it as the agent telling you the workspace
is missing a credential, not as a bug in the test runner.
