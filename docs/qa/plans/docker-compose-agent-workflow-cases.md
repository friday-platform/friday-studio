# QA Plan: Docker-Compose Agent Developer Workflow

**Context**: [Agent SDK Developer Workflow Design](../../plans/2026-04-07-agent-sdk-developer-workflow-design.md)
**Branch**: `yaml-custom-agents`
**Date**: 2026-04-07

## Prerequisites

- Docker and docker-compose installed
- **Local image build required** — the published registry images don't include
  the agent build toolchain yet. Build from the current branch:
  ```bash
  docker build -f Dockerfile-platform -t atlas-platform:local .
  ```
  Then run with the local image (docker-compose.yml is pre-configured for this):
  ```bash
  docker compose up -d
  ```
- Platform healthy: `curl -sf http://localhost:18080/health`
- No prior agent builds in the container (clean `atlas-data` volume — run
  `docker compose down -v && docker compose up -d` for clean slate)
- Echo agent fixture available at
  `packages/sdk-python/tests/fixtures/echo-agent/agent.py`
- Tools-agent fixture available at
  `packages/sdk-python/tests/fixtures/tools-agent/agent.py`

## Ports Reference

| Service | Host Port | Container Port |
|---------|-----------|----------------|
| Daemon API | 18080 | 8080 |
| Link (auth) | 13100 | 3100 |
| Playground UI | 15200 | 5200 |
| PTY server | 17681 | 7681 |
| Webhook tunnel | 19090 | 9090 |

---

## Phase 1: Smoke — Platform & Build API

Proves the container boots with the right tools and the build API is reachable.

### 1. Platform health check

**Trigger**:
```bash
curl -sf http://localhost:18080/health
```

**Expect**:
- Returns 200
- All services healthy (daemon, link, PTY, tunnel)

**If broken**: `docker compose logs platform` — check for startup failures,
port conflicts, or missing env vars. Verify `docker compose ps` shows the
container running.

### 2. Build prerequisites available in container

**Trigger**:
```bash
docker compose exec platform componentize-py --version
docker compose exec platform jco --version
```

**Expect**:
- `componentize-py` reports version 0.22.0
- `jco` reports version 1.16.1

**If broken**: Check `Dockerfile-platform` — the tool installation stage. The
image may have been built from a branch before these were added. Pull latest:
`docker compose pull`.

### 3. SDK baked into container

**Trigger**:
```bash
docker compose exec platform ls /opt/friday-agent-sdk/
docker compose exec platform ls /opt/friday-agent-sdk/wit/
```

**Expect**:
- `/opt/friday-agent-sdk/friday_agent_sdk/` directory exists with Python files
- `/opt/friday-agent-sdk/wit/agent.wit` exists

**If broken**: Check `Dockerfile-platform` COPY stages for the SDK. The builder
stage must successfully build `packages/sdk-python/` before the copy.

### 4. Build echo agent via API — happy path

**Trigger**:
```bash
curl -s -X POST http://localhost:18080/api/agents/build \
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
    "path": "/data/atlas/agents/echo@1.0.0"
  }
}
```

**If broken**: Check daemon logs: `docker compose logs platform --tail 50`.
Common failures:
- `componentize-py` not found → Case 2 should have caught this
- SDK path wrong → verify `/opt/friday-agent-sdk` exists (Case 3)
- Permission errors → check `/data/atlas/agents/` is writable

### 5. Built agent discoverable via API

**Trigger**:
```bash
curl -s http://localhost:18080/api/agents | jq '.agents[] | select(.id == "echo")'
```

**Expect**:
- Returns JSON object with `id: "echo"`, `version: "1.0.0"`,
  `description: "Echoes input"`
- Agent appears immediately after build (no restart needed)

**If broken**: Check `UserAdapter` scans `/data/atlas/agents/` (controlled by
`ATLAS_HOME=/data/atlas`). Verify the built artifact exists:
`docker compose exec platform ls /data/atlas/agents/echo@1.0.0/`.

---

## Phase 2: Execution — End-to-End Agent Runs

Proves built agents actually execute through playground and workspace runtime.

### 6. Execute echo agent via playground API

**Trigger**:
```bash
curl -s -N -X POST http://localhost:15200/api/execute \
  -H 'Content-Type: application/json' \
  -d '{"agentId": "echo", "input": "hello from docker-compose QA"}'
```

**Expect**:
- SSE stream connects and delivers events
- Result event contains `"hello from docker-compose QA"` (echo behavior)
- No error events in the stream
- Stream terminates cleanly

