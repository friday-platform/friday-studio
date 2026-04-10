# QA Plan: Host Capabilities (llm-generate + http-fetch)

**Context**: Tasks #39-48 on `yaml-custom-agents` branch — adds `llm-generate`
and `http-fetch` host capabilities for WASM Python agents.
**Branch**: `yaml-custom-agents`
**Date**: 2026-04-03

## Prerequisites

- Atlas daemon running (`deno task atlas daemon start --detached`)
- Anthropic API key configured in daemon environment (for live LLM cases)
- Internet access (for httpbin.org cases)
- `componentize-py` available (for build pipeline cases)

## Cases

### Section 1: Automated Test Suite

#### 1. Unit tests — schemas, helpers, host bindings

**Trigger**: `deno task test packages/workspace/src/code-agent-executor.test.ts`
**Expect**: 49 tests pass — Zod schemas (LlmRequestSchema, HttpFetchRequestSchema),
parseAgentJson, resolveModelId (6 cases), createLlmGenerateHandler (10 tests),
createHttpFetchHandler (10 tests), existing executor tests.
**If broken**: Check test output for which describe block fails. Most likely
cause is a mock setup issue or Zod schema change.

#### 2. WASM round-trip — JSPI async bridging

**Trigger**: `deno task test packages/sdk-python/tests/async-roundtrip.test.ts`
**Expect**: 11 tests pass — tools-agent fixture (6 tests) + llm-http-agent
fixture (5 tests covering llmGenerate/httpFetch success and error paths).
**If broken**: Likely a fixture rebuild issue. If `agent-js/` is stale, re-run
the componentize-py + jco transpile commands in the test file header comment.

#### 3. E2E — discover -> execute pipeline

**Trigger**: `deno task test packages/workspace/src/host-capabilities-e2e.test.ts`
**Expect**: 7 tests pass — discovery, LLM success, model resolution, HTTP
success, LLM provider failure, HTTP network error, unknown prefix.
**If broken**: Check mock setup. The `importOriginal` pattern in `vi.mock("ai")`
is sensitive to AI SDK export changes.

### Section 2: Build Pipeline

#### 4. Build llm-http-agent from fixture

**Trigger**: `deno task atlas agent build packages/sdk-python/tests/fixtures/llm-http-agent`
**Expect**: Build succeeds, outputs to `~/.atlas/agents/llm-http-agent@1.0.0/`
with `agent-js/`, `metadata.json`, and vendored `node_modules/`.
**If broken**: Check componentize-py WIT resolution (`-d ./wit`), jco
`--async-imports` flags for `llm-generate` and `http-fetch`, `--map` flag for
capabilities stub.

#### 5. Built agent appears in listing

**Trigger**: `deno task atlas agent list`
**Expect**: `llm-http-agent` shows with version `1.0.0`, description "Exercises
LLM and HTTP capabilities", type `user`.
**If broken**: Check `metadata.json` shape against `AgentMetadataFileSchema` in
`user-adapter.ts`. New fields (like `llm`) must be explicitly added to the
schema.

### Section 3: Live Integration — LLM

#### 6. Agent makes real LLM call via ctx.llm.generate()

**Trigger**: Write a minimal test agent that calls
`ctx.llm.generate(messages=[{"role": "user", "content": "Say just the word 'pong'"}])`
and returns the response text. Build it, deploy to daemon, send a prompt.
**Expect**: Agent returns a result containing "pong" (or similar). Daemon logs
show the LLM call going through `@atlas/llm` registry.
**If broken**: Check `resolveModelId` — does the agent's llm config have the
right provider? Check daemon logs (`deno task atlas daemon logs`) for
ComponentError messages. Verify `@atlas/llm` registry has the provider
configured.

#### 7. LLM error propagates cleanly

**Trigger**: Same agent but with an invalid model name
(e.g., `model="nonexistent:bad-model"`).
**Expect**: Agent execution returns `AgentResult.err` with a meaningful error
message (not a raw stack trace). The error should mention the model or provider.
**If broken**: Check `createLlmGenerateHandler` error wrapping — provider errors
should be caught and wrapped in ComponentError with context.

### Section 4: Live Integration — HTTP

#### 8. Agent makes real HTTP GET via ctx.http.fetch()

**Trigger**: Test agent calls `ctx.http.fetch("https://httpbin.org/get")` and
returns the response body.
**Expect**: Agent returns JSON containing httpbin's echo response with `headers`,
`origin`, and `url` fields.
**If broken**: Check `createHttpFetchHandler` — DNS resolution in daemon
environment, timeout settings (default 30s), body size reading. Check daemon
logs for "agent outbound HTTP request" audit log.

#### 9. Agent makes HTTP POST with body

**Trigger**: Test agent calls
`ctx.http.fetch("https://httpbin.org/post", method="POST", body='{"test": true}', headers={"content-type": "application/json"})`
and returns the response.
**Expect**: httpbin echoes back `{"test": true}` in its `data` or `json` field.
Response status is 200.
**If broken**: Check body serialization through `HttpFetchRequestSchema`, fetch
options wiring (method, headers, body all forwarded correctly).

### Section 5: Edge Cases

#### 10. Agent without llm_config calls ctx.llm with explicit model

**Trigger**: Build an agent with no `llm` config in `@agent()` decorator. Call
`ctx.llm.generate(model="anthropic:claude-haiku-4-5", messages=[...])`.
**Expect**: Works — fully qualified model bypasses config fallback entirely.
`resolveModelId` returns the model as-is.
**If broken**: `resolveModelId` not handling the "fully qualified model, no
config" case (first branch: `requestModel.includes(":")`).

#### 11. Existing agents unaffected — backward compatibility

**Trigger**: Send a prompt to the existing echo-agent (which doesn't use
llm/http capabilities).
**Expect**: Echo agent works exactly as before. `ctx.llm` and `ctx.http` are
`None` in Python (hasattr guards). No regressions in agent discovery, build, or
execution.
**If broken**: Check `hasattr` guards in
`packages/sdk-python/friday_agent_sdk/_context.py`. Check that WIT interface
changes are backward compatible (new functions are optional imports).

## Smoke Candidates

- **Case 1** (unit tests) — fast, high signal, catches schema/helper regressions
- **Case 2** (WASM round-trip) — catches fixture staleness and JSPI bridging issues
- **Case 11** (backward compatibility) — catches regressions in existing agent execution
