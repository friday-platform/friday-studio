# QA Plan: Code Agent Pipeline

**Context**: [Code Agents Implementation v3](../../plans/2026-04-02-code-agents-implementation.v3.md)
**Branch**: `yaml-custom-agents`
**Date**: 2026-04-03

## Prerequisites

- `componentize-py` on PATH (verified: 0.22.0)
- `jco` on PATH (verified: 1.16.1)
- Daemon running on `:8080` (`deno task atlas daemon start --detached`)
- Playground running on `:5200` (`deno task playground`)
- No agents built yet — `~/.atlas/agents/` does not exist (clean slate)
- For workspace cases: create a test workspace (see Case 12 setup)

---

## Section 1: Build CLI

### 1. Happy path — build echo agent from fixture

**Trigger**: Run `deno task atlas agent build packages/sdk-python/tests/fixtures/echo-agent`

**Expect**:
- Command exits 0
- Artifact appears at `~/.atlas/agents/echo@1.0.0/` (note: agent ID is `echo`,
  not `echo-agent` — the `@agent(id="echo")` decorator controls the ID)
- Directory contains: `metadata.json`, `agent.js`, `*.wasm`, `agent.d.ts`,
  `interfaces/`
- `metadata.json` is valid JSON with at minimum `id`, `version`, `description`
- `metadata.json.id` is `"echo"`, `version` is `"1.0.0"`

**If broken**: Check `apps/atlas-cli/src/commands/agent/build.ts` — the 6-phase
pipeline. `componentize-py` or `jco transpile` may fail silently. Look at stderr
output for WASM compilation errors. Verify the WIT file at
`packages/sdk-python/wit/agent.wit` is reachable from the fixture directory.

### 2. Build tools-agent (exercises all host capabilities)

**Trigger**: Run `deno task atlas agent build packages/sdk-python/tests/fixtures/tools-agent`

**Expect**:
- Artifact at `~/.atlas/agents/tools-agent@1.0.0/`
- `metadata.json` has `id: "tools-agent"`, `version: "1.0.0"`
- Build succeeds despite the agent importing `log`, `stream_emit` from
  `wit_world.imports.capabilities` (these are WIT imports, not Python packages)

**If broken**: Same as Case 1. Additionally check that the `capabilities-stub.js`
written during build satisfies all four WIT imports (`callTool`, `listTools`,
`log`, `streamEmit`). See `tools-agent/capabilities-stub.js` for the fixture's
version.

### 3. Build validation failure — invalid metadata

**Trigger**: Temporarily edit `packages/sdk-python/tests/fixtures/echo-agent/agent.py`
to remove the `description` field from the `@agent` decorator:
```python
@agent(id="echo", version="1.0.0")
```
Then run `deno task atlas agent build packages/sdk-python/tests/fixtures/echo-agent`

**Expect**:
- Build fails with a Zod validation error mentioning `description`
- No artifact written to `~/.atlas/agents/`
- No `.tmp/` directory left behind
- Exit code is non-zero

**Cleanup**: Restore the original `agent.py` after this case.

**If broken**: Check the metadata validation step in `build.ts` — it calls
`getMetadata()` on the transpiled module and validates with
`CreateAgentConfigValidationSchema`. The Zod error should surface, not be
swallowed.

### 4. Missing prerequisite — actionable error

**Trigger**: Temporarily rename `componentize-py` out of PATH:
```bash
mv $(which componentize-py) /tmp/componentize-py-bak
deno task atlas agent build packages/sdk-python/tests/fixtures/echo-agent
mv /tmp/componentize-py-bak $(which componentize-py)
```

**Expect**:
- Build fails immediately (before any compilation attempt)
- Error message includes install instructions for `componentize-py`
- Exit code is non-zero

**If broken**: Check the prerequisites check phase at the top of `build.ts`.

---

## Section 2: Agent Discovery

### 5. User agent appears in registry after build

**Trigger**: After Case 1 succeeds, run `deno task atlas agent list`

**Expect**:
- Output includes the echo agent with `id: echo` (or `user:echo`)
- Shows version `1.0.0` and description `"Echoes input"`