**If broken**: Check playground logs in `docker compose logs platform`. The
playground's `execute.ts` route checks `userAgentExists(agentId)` then
instantiates `CodeAgentExecutor`. Check for WASM loading errors or JSPI
failures.

### 7. Build and execute tools-agent — host function round-trip

**Trigger**:
```bash
# Build
curl -s -X POST http://localhost:18080/api/agents/build \
  -F "files=@packages/sdk-python/tests/fixtures/tools-agent/agent.py" \
  | jq .

# Execute
curl -s -N -X POST http://localhost:15200/api/execute \
  -H 'Content-Type: application/json' \
  -d '{"agentId": "tools-agent", "input": "test host functions"}'
```

**Expect**:
- Build succeeds with `id: "tools-agent"`
- Execution returns result with `tool_count` field (from `listTools()`)
- Stream events include agent-emitted events (from `streamEmit()`)
- No WASM traps or unhandled errors

**If broken**: This exercises the full JSPI async bridging path. Check the
`globalThis.__fridayCapabilities` trampoline binding. If `callTool` fails,
the playground may not provide the tools the agent expects — check what MCP
tools are available in the playground execution context.

### 8. Agent visible in playground UI

**Trigger**: Navigate to `http://localhost:15200/agents/built-in` in Chrome

**Expect**:
- Agent catalog loads
- Echo agent appears in the list with display name and description
- Clicking echo agent opens the workbench

**If broken**: Check the `/api/agents` endpoint from the playground (port 15200,
not 18080). The playground may have its own agent listing route separate from
the daemon.

### 9. Create workspace with user agent via API

**Trigger**:
```bash
# Create a temp workspace.yml
cat > /tmp/qa-docker-workspace.yml << 'EOF'
version: '1.0'
workspace:
  name: Docker QA Workspace
  description: Tests code agent execution via docker-compose

signals:
  test-echo:
    provider: http
    title: Test Echo
    config:
      path: /webhooks/test-echo
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
  echo-job:
    title: Echo Job
    triggers:
      - signal: test-echo
    fsm:
      id: echo-pipeline
      initial: idle
      states:
        idle:
          'on':
            test-echo:
              target: run_echo
        run_echo:
          entry:
            - type: agent
              agentId: echo
              outputTo: echo-result
              prompt: "Echo this message back"
            - type: emit
              event: DONE
          'on':
            DONE:
              target: completed
        completed:
          type: final
EOF

# Upload workspace
curl -s -X POST http://localhost:18080/api/workspaces \
  -H 'Content-Type: application/json' \
  -d "{\"name\": \"Docker QA Workspace\", \"config\": $(cat /tmp/qa-docker-workspace.yml | python3 -c 'import sys,json,yaml; print(json.dumps(yaml.safe_load(sys.stdin.read())))')}" \
  | jq .
```

Note: workspace creation via API may require a different format than raw YAML.
Check the actual API contract if the above fails — may need to POST the YAML
as a file or use a different endpoint.

**Expect**:
- Workspace is created and returned with an ID
- Workspace config includes the `echo` agent reference

**If broken**: Check `apps/atlasd/routes/` for workspace creation endpoints.
The workspace config schema at `packages/config/src/workspace.ts` validates
the `agents` block — `type: user` must be accepted.

### 10. Trigger agent via workspace signal

**Trigger**:
```bash
# Get workspace ID from previous case
WORKSPACE_ID="<from case 9>"

# Trigger signal
curl -s -X POST "http://localhost:18080/api/workspaces/${WORKSPACE_ID}/signals/test-echo/trigger" \
  -H 'Content-Type: application/json' \
  -d '{"message": "hello from workspace signal"}' \
  | jq .

# Wait a moment, then check sessions
sleep 3
curl -s "http://localhost:18080/api/workspaces/${WORKSPACE_ID}/sessions" | jq '.[0]'
```

Note: Signal trigger and session endpoints may differ — check
`docs/product-map.md` or `apps/atlasd/routes/` for exact paths.

**Expect**:
- Signal triggers a job
- Session is created and reaches `completed` state
- Echo agent executes via `CodeAgentExecutor` inside the container
- Session output contains the echoed content

**If broken**: Check daemon logs: `docker compose logs platform --tail 100`.
The `WorkspaceRuntime` routes `type: user` agents to `executeCodeAgent()`.
If the agent isn't found, `UserAdapter.loadAgent()` failed — verify the agent
is built (Case 4) and discoverable (Case 5).

