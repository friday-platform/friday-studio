# QA Plan: MCP Tool Usage in Python Agents

**Context**: Brainstorming session 2026-04-03 — validating that Python agents
can declare MCP server dependencies and call real MCP tools E2E.
**Branch**: `yaml-custom-agents`
**Date**: 2026-04-03

## Overview

Python agents compiled to WASM can declare MCP server dependencies in their
`@agent()` decorator. The runtime must read this metadata, spin up the declared
MCP servers, inject tools into the WASM execution, and clean up after execution.

This plan covers both the scaffolding work needed to close implementation gaps
and the QA cases to validate everything works.

## Prerequisites

- `uvx` installed (`which uvx` — Python package runner, needed for
  `mcp-server-time`)
- `mcp-server-time` available via uvx (`uvx mcp-server-time --help`)
- `componentize-py` on PATH (WASM build toolchain)
- `jco` on PATH (WASM transpilation)
- Daemon running on `:8080` (`deno task atlas daemon start --detached`)
- Agent build toolchain working (Cases 1-2 from code-agents-pipeline-cases.md
  pass)

---

## Scaffolding: Implementation Work (Completed 2026-04-03)

All scaffolding was implemented by an agent team and reviewed before QA.

| Task | Commit | Summary |
|------|--------|---------|
| S1-S2: UserAdapter reads mcp | `db1c30fce` | `AgentMetadataFileSchema` + `AgentSourceData.metadata` now include `mcp` field |
| S3: runtime.ts merges agent MCP | `69ae95e4a` | `executeCodeAgent()` merges `agentSource.metadata.mcp` into `mcpConfigs` (agent wins) |
| S4: Playground executor merge | `1c3076197` | Same pattern as S3, echo-server preserved as default |
| S5: time-agent Python fixture | `82f20b688` | 6 prompt commands, flat `mcp` map (matches `CreateAgentConfigValidationSchema`) |
| S6: WASM artifacts + stub | `70129a8f0` | `capabilities-stub.js` with deterministic mocks, `agent.wasm` + `agent-js/` built |

**Note**: The `mcp` decorator field uses the flat `Record<string, MCPServerConfig>`
shape (not nested under `"servers"` key) to match the Zod validation schema.

---

## Section 1: Build Pipeline — MCP Metadata Preservation

### Case 1. Build time-agent — MCP metadata in manifest

**Trigger**: `deno task atlas agent build packages/sdk-python/tests/fixtures/time-agent`

**Expect**:
- Build succeeds, artifact at `~/.atlas/agents/time-agent@1.0.0/`
- `metadata.json` contains `mcp` field with the time server config
- `metadata.json.mcp.servers.time.transport.type` is `"stdio"`
- `metadata.json.mcp.servers.time.transport.command` is `"uvx"`

**If broken**: Check `CreateAgentConfigValidationSchema` in
`packages/agent-sdk/src/types.ts` — the `mcp` field uses
`z.record(z.string(), MCPServerConfigSchema)`. If the schema shape doesn't
match what the Python decorator passes (e.g., `servers` nesting), the
validation will strip it. Compare raw metadata from `getMetadata()` against
the Zod schema.

### Case 2. Agent MCP metadata survives round-trip through UserAdapter

**Trigger**: After Case 1, run:
```bash
deno task atlas agent list --json | jq '.agents[] | select(.id == "time-agent")'
```

**Expect**:
- Agent appears in the list
- If `agent list` exposes metadata, verify MCP config is present

**If broken**: Check S1/S2 scaffolding — `AgentMetadataFileSchema` must
include `mcp`, and `loadAgent()` must return it. The `agent list` command
may not expose full metadata — check `UserAdapter.listAgents()` return
shape.

---

## Section 2: Integration Tests — WASM + Real MCP Server

These run at the `packages/sdk-python/tests/` level. Unlike the existing
`async-roundtrip.test.ts` (which uses a capabilities stub), these spin up
a real MCP server and inject real tools through the test harness.

Skip all cases if `uvx` is not on PATH.

### Case 3. Tool discovery — list tools from real MCP server

**Trigger**: Execute time-agent with prompt `"discover"` through the
integration test harness (spin up `mcp-server-time` via `createMCPTools`,
inject tools into WASM executor).

**Expect**:
- Agent returns `ok` result
- Result contains tool names including `get_current_time` and `convert_time`
- Tool count is >= 2

**If broken**: Check that `createMCPTools` successfully connects to the time
server via stdio. Check `uvx mcp-server-time --local-timezone` runs without
error. The MCP client's `tools()` call should return the tool list — add
logging to `create-mcp-tools.ts` if needed.

### Case 4. Single tool call — get current time

**Trigger**: Execute time-agent with prompt `"now"`