**If broken**: Check `UserAdapter.listAgents()` at
`packages/core/src/agent-loader/adapters/user-adapter.ts`. Verify it scans
`~/.atlas/agents/` correctly. Check that the CLI `agent list` command actually
reads from the adapter (not just bundled agents).

### 6. Playground /api/agents includes user agents

**Trigger**: `curl http://localhost:5200/api/agents | jq '.agents[] | select(.id == "echo")'`

**Expect**:
- Returns a JSON object with `id: "echo"`, `displayName` (either `"echo"` or a
  display name from metadata), `description: "Echoes input"`, `version: "1.0.0"`
- Fields `summary`, `constraints` are empty strings
- Fields `examples` is `[]`, `inputSchema` and `outputSchema` are `null`
- `requiredConfig` and `optionalConfig` are `[]`

**If broken**: Check `tools/agent-playground/src/lib/server/routes/agents.ts` —
the `listUserAgents()` call appends user agents after bundled ones. Also check
`tools/agent-playground/src/lib/server/lib/user-agents.ts` — the adapter
instance and `getAtlasHome()` resolution.

### 7. Rebuild reflects updated metadata without restart

**Trigger**:
1. Note the current `description` from `/api/agents` for echo agent
2. Edit `packages/sdk-python/tests/fixtures/echo-agent/agent.py` — change
   description to `"Echoes input v2"`
3. Rebuild: `deno task atlas agent build packages/sdk-python/tests/fixtures/echo-agent`
4. Query again: `curl http://localhost:5200/api/agents | jq '.agents[] | select(.id == "echo")'`

**Expect**:
- Description now shows `"Echoes input v2"` without restarting the playground or
  daemon
- No stale cached version

**Cleanup**: Restore original description and rebuild.

**If broken**: The `UserAdapter` re-scans on every `listAgents()` call (no
caching). If stale, check whether the playground caches the adapter instance or
the agent list somewhere.

### 8. Version resolution — latest semver wins

**Trigger**:
1. Build echo agent normally (creates `echo@1.0.0/`)
2. Edit `agent.py` to set `version="2.0.0"`, rebuild
3. Verify `~/.atlas/agents/` now has both `echo@1.0.0/` and `echo@2.0.0/`
4. Query: `curl http://localhost:5200/api/agents | jq '.agents[] | select(.id == "echo") | .version'`

**Expect**:
- Only one echo agent in the list (not two)
- Version is `"2.0.0"` (highest semver wins)
- `echo@1.0.0/` still exists on disk (not deleted)

**Cleanup**: Remove `echo@2.0.0/` and restore `agent.py` to `version="1.0.0"`.

**If broken**: Check `UserAdapter.listAgents()` — the grouping/resolution logic
that groups by agent ID and picks highest semver. Look for the semver comparison
function.

### 9. .tmp directories ignored during discovery

**Trigger**:
1. Manually create a directory: `mkdir -p ~/.atlas/agents/fake@0.1.0.tmp`
2. Put a minimal `metadata.json` inside it:
   `echo '{"id":"fake","version":"0.1.0","description":"should not appear"}' > ~/.atlas/agents/fake@0.1.0.tmp/metadata.json`
3. Query: `curl http://localhost:5200/api/agents | jq '.agents[] | select(.id == "fake")'`

**Expect**:
- No `fake` agent in the results — `.tmp` directories are filtered out

**Cleanup**: `rm -rf ~/.atlas/agents/fake@0.1.0.tmp`

**If broken**: Check the directory scan filter in `UserAdapter.listAgents()` —
should skip entries ending in `.tmp`.

---

## Section 3: Playground Execution

### 10. Agent catalog shows user agent alongside bundled agents

**Trigger**: Navigate to `http://localhost:5200/agents/built-in` in Chrome

**Expect**:
- The agent catalog/selector UI loads
- Echo agent appears in the list alongside bundled agents
- Shows the display name and description from metadata

**If broken**: Check the `AgentCatalog` component — it renders from the
`agentsQuery` which hits `/api/agents`. If the API returns the agent (Case 6)
but the UI doesn't show it, the issue is in the Svelte component rendering.