---

## Phase 2b: Production Agents — Real Workspace Pipelines

Proves the Python SDK agents work as drop-in replacements for the bundled
TypeScript agents in real workspace pipelines. Requires credentials.

### Prerequisites (Phase 2b)

- Phase 1 and Phase 2 cases pass
- Credentials configured in the platform container's environment:
  - `BITBUCKET_EMAIL`, `BITBUCKET_TOKEN` — Bitbucket Cloud access
  - `JIRA_SITE`, `JIRA_EMAIL`, `JIRA_API_TOKEN` — Jira Cloud access
  - `ANTHROPIC_API_KEY` — Claude API access
- Python agent source files from the SDK repo at
  `/Users/ericskram/code/tempest/agent-sdk/packages/python/examples/`
- Test Jira ticket: `DEV-6` at
  `https://insanelygreatteam.atlassian.net/browse/DEV-6`
- Test Bitbucket repo:
  `https://bitbucket.org/insanelygreatteam/google_workspace_mcp`
- Test PR:
  `https://bitbucket.org/insanelygreatteam/google_workspace_mcp/pull-requests/47`

### 2b-1. Build bb agent (Bitbucket operations)

**Trigger**:
```bash
curl -s -X POST http://localhost:18080/api/agents/build \
  -F "files=@/Users/ericskram/code/tempest/agent-sdk/packages/python/examples/bb-agent/agent.py" \
  | jq .
```

**Expect**:
```json
{
  "ok": true,
  "agent": { "id": "bb", "version": "1.0.0", "description": "Bitbucket PR operations agent" }
}
```

**If broken**: This is a large agent (~30KB Python). If componentize-py chokes,
check container memory limits. If validation fails, the `@agent()` decorator
metadata may not match `CreateAgentConfigValidationSchema`.

### 2b-2. Build claude-code agent

**Trigger**:
```bash
curl -s -X POST http://localhost:18080/api/agents/build \
  -F "files=@/Users/ericskram/code/tempest/agent-sdk/packages/python/examples/claude-code-agent/agent.py" \
  | jq .
```

**Expect**:
```json
{
  "ok": true,
  "agent": { "id": "claude-code", "version": "1.0.0", "description": "Execute coding tasks in sandboxed environment via Claude Code SDK" }
}
```

**If broken**: The claude-code agent uses `ctx.llm`, `ctx.http`, and
`ctx.stream`. If build succeeds but metadata validation fails, check the LLM
config fields in the decorator (`provider`, `model`).

### 2b-3. Build jira agent

**Trigger**:
```bash
curl -s -X POST http://localhost:18080/api/agents/build \
  -F "files=@/Users/ericskram/code/tempest/agent-sdk/packages/python/examples/jira-agent/agent.py" \
  | jq .
```

**Expect**:
```json
{
  "ok": true,
  "agent": { "id": "jira", "version": "1.0.0", "description": "Jira issue operations agent" }
}
```

**If broken**: Same as 2b-1. The jira agent uses `ctx.http` and `parse_input`
for structured input extraction.

### 2b-4. All production agents discoverable

**Trigger**:
```bash
curl -s http://localhost:18080/api/agents \
  | jq '[.agents[] | select(.id == "bb" or .id == "claude-code" or .id == "jira") | {id, version}]'
```

**Expect**:
- All three agents appear: `bb`, `claude-code`, `jira`
- Each at version `1.0.0`

**If broken**: If builds succeeded (2b-1 through 2b-3) but agents don't appear,
check `UserAdapter` discovery at `/data/atlas/agents/`.

### 2b-5. PR review workspace — end-to-end with Python agents

Tests the PR review pipeline using Python `bb` and `claude-code` agents
instead of bundled TypeScript agents. This is the `pr-review-bitbucket`
workspace ported from `type: atlas` to `type: user`.

**Trigger**:
1. Create a workspace using the ported config at
   `examples/pr-review-bitbucket-user/workspace.yml` (same as
   `pr-review-bitbucket` but agents use `type: user`):
   ```bash
   # Upload workspace via Studio UI or API
   # The workspace.yml is at examples/pr-review-bitbucket-user/workspace.yml
   ```