**Expect**:
- Agent returns `ok` result
- Result contains a time string (validate it looks like a timestamp or
  contains timezone info)
- The JSPI async bridge successfully suspended and resumed for the MCP call

**If broken**: Check the JSPI suspension path — `callTool` is async, JSPI
must suspend the WASM stack while the MCP server responds. If JSPI fails,
you'll get a synchronous error or hang. Check `code-agent-executor.ts`
host function binding.

### Case 5. Parameterized tool call — convert time between timezones

**Trigger**: Execute time-agent with prompt
`"convert 2025-01-01T12:00:00 UTC America/New_York"`

**Expect**:
- Agent returns `ok` result
- Result contains converted time (should show EST/EDT offset from UTC)

**If broken**: Check the `convert_time` tool's input schema — the argument
names may differ from what our agent passes. Run
`uvx mcp-server-time --local-timezone` manually and inspect its tool
schemas via an MCP client to verify parameter names.

### Case 6. Sequential multi-tool calls — combo

**Trigger**: Execute time-agent with prompt `"combo"`

**Expect**:
- Agent returns `ok` result
- Result contains BOTH a current time AND a converted time
- Proves MCP connection stays alive across multiple `callTool` invocations
  in a single WASM execution
- Both JSPI suspension/resume cycles complete successfully

**If broken**: If the first call works but the second fails, the MCP
client may be getting closed or the JSPI stack may not resume correctly
for a second suspension. Check whether `createMCPTools` returns a
persistent connection or one-shot clients. Check
`code-agent-executor.ts` — does it rebind `globalThis.__fridayCapabilities`
between calls?

### Case 7. Tool error handling — nonexistent tool

**Trigger**: Execute time-agent with prompt `"bad-tool"`

**Expect**:
- Agent returns `err` result (not a WASM trap)
- Error message indicates the tool was not found
- The Python `ToolCallError` exception was caught and converted to
  `err()` return

**If broken**: Check the host-side `mcpToolCall` callback — when the tool
name isn't in the `mcpTools` map, it should throw an error that flows
through JSPI as the WIT `result<string, string>` err variant. Check
`ComponentError` propagation through jco's result-catch-handler.

### Case 8. Error recovery — failed tool call doesn't poison connection

**Trigger**: Execute time-agent with prompt `"bad-tool-then-now"`

**Expect**:
- Agent catches the `ToolCallError` from the bad tool call
- Agent then successfully calls `get_current_time` and gets a real result
- Returns `ok` with both the error info and the successful time result

**If broken**: If the second call fails after catching the first error,
the MCP connection or JSPI stack is in a bad state after error handling.
Check whether the host-side error (thrown in `mcpToolCall`) correctly
propagates as a WIT err variant without corrupting the MCP client or the
WASM execution state.

### Case 9. Agent MCP metadata extraction — build preserves mcp config

**Trigger**: Unit test that builds the time-agent, reads
`metadata.json` from the output directory, and asserts the `mcp` field.

**Expect**:
- `metadata.json` exists and is valid JSON
- `metadata.mcp` matches the `@agent()` decorator's `mcp` parameter
- Schema validation passes (matches `MCPServerConfigSchema`)
- Transport type, command, and args are preserved exactly

**If broken**: Check `agent-builder.ts` — the metadata write at line ~279
uses `validatedMetadata` (post-Zod-parse). If Zod strips `mcp` or
transforms it, the output won't match. Compare pre-validation and
post-validation metadata.

---

## Section 3: E2E Pipeline — Full Stack with Daemon

These test the complete flow: build agent → start daemon → trigger signal →
runtime reads agent MCP metadata → spins up MCP server → agent executes
with real tools → response returned.

### Case 10. Full pipeline — build, deploy, execute with MCP tools

**Trigger**:
1. Build time-agent: `deno task atlas agent build packages/sdk-python/tests/fixtures/time-agent`
2. Create a workspace that uses the time-agent:
   ```bash
   mkdir -p /tmp/qa-time-agent-workspace
   cat > /tmp/qa-time-agent-workspace/workspace.yml << 'EOF'
   version: '1.0'
   workspace:
     name: QA Time Agent Test
     description: Tests MCP tool usage through Python agent

   signals:
     run-time:
       provider: http
       title: Run Time Agent
       description: Triggers the time agent
       config:
         path: /webhooks/run-time
       schema:
         type: object
         properties:
           prompt:
             type: string
         required:
           - prompt

   agents:
     time:
       type: user
       agent: time-agent
       description: Python agent with MCP time server

   jobs:
     time-test:
       title: Time Test
       triggers:
         - signal: run-time
       fsm:
         id: time-test-pipeline
         initial: idle
         states:
           idle:
             entry:
               - type: code
                 function: noop
             'on':
               run-time:
                 target: step_time
           step_time:
             entry:
               - type: code
                 function: prepare
               - type: agent
                 agentId: time
                 outputTo: time-output
                 prompt: Run the time agent.
               - type: emit
                 event: ADVANCE
             'on':
               ADVANCE:
                 target: completed
                 guards:
                   - guard_done
           completed:
             type: final
         functions:
           noop:
             type: action
             code: |
               export default function noop() {}
           prepare:
             type: action
             code: |
               export default function prepare(context, event) {
                 const prompt = event.data?.prompt || 'combo';
                 return { task: prompt };
               }
           guard_done:
             type: guard
             code: |
               export default function guard_done(context) {
                 return context.results['time-output'] !== undefined;
               }
         tools: {}
   EOF
   deno task atlas workspace add -p /tmp/qa-time-agent-workspace
   ```