### 11. Execute echo agent via playground workbench

**Trigger**:
1. Navigate to `http://localhost:5200/agents/built-in/echo`
2. Type `"hello from QA"` in the input field
3. Execute the agent

**Expect**:
- SSE stream connects and delivers events
- Result appears in the UI containing `"hello from QA"` (echo behavior)
- No error state in the UI

**If broken**: Check `tools/agent-playground/src/lib/server/routes/execute.ts` —
the `userAgentExists(agentId)` check determines routing. The `CodeAgentExecutor`
is instantiated inline. Check browser console for SSE connection errors. Check
daemon logs: `deno task atlas logs --since 30s`.

### 12. Execute tools-agent via playground — host function round-trip

**Trigger**:
1. Build tools-agent first (Case 2)
2. Navigate to `http://localhost:5200/agents/built-in/tools-agent`
3. Type `"test host functions"` in the input
4. Execute

**Expect**:
- Agent executes successfully (tools-agent calls `callTool("echo", ...)`,
  `listTools()`, `log()`, and `streamEmit()`)
- Result contains `tool_result` and `tool_count` fields
- Stream events appear (the agent emits `"started"` and `"completed"` events)
- No WASM traps or unhandled errors

**If broken**: This exercises the full JSPI async bridging path. Check:
- `CodeAgentExecutor` host function binding (the `globalThis.__fridayCapabilities` trampoline)
- The `mcpToolCall` callback in `execute.ts` — does the playground provide an
  `echo` tool? If not, the tool call will fail. Check what tools
  `getAtlasPlatformServerConfig()` provides.
- Browser devtools Network tab for SSE event stream content

### 13. Tool call error in playground — graceful failure

**Trigger**:
1. Navigate to `http://localhost:5200/agents/built-in/tools-agent`
2. Type `"fail:intentional error"` in the input
3. Execute

**Expect**:
- Agent returns an error result (not a crash) — the tools-agent catches
  `ToolCallError` when prompt starts with `"fail:"` and returns `err(str(e))`
- The playground UI shows the error message, not a connection failure
- No WASM trap

**If broken**: Check the WIT result variant handling — `call-tool` returns
`result<string, string>`. The `Err` variant should propagate through JSPI back
to the Python SDK as `ToolCallError`. Check `CodeAgentExecutor` error handling.

---

## Section 4: Workspace Runtime (Daemon)

### 14. Create test workspace with user agent

**Trigger**: Create a minimal workspace for testing:

```bash
mkdir -p /tmp/qa-code-agent-workspace
cat > /tmp/qa-code-agent-workspace/workspace.yml << 'EOF'
version: '1.0'
workspace:
  name: QA Code Agent Test
  description: Tests code agent execution through the workspace runtime

signals:
  run-echo:
    provider: http
    title: Run Echo Agent
    description: Triggers the echo agent with a message
    config:
      path: /webhooks/run-echo
    schema:
      type: object
      properties:
        message:
          type: string
      required:
        - message

agents:
  echo:
    type: user
    agent: echo
    description: Echoes input via WASM code agent

jobs:
  echo-test:
    title: Echo Test
    triggers:
      - signal: run-echo
    fsm:
      id: echo-test-pipeline
      initial: idle
      states:
        idle:
          entry:
            - type: code
              function: cleanup
          'on':
            run-echo:
              target: step_echo
        step_echo:
          entry:
            - type: code
              function: prepare_echo
            - type: agent
              agentId: echo
              outputTo: echo-output
              prompt: Echo the input message back.
            - type: emit
              event: ADVANCE
          'on':
            ADVANCE:
              target: completed
              guards:
                - guard_echo_done
        completed:
          type: final
      functions:
        cleanup:
          type: action
          code: |
            export default function cleanup(context, event) {}
        prepare_echo:
          type: action
          code: |
            export default function prepare_echo(context, event) {
              const message = event.data?.message || 'no message';
              return { task: message };
            }
        guard_echo_done:
          type: guard
          code: |
            export default function guard_echo_done(context, event) {
              return context.results['echo-output'] !== undefined;
            }
      tools: {}
EOF

deno task atlas workspace add -p /tmp/qa-code-agent-workspace
```