2. Trigger the review-pr signal:
   ```bash
   WORKSPACE_ID="<from workspace creation>"
   curl -s -X POST "http://localhost:19090/webhooks/review-pr" \
     -H 'Content-Type: application/json' \
     -d '{"pr_url": "https://bitbucket.org/insanelygreatteam/google_workspace_mcp/pull-requests/47"}'
   ```

3. Monitor session progress:
   ```bash
   # Watch for session completion via sessions API or Studio UI
   ```

**Expect**:
- Signal triggers job, session created
- FSM progresses: idle → step_clone_repo → step_review_pr → step_post_review → completed
- Python `bb` agent clones the repo successfully
- Python `claude-code` agent produces a structured code review
- Python `bb` agent posts inline review comments on the PR
- Session reaches `completed` state

**If broken**:
- Clone step fails → check `bb` agent env vars (`BITBUCKET_EMAIL`,
  `BITBUCKET_TOKEN`) are available in the container
- Review step fails → check `claude-code` agent env var
  (`ANTHROPIC_API_KEY`), check LLM host function binding
- Post-review fails → check the review output shape matches what
  `prepare_post_review` expects. The Python agent output format may differ
  slightly from the TypeScript bundled agent.
- Check `docker compose logs platform --tail 200` for execution errors

### 2b-6. Jira bugfix workspace — end-to-end with Python agents

Tests the Jira bugfix pipeline using Python `jira`, `bb`, and `claude-code`
agents. This is the `jira-bugfix-bitbucket` workspace ported from
`type: atlas` to `type: user`.

**Trigger**:
1. Create a workspace using the ported config at
   `examples/jira-bugfix-bitbucket-user/workspace.yml`

2. Trigger the fix-bug signal:
   ```bash
   curl -s -X POST "http://localhost:19090/webhooks/fix-bug" \
     -H 'Content-Type: application/json' \
     -d '{"issue_key": "DEV-6", "repo_url": "https://bitbucket.org/insanelygreatteam/google_workspace_mcp"}'
   ```

3. Monitor session progress

**Expect**:
- FSM progresses: idle → step_read_ticket → step_clone_repo →
  step_implement_fix → step_push_branch → step_create_pr →
  step_update_ticket → completed
- Python `jira` agent reads the DEV-6 ticket
- Python `bb` agent clones the repo
- Python `claude-code` agent implements a fix
- Python `bb` agent pushes branch and creates PR
- Python `jira` agent comments on the ticket with PR link
- Session reaches `completed` state

**If broken**:
- Ticket read fails → check Jira env vars (`JIRA_SITE`, `JIRA_EMAIL`,
  `JIRA_API_TOKEN`)
- Clone fails → check BB env vars
- Fix implementation fails → check Anthropic key, check the prompt context
  passed by `prepare_implement`
- Push/PR fails → check BB write permissions
- Check `docker compose logs platform --tail 200` for execution errors

---

## Phase 3: Error Paths & Edge Cases

### 11. Build API — Python syntax error returns 400

**Trigger**:
```bash
cat > /tmp/syntax-error.py << 'EOF'
from friday_agent_sdk import agent, ok
from friday_agent_sdk._bridge import Agent
@agent(id="broken", version="1.0.0", description="broken")
def execute(prompt, ctx)
    return ok("missing colon")
EOF

curl -s -X POST http://localhost:18080/api/agents/build \
  -F "files=@/tmp/syntax-error.py" \
  | jq .
```

**Expect**:
- HTTP 400 (not 500 — compile errors are user errors)
- `ok: false`, `phase: "compile"`, `error` contains Python syntax error

**Cleanup**: `rm /tmp/syntax-error.py`

**If broken**: Check `AgentBuildError` phase classification in
`apps/atlasd/routes/agents/build.ts`.

### 12. Build API — missing description returns 400

**Trigger**:
```bash
cat > /tmp/no-desc.py << 'EOF'
from friday_agent_sdk import agent, ok
from friday_agent_sdk._bridge import Agent
@agent(id="bad", version="1.0.0")
def execute(prompt, ctx):
    return ok("no description")
EOF

curl -s -X POST http://localhost:18080/api/agents/build \
  -F "files=@/tmp/no-desc.py" \
  | jq .
```

**Expect**:
- HTTP 400, `phase: "validate"`, `error` mentions `description`

**Cleanup**: `rm /tmp/no-desc.py`

**If broken**: Zod schema validation in the `validate` phase of `buildAgent()`.

### 13. Build API — non-.py file rejected

**Trigger**:
```bash
curl -s -X POST http://localhost:18080/api/agents/build \
  -F "files=@README.md" \
  | jq .
```