3. Get workspace ID: `deno task atlas workspace list`
4. Trigger:
   ```bash
   deno task atlas signal trigger -n run-time -w <workspace-id> --data '{"prompt": "combo"}'
   ```
5. Watch session: `deno task atlas session list` → `deno task atlas session get <id>`

**Expect**:
- Session is created and reaches `completed` state
- Agent result contains both a current time and a converted time
- `deno task atlas logs --since 60s` shows MCP server startup and tool
  call logs
- No errors in daemon logs

**If broken**: Check S3 scaffolding — `runtime.ts executeCodeAgent()` must
read `agentSource.metadata.mcp` and merge it into `mcpConfigs`. If the
agent loads but tools aren't available, the MCP server wasn't started.
Check `createMCPTools` logs for connection errors. Verify `uvx` is on the
daemon's PATH (daemon inherits shell environment).

### Case 11. MCP server lifecycle — no zombie processes

**Trigger**: After Case 10 completes:
```bash
ps aux | grep mcp-server-time | grep -v grep
```

**Expect**:
- No lingering `mcp-server-time` processes
- The `dispose()` callback in `createMCPTools` successfully terminated the
  stdio subprocess

**If broken**: Check `createMCPTools` dispose logic in
`packages/mcp/src/create-mcp-tools.ts` — the `finally` block in
`runtime.ts executeCodeAgent()` must call `dispose()`. If the agent
execution throws before reaching the finally, MCP processes may leak.
Also check if `jco` WASM cleanup runs before or after dispose.

### Case 12. Agent metadata visible in registry after build

**Trigger**: After building time-agent:
```bash
deno task atlas agent list --json
```

**Expect**:
- `time-agent` appears with version `1.0.0`
- Description matches `"Exercises real MCP tool usage with time server"`

**If broken**: Check `UserAdapter.listAgents()` — same as Case 2. The
adapter must scan `~/.atlas/agents/time-agent@1.0.0/` and read
`metadata.json`.

### Case 13. Chat transcript shows tool calls

**Trigger**: After Case 10, read the chat/session transcript:
```bash
deno task atlas session get <session-id>
```

**Expect**:
- Session output includes evidence of tool calls (tool names, arguments,
  results)
- The agent's stream events (`started`, `completed`) appear in the
  session data

**If broken**: Check how `CodeAgentExecutor` reports tool usage — the
`streamEmitter` callback should forward agent events to the session.
Check `runtime.ts` stream event wiring.

---

## Section 4: Playground Execution

### Case 14. Execute time-agent via playground workbench

**Trigger**:
1. Ensure playground is running on `:5200` (`deno task playground`)
2. Build time-agent (Case 1)
3. Navigate to `http://localhost:5200/agents/built-in/time-agent`
4. Enter prompt `"combo"` and execute

**Expect**:
- Agent executes successfully
- Result shows both current time and converted time
- No WASM trap or connection errors in browser console

**If broken**: Check S4 scaffolding — playground `execute.ts` must read
agent MCP metadata and merge into `createMCPTools()` configs. Currently
it hardcodes `atlas-platform` + `echo-server` only.

### Case 15. Playground tool discovery

**Trigger**: Navigate to time-agent in playground, execute with prompt
`"discover"`

**Expect**:
- Result shows tool names including `get_current_time` and `convert_time`
- Tool count >= 2

**If broken**: Same as Case 14 — if MCP server isn't started from agent
metadata, no tools will be available.

---

## Smoke Candidates

- **Case 1** (build with MCP metadata) — validates build pipeline preserves
  MCP config
- **Case 6** (sequential multi-tool) — validates MCP connection persistence
  and JSPI multi-call
- **Case 10** (full E2E pipeline) — validates runtime reads agent MCP metadata
  and spins up servers
- **Case 11** (zombie process check) — validates MCP server cleanup

## Cleanup

After all cases:
```bash
rm -rf /tmp/qa-time-agent-workspace
rm -rf ~/.atlas/agents/time-agent@1.0.0
# Remove workspace from daemon if needed
```