**Expect**:
- Workspace is registered with the daemon
- `deno task atlas workspace list` shows the new workspace

**If broken**: Check daemon logs for workspace loading errors. Verify `type: user`
is accepted by the workspace config schema. Check
`packages/config/src/agents.ts` for the agent config validation.

### 15. Execute user agent through workspace signal

**Trigger**:
1. Get the workspace ID from `deno task atlas workspace list`
2. Trigger: `deno task atlas signal trigger -n run-echo -w <workspace-id> --data '{"message": "hello from workspace"}'`
3. Watch: `deno task atlas session list` to find the session
4. Check: `deno task atlas session get <session-id>`

**Expect**:
- Session is created and completes (reaches `completed` state)
- Echo agent executes via `CodeAgentExecutor` (not the MCP orchestrator)
- Session output contains the echoed message
- `deno task atlas logs --since 60s` shows agent execution logs

**If broken**: Check `packages/workspace/src/runtime.ts` — the
`agentConfig?.type === "user"` branch at line ~1230. Verify
`executeCodeAgent()` resolves the agent via `UserAdapter.loadAgent()`. Check
daemon logs for WASM loading or execution errors.

### 16. Execute tools-agent through workspace — full host function binding

**Trigger**:
1. Update `/tmp/qa-code-agent-workspace/workspace.yml` to add a tools-agent entry:
   ```yaml
   agents:
     echo:
       type: user
       agent: echo
       description: Echoes input
     tools:
       type: user
       agent: tools-agent
       description: Exercises all host capabilities
   ```
   And add a second job/signal that triggers the tools agent (or just change the
   existing job's `agentId` to `tools`).
2. The daemon should hot-reload the workspace config.
3. Trigger the tools agent via signal.

**Expect**:
- Tools-agent calls `callTool("echo", ...)` through the host function bridge
- Host function resolves via workspace MCP tool infrastructure
- Stream events from the agent appear in session output
- Log messages from the agent appear in daemon logs

**If broken**: The workspace runtime's `executeCodeAgent()` binds MCP tools from
the workspace's server configs. If the workspace doesn't have an MCP server
providing an `echo` tool, the tool call will fail. Check what tools are available
in the workspace context. The error should be a graceful `ToolCallError`, not a
crash.

---

## Section 5: Error Paths

### 17. Missing agent — 404 from playground

**Trigger**: `curl -X POST http://localhost:5200/api/execute -H 'Content-Type: application/json' -d '{"agentId": "nonexistent-agent", "input": "test"}'`

**Expect**:
- Returns HTTP 404 with `{"error": "Agent \"nonexistent-agent\" not found"}`
- `userAgentExists("nonexistent-agent")` returns false, falls through to bundled
  agent lookup, also misses → 404

**If broken**: Check `execute.ts` routing logic — `userAgentExists` then
`bundledAgents.find`. If user adapter throws instead of returning false for
missing agents, the 404 path won't be reached.

### 18. Missing agent — workspace execution

**Trigger**:
1. Configure a workspace agent with a nonexistent agent ID:
   ```yaml
   agents:
     phantom:
       type: user
       agent: does-not-exist
   ```
2. Trigger the job that references this agent.

**Expect**:
- Session fails with an error (not a crash)
- Error message indicates the agent was not found
- Daemon stays running

**If broken**: Check `UserAdapter.loadAgent()` — should throw or return an error
when the agent directory doesn't exist. Check `WorkspaceRuntime.executeCodeAgent()`
error handling.

### 19. Unhandled Python exception → AgentResult.err

**Trigger**: This requires a fixture agent that raises an unhandled exception.
Option A: Create a temporary agent. Option B: Use the tools-agent with a prompt
that causes an unexpected error path.

Best approach: If the tools-agent's `echo` tool isn't available (no MCP server
provides it), calling `ctx.tools.call("echo", ...)` will return an error. The
tools-agent catches `ToolCallError` for the `"fail:"` path but lets the normal
path propagate if the tool doesn't exist.

**Trigger**: Execute tools-agent in a context where no `echo` tool is available
(e.g., a workspace without MCP servers providing `echo`).

**Expect**:
- Agent returns `AgentResult.err` (not a crash, not an unhandled exception)
- Error message includes context about what failed
- The Python SDK bridge's `try/except` catches the uncaught `ToolCallError` and
  converts to `ErrResult`

**If broken**: Check the defense-in-depth layers:
1. Python bridge layer (`friday_agent_sdk/_bridge.py`) — `try/except Exception`
2. Executor layer (`packages/workspace/src/code-agent-executor.ts`) — `try/catch`

### 20. Agent timeout enforcement

**Trigger**: This requires an agent that hangs. We don't have a fixture for this,
so test via the `CodeAgentExecutor` timeout configuration.

Option A (if we can set timeout low): Execute the echo agent with a very short
timeout (e.g., 1ms) — the WASM instantiation alone should exceed it.

Option B (unit test verification): Verify the timeout path exists in
`code-agent-executor.ts` and the E2E tests cover it.

**Expect**:
- When timeout expires, `AgentResult.err` is returned with a timeout message
- The WASM execution is aborted (not left running)

**If broken**: Check the `Promise.race` timeout wrapper in `CodeAgentExecutor`.
The `timeoutMs` option defaults to 180000 (3 minutes).

---

## Section 6: Known Quirks (Verification)

### 21. WASM internal ID vs directory ID mismatch

**Trigger**: After building echo agent, check:
1. Directory name: `ls ~/.atlas/agents/` — should show `echo@1.0.0/`
2. `metadata.json` ID: `cat ~/.atlas/agents/echo@1.0.0/metadata.json | jq .id`
3. Playground agent list: `curl http://localhost:5200/api/agents | jq '.agents[] | select(.id == "echo")'`

**Expect**:
- The directory is named after the `@agent(id="echo")` decorator value
- `metadata.json.id` matches: `"echo"`
- Playground uses the same ID: `"echo"`
- Everything is consistent — the build CLI reads the ID from `getMetadata()`,
  not from the directory name

**If broken**: The build CLI creates the directory as `{metadata.id}@{metadata.version}/`.
If there's a mismatch, check `build.ts` line where it constructs the output path.

### 22. listTools pre-resolved (sync WIT constraint)

**Trigger**: Execute the tools-agent and examine the `tool_count` in the result.

**Expect**:
- `tool_count` reflects tools available at execution start (pre-resolved)
- This is a known architectural constraint — WIT's `list-tools` is sync, so
  tools are resolved before `execute()` is called and injected via the
  capabilities module

**If broken**: Not a bug — just verify the behavior matches the documented quirk.

### 23. Playground user agent metadata gaps

**Trigger**: `curl http://localhost:5200/api/agents | jq '.agents[] | select(.id == "echo")'`

**Expect**:
- `summary: ""` (metadata doesn't carry this yet)
- `constraints: ""` (metadata doesn't carry this yet)
- `examples: []` (metadata doesn't carry this yet)
- `inputSchema: null`, `outputSchema: null`
- `requiredConfig: []`, `optionalConfig: []`

**If broken**: Not a bug — these fields are empty because the Python SDK metadata
schema doesn't include them. Documented for awareness.

---

## Section 7: Gunshi CLI Migration

Covers risks from the yargs → gunshi migration of `agent list`, `agent describe`,
and `agent build`. Business logic is unchanged — these test the command wrapper.

### 24. CLI alias routing — `ag ls` works

**Trigger**: Run `deno task atlas ag ls --json`

**Expect**:
- Same output as `deno task atlas agent list --json`
- JSON output with `agents` array (user agents if no workspace context, or
  workspace agents if in a workspace directory)
- No "unknown command" or routing error

**If broken**: Check `apps/atlas-cli/src/cli.ts` — `ag` must be in
`NATIVE_COMMANDS` and registered as `ag: agentCommand` in gunshi subCommands.
Check `apps/atlas-cli/src/cli/commands/agent/index.ts` — `ls: listCommand` alias.

### 25. CLI alias routing — `agent b` works

**Trigger**: Run `deno task atlas agent b packages/sdk-python/tests/fixtures/echo-agent`

**Expect**:
- Build succeeds (same as Case 1)
- `b` alias routes to `buildCommand`

**If broken**: Check `index.ts` — `b: buildCommand` alias registration.

### 26. Build command uses `agent.py` as default entry point

**Trigger**: Run `deno task atlas agent build packages/sdk-python/tests/fixtures/echo-agent`
(no `--entry-point` flag)

**Expect**:
- Build succeeds — finds `agent.py` in the fixture directory (renamed from
  `app.py`)
- If the fixture still has `app.py`, this will fail — confirming the rename
  landed

**If broken**: Check `apps/atlas-cli/src/cli/commands/agent/build.ts` — the
`entry-point` arg default should be `"agent"`. Also check
`packages/workspace/src/agent-builder.ts` — the `entryPoint` fallback in
`buildAgent()` should default to `"agent"`.

### 27. Build `--entry-point` override still works

**Trigger**:
```bash
cp packages/sdk-python/tests/fixtures/echo-agent/agent.py /tmp/custom-entry-test.py
mkdir -p /tmp/custom-entry-workspace
cp /tmp/custom-entry-test.py /tmp/custom-entry-workspace/custom.py
deno task atlas agent build /tmp/custom-entry-workspace --entry-point custom
```

**Expect**:
- Build succeeds using `custom.py` as entry point
- Artifact written to `~/.atlas/agents/echo@1.0.0/`

**Cleanup**: `rm -rf /tmp/custom-entry-workspace /tmp/custom-entry-test.py ~/.atlas/agents/echo@1.0.0`

**If broken**: Check the `--entry-point` arg flows from gunshi `ctx.values` →
`buildAgent({ entryPoint })`. The gunshi default (`"agent"`) should be overridden
by the explicit flag.

### 28. Describe command with `--name` flag

**Trigger**: After building echo agent and with a workspace running:
```bash
deno task atlas agent describe --name echo -w <workspace-name>
```

**Expect**:
- Outputs JSON with agent configuration details
- No error about missing positional argument (yargs used positional `<name>`,
  gunshi uses `--name` / `-n`)

**If broken**: Check `apps/atlas-cli/src/cli/commands/agent/describe.ts` — the
`name` arg must be `required: true` with `short: "n"`. The runtime guard
`if (!name)` handles the gunshi type gap.

---

## Section 8: Build API Endpoint

Covers `POST /api/agents/build` — server-side build for Docker users, tested
against local daemon.

### 29. Build agent via API — happy path

**Trigger**:
```bash
curl -s -X POST http://localhost:8080/api/agents/build \
  -F "files=@packages/sdk-python/tests/fixtures/echo-agent/agent.py" \
  | jq .
```

**Expect**:
```json
{
  "ok": true,
  "agent": {
    "id": "echo",
    "version": "1.0.0",
    "description": "Echoes input",
    "path": "<atlas-home>/agents/echo@1.0.0"
  }
}
```

**If broken**: Check `apps/atlasd/routes/agents/build.ts` — the endpoint writes
files to a temp dir, calls `buildAgent()`, returns the result. Check daemon logs:
`deno task atlas logs --since 30s --level error`. Verify `componentize-py` and
`jco` are on PATH in the daemon's environment.

### 30. Build agent via API — multiple files

**Trigger**:
```bash
curl -s -X POST http://localhost:8080/api/agents/build \
  -F "files=@packages/sdk-python/tests/fixtures/echo-agent/agent.py" \
  -F "files=@packages/sdk-python/tests/fixtures/tools-agent/agent.py;filename=helper.py" \
  | jq .
```

**Expect**:
- Returns 200 with built agent (entry point derived from first file: `agent`)
- Both files written to temp dir before build

**If broken**: Check the `files` / `files[]` field handling in the endpoint —
both field names are accepted. Check that `entry_point` defaults to first file's
basename.

### 31. Build API — agent immediately discoverable

**Trigger**:
1. Build via API (Case 29)
2. Immediately query: `deno task atlas agent list --user --json | jq '.agents[] | select(.id == "echo")'`

**Expect**:
- Echo agent appears in the list without daemon restart
- `UserAdapter` scans `~/.atlas/agents/` on every call — no cache to invalidate

**If broken**: Check that `buildAgent()` writes to the correct `ATLAS_HOME` path.
The daemon and CLI share the same `~/.atlas/agents/` directory.

### 32-api. Build API — Python syntax error returns 400

**Trigger**:
```bash
cat > /tmp/syntax-error.py << 'EOF'
from friday_agent_sdk import agent, ok
from friday_agent_sdk._bridge import Agent
@agent(id="broken", version="1.0.0", description="broken")
def execute(prompt, ctx)
    return ok("missing colon")
EOF

curl -s -X POST http://localhost:8080/api/agents/build \
  -F "files=@/tmp/syntax-error.py" \
  | jq .
```

**Expect**:
- Returns HTTP 400 (not 500 — compile errors are user errors)
- `ok: false`, `phase: "compile"`, `error` contains Python syntax error message

**Cleanup**: `rm /tmp/syntax-error.py`

**If broken**: Check `AgentBuildError` phase classification — `compile` phase
errors should map to 400 in the endpoint's catch block.

### 33-api. Build API — missing description returns 400

**Trigger**:
```bash
cat > /tmp/no-desc.py << 'EOF'
from friday_agent_sdk import agent, ok
from friday_agent_sdk._bridge import Agent
@agent(id="bad", version="1.0.0")
def execute(prompt, ctx):
    return ok("no description")
EOF

curl -s -X POST http://localhost:8080/api/agents/build \
  -F "files=@/tmp/no-desc.py" \
  | jq .
```

**Expect**:
- Returns HTTP 400
- `phase: "validate"`, `error` mentions `description`

**Cleanup**: `rm /tmp/no-desc.py`

**If broken**: Check the `validate` phase in `buildAgent()` — Zod schema
validation against `CreateAgentConfigValidationSchema`.

### 34-api. Build API — non-.py file rejected

**Trigger**:
```bash
curl -s -X POST http://localhost:8080/api/agents/build \
  -F "files=@README.md" \
  | jq .
```

**Expect**:
- Returns HTTP 400
- `error` contains "Only .py files are accepted"
- Build pipeline never invoked

**If broken**: Check the `.py` extension validation loop in the endpoint — it
runs before `buildAgent()` is called.

### 35-api. Build API — no files rejected

**Trigger**:
```bash
curl -s -X POST http://localhost:8080/api/agents/build \
  -H "Content-Type: multipart/form-data; boundary=----" \
  --data-binary $'------\r\nContent-Disposition: form-data; name="entry_point"\r\n\r\nagent\r\n--------\r\n' \
  | jq .
```

**Expect**:
- Returns HTTP 400
- `error` contains "At least one Python source file is required"

**If broken**: Check the `files.length === 0` guard in the endpoint.

### 36-api. Build API — custom entry_point

**Trigger**:
```bash
curl -s -X POST http://localhost:8080/api/agents/build \
  -F "files=@packages/sdk-python/tests/fixtures/echo-agent/agent.py;filename=my_app.py" \
  -F "entry_point=my_app" \
  | jq .
```

**Expect**:
- Returns 200 — builds successfully using `my_app` as entry point
- The `entry_point` form field overrides the filename-derived default

**If broken**: Check the `entry_point` field extraction from formData and its
flow to `buildAgent({ entryPoint })`.

---

## Smoke Candidates

These cases are durable enough for the smoke matrix:

- **Case 1** (build echo agent) — validates the entire compile pipeline
- **Case 6** (API discovery) — validates adapter + registry integration
- **Case 11** (playground execution) — validates end-to-end WASM execution
- **Case 15** (workspace signal execution) — validates daemon-side code agent
  routing
- **Case 17** (missing agent 404) — validates error path doesn't crash
- **Case 24** (CLI alias routing) — validates gunshi migration didn't break
  routing
- **Case 29** (build via API) — validates server-side build pipeline end-to-end