**Expect**:
- HTTP 400, `error` contains "Only .py files are accepted"
- Build pipeline never invoked

**If broken**: Check `.py` extension validation in the endpoint.

### 14. Build API — no files rejected

**Trigger**:
```bash
curl -s -X POST http://localhost:18080/api/agents/build \
  -H "Content-Type: multipart/form-data" \
  | jq .
```

**Expect**:
- HTTP 400, `error` contains "At least one Python source file is required"

**If broken**: Check the `files.length === 0` guard in the endpoint.

### 15. Missing agent — playground 404

**Trigger**:
```bash
curl -s -X POST http://localhost:15200/api/execute \
  -H 'Content-Type: application/json' \
  -d '{"agentId": "nonexistent-agent", "input": "test"}' \
  -o /dev/null -w "%{http_code}"
```

**Expect**:
- Returns HTTP 404
- Daemon stays healthy

**If broken**: Check `execute.ts` routing — `userAgentExists` then bundled
agent fallback.

### 16. Agent persistence across container restart

**Trigger**:
```bash
# Confirm echo agent exists (from Case 4)
curl -s http://localhost:18080/api/agents | jq '.agents[] | select(.id == "echo") | .id'

# Restart container
docker compose restart platform

# Wait for health
sleep 10
curl -sf http://localhost:18080/health

# Check agent still exists
curl -s http://localhost:18080/api/agents | jq '.agents[] | select(.id == "echo") | .id'
```

**Expect**:
- Echo agent is present before restart
- After restart + health check, echo agent is still present
- `atlas-data` volume preserved the `/data/atlas/agents/` directory

**If broken**: Check docker-compose volume mount — `atlas-data:/data/atlas`.
If the volume is anonymous or not persisted, agents are lost on restart.

### 17. Rebuild agent with updated metadata

**Trigger**:
```bash
# Create updated agent
cat > /tmp/echo-v2.py << 'EOF'
from friday_agent_sdk import agent, ok
from friday_agent_sdk._bridge import Agent

@agent(id="echo", version="2.0.0", description="Echoes input v2")
def execute(prompt, ctx):
    return ok(f"v2: {prompt}")
EOF

curl -s -X POST http://localhost:18080/api/agents/build \
  -F "files=@/tmp/echo-v2.py;filename=agent.py" \
  | jq .

# Check which version is active
curl -s http://localhost:18080/api/agents | jq '.agents[] | select(.id == "echo") | .version'
```

**Expect**:
- Build succeeds with `version: "2.0.0"`
- Agent list shows version `"2.0.0"` (highest semver wins)
- Both `echo@1.0.0` and `echo@2.0.0` exist on disk inside container

**Cleanup**: `rm /tmp/echo-v2.py`

**If broken**: Check `UserAdapter.listAgents()` semver resolution — groups by
agent ID, picks highest version.

### 18. Build API — custom entry_point

**Trigger**:
```bash
curl -s -X POST http://localhost:18080/api/agents/build \
  -F "files=@packages/sdk-python/tests/fixtures/echo-agent/agent.py;filename=my_app.py" \
  -F "entry_point=my_app" \
  | jq .
```

**Expect**:
- Build succeeds — `entry_point` override is respected
- Agent metadata extracted correctly

**If broken**: Check `entry_point` field extraction from formData in the
endpoint and its flow to `buildAgent({ entryPoint })`.

---

## Phase 4: Parity & Discovery Edge Cases

### 19. Agent catalog in playground UI shows user agents

**Trigger**: Navigate to `http://localhost:15200/agents/built-in` in Chrome

**Expect**:
- Both bundled and user agents appear
- Echo agent (and tools-agent if built) in the list
- Display names and descriptions render correctly

**If broken**: Playground's `/api/agents` route may differ from daemon's. Check
`tools/agent-playground/src/lib/server/routes/agents.ts`.

### 20. Execute echo agent from playground workbench UI

**Trigger**:
1. Navigate to `http://localhost:15200/agents/built-in/echo`
2. Type `"hello from playground"` in the input
3. Click execute

**Expect**:
- SSE stream delivers events to the UI
- Result displays containing `"hello from playground"`
- No error states

**If broken**: Check browser console for SSE connection errors. Check
`docker compose logs platform` for execution errors.

### 21. Version resolution — latest semver wins

**Trigger**:
```bash
# Build v1 (may exist from Case 4)
curl -s -X POST http://localhost:18080/api/agents/build \
  -F "files=@packages/sdk-python/tests/fixtures/echo-agent/agent.py" \
  | jq .version

# Build v2
cat > /tmp/echo-v3.py << 'EOF'
from friday_agent_sdk import agent, ok
from friday_agent_sdk._bridge import Agent

@agent(id="echo", version="3.0.0", description="Echoes input v3")
def execute(prompt, ctx):
    return ok(f"v3: {prompt}")
EOF

curl -s -X POST http://localhost:18080/api/agents/build \
  -F "files=@/tmp/echo-v3.py;filename=agent.py" \
  | jq .

# Query
curl -s http://localhost:18080/api/agents | jq '.agents[] | select(.id == "echo")'
```

**Expect**:
- Only one echo agent in the list (not multiple)
- Version is `"3.0.0"` (highest semver)
- Both versions exist on disk inside container

**Cleanup**: `rm /tmp/echo-v3.py`

**If broken**: Check `UserAdapter.listAgents()` grouping and semver comparison.

### 22. .tmp directories ignored during discovery

**Trigger**:
```bash
docker compose exec platform mkdir -p /data/atlas/agents/fake@0.1.0.tmp
docker compose exec platform sh -c 'echo "{\"id\":\"fake\",\"version\":\"0.1.0\",\"description\":\"ghost\"}" > /data/atlas/agents/fake@0.1.0.tmp/metadata.json'

curl -s http://localhost:18080/api/agents | jq '.agents[] | select(.id == "fake")'
```

**Expect**:
- No `fake` agent in results — `.tmp` suffix directories are filtered

**Cleanup**: `docker compose exec platform rm -rf /data/atlas/agents/fake@0.1.0.tmp`

**If broken**: Check directory scan filter in `UserAdapter.listAgents()`.

### 23. Agent metadata gaps — expected empty fields

**Trigger**:
```bash
curl -s http://localhost:18080/api/agents | jq '.agents[] | select(.id == "echo")'
```

**Expect**:
- `summary` is empty string or absent
- `constraints` is empty string or absent
- `examples` is `[]` or absent
- `inputSchema` and `outputSchema` are `null` or absent
- This is expected — Python SDK metadata doesn't include these yet

**If broken**: Not a bug — documenting expected gaps for awareness.

### 24. Multiple agents coexist

**Trigger**:
```bash
# Build echo (may exist)
curl -s -X POST http://localhost:18080/api/agents/build \
  -F "files=@packages/sdk-python/tests/fixtures/echo-agent/agent.py" \
  | jq .agent.id

# Build tools-agent (may exist)
curl -s -X POST http://localhost:18080/api/agents/build \
  -F "files=@packages/sdk-python/tests/fixtures/tools-agent/agent.py" \
  | jq .agent.id

# List all
curl -s http://localhost:18080/api/agents | jq '[.agents[] | select(.id == "echo" or .id == "tools-agent") | .id]'
```

**Expect**:
- Both `echo` and `tools-agent` appear in agent list
- Each has correct metadata
- No interference between agents

**If broken**: Check `UserAdapter` scans all subdirectories, not just the first.

### 25. Volume teardown and clean rebuild

**Trigger**:
```bash
docker compose down -v
docker compose up -d

# Wait for health
sleep 15
curl -sf http://localhost:18080/health

# Verify clean slate
curl -s http://localhost:18080/api/agents | jq '.agents | length'

# Build fresh
curl -s -X POST http://localhost:18080/api/agents/build \
  -F "files=@packages/sdk-python/tests/fixtures/echo-agent/agent.py" \
  | jq .
```

**Expect**:
- After volume teardown, no user agents exist (bundled agents may still appear)
- Fresh build succeeds on clean volume
- Agent immediately discoverable

**If broken**: Check that `ATLAS_HOME=/data/atlas` and the `atlas-data` volume
are correctly configured. The `/data/atlas/agents/` directory is created on
first build.

---

## Smoke Candidates

These cases are durable enough for the smoke matrix:

- **Case 1** (health check) — platform boots correctly
- **Case 4** (build echo via API) — full compile pipeline in container
- **Case 5** (agent discoverable) — adapter + registry in container context
- **Case 6** (playground execution) — end-to-end WASM execution
- **Case 2b-1** (build bb agent) — production-size agent compiles in container
- **Case 2b-5** (PR review e2e) — full workspace pipeline with user agents
- **Case 16** (persistence across restart) — volume durability
