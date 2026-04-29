# Flywheel Recipes

End-to-end patterns for driving Friday via CLI + HTTP. Copy + adapt.

## Create workspace from yaml → fire smoke signal

```bash
# 1. Convert yaml to json config
CONFIG=$(python3 -c "import yaml,json; print(json.dumps(yaml.safe_load(open('workspaces/my-thing/workspace.yml'))))")

# 2. Create. Capture workspaceId.
RESP=$(curl -s -X POST http://localhost:8080/api/workspaces/create \
  -H 'Content-Type: application/json' \
  -d "{\"config\":$CONFIG,\"workspaceName\":\"My Thing\"}")
WS_ID=$(echo "$RESP" | jq -r '.workspaceId')
echo "Created: $WS_ID"

# 3. Inspect signals.
curl -s http://localhost:8080/api/workspaces/$WS_ID/signals | jq '.signals[].id'

# 4. Fire smoke signal, stream events.
curl -N -X POST http://localhost:8080/api/workspaces/$WS_ID/signals/smoke-test \
  -H 'Content-Type: application/json' \
  -H 'Accept: text/event-stream' \
  -d '{"payload":{}}'
```

Workspace ID is runtime-assigned. Do not hardcode across machines.

## Register existing workspace dir

```bash
deno task atlas workspace add -p ./workspaces/my-thing
deno task atlas workspace list --json | jq '.[] | select(.name=="My Thing")'
```

## Update signal cron schedule without rewriting workspace.yml

```bash
curl -s -X PATCH http://localhost:8080/api/workspaces/$WS_ID/config/signals/autopilot-tick-cron \
  -H 'Content-Type: application/json' \
  -d '{"config":{"schedule":"*/5 * * * *","timezone":"America/Los_Angeles"}}'
```

Writes workspace.yml directly. Destroys active runtime (reboots on next
signal).

## Update agent prompt

```bash
curl -s -X PUT http://localhost:8080/api/workspaces/$WS_ID/config/agents/autopilot-planner \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"New prompt text here."}'
```

Mutates workspace.yml directly.

## Swap credential for an agent env var

```bash
# Find cred refs:
curl -s http://localhost:8080/api/workspaces/$WS_ID/config/credentials | jq

# Swap:
curl -s -X PUT http://localhost:8080/api/workspaces/$WS_ID/config/credentials/agent:gh-agent:GITHUB_TOKEN \
  -H 'Content-Type: application/json' \
  -d '{"credentialId":"cred_abc123"}'
```

Path format: `agent:<agent_id>:<ENV>` or `mcp:<server_id>:<ENV>`. 400 if
provider mismatch.

## Fire signal + watch session end-to-end

```bash
# CLI one-shot:
deno task atlas signal trigger -n cross-session-reflect -w autopilot \
  --data '{}' --stream
```

HTTP version w/ session tracking:

```bash
RESP=$(curl -s -X POST http://localhost:8080/api/workspaces/$WS_ID/signals/cross-session-reflect \
  -H 'Content-Type: application/json' \
  -d '{"payload":{}}')
SESSION=$(echo "$RESP" | jq -r '.sessionId')

# Replay + live stream:
curl -N http://localhost:8080/api/sessions/$SESSION/stream \
  -H 'Accept: text/event-stream'
```

## Read narrative memory (autopilot backlog pattern)

```bash
curl -s "http://localhost:8080/api/memory/$WS_ID/narrative/autopilot-backlog?since=24h&limit=50" | jq
```

Returns `NarrativeEntry[]`. Empty array on failure (check daemon logs).

## Cancel stuck session

```bash
# Find running:
SID=$(deno task atlas session list --json | jq -r '[.[]|select(.status=="active")][0].id')
[ -n "$SID" ] && deno task atlas session cancel "$SID" --yes
```

## Publish updated skill

```bash
deno task atlas skill publish -p ./packages/skills/fast-self-modification
# or by name override:
deno task atlas skill publish -p . --name @tempest/my-skill
```

Returns new version. Skill version auto-increments.

## Assign skill to workspace (scoping)

```bash
SKILL_ID=$(curl -s 'http://localhost:8080/api/skills?namespace=tempest' | jq -r '.skills[]|select(.name=="my-skill")|.id')

curl -s -X POST http://localhost:8080/api/skills/scoping/$SKILL_ID/assignments \
  -H 'Content-Type: application/json' \
  -d "{\"workspaceIds\":[\"$WS_ID\"]}"
```

## Build + register user agent

**Full authoring workflow: use the `writing-friday-agents` skill (shipped
with the agent-sdk repo).**
It covers `@agent` decorator, `ctx.*` APIs, `ok()`/`err()`, JSON Schema strict
mode gotchas, and file structure.

Build step once agent.py ready:

```bash
deno task atlas agent build ./agents/my-new-agent --sdk-path /path/to/agent-sdk
```

Writes to `~/.atlas/agents/`. Daemon auto-registers on next restart when
`AGENT_SOURCE_DIR` points at source dir.

Register without restart via HTTP:

```bash
# Multipart: upload source files, daemon builds + reloads registry.
curl -X POST http://localhost:8080/api/agents/build \
  -F "files=@agents/my-new-agent/agent.py" \
  -F "entry_point=agent"
```

## Update env vars in daemon config

```bash
curl -X PUT http://localhost:8080/api/config/env \
  -H 'Content-Type: application/json' \
  -d '{"envVars":{"ANTHROPIC_API_KEY":"sk-...","GITHUB_TOKEN":"ghp_..."}}'
```

Writes to `~/.atlas/.env`. Daemon picks up on next restart.

## Send a prompt + follow up

```bash
OUT=$(deno task atlas prompt "do the thing")
CHAT=$(echo "$OUT" | jq -r 'select(.type=="cli-summary") | .chatId')
deno task atlas prompt --chat "$CHAT" "now do the next thing"

# Inspect full transcript:
deno task atlas chat "$CHAT" --human --show-prompts
```

`--show-prompts` reveals system messages (workspace context, datetime,
scratchpad). Critical for "why did agent do X" debugging.

## Delete workspace (hard)

```bash
# Verify first:
deno task atlas workspace status -w $WS_ID --json

# Delete directory + registration:
curl -X DELETE http://localhost:8080/api/workspaces/$WS_ID
```

403 on system workspace. Userland vanishes silently.

## Export workspace as tarball (backup)

```bash
curl -s http://localhost:8080/api/workspaces/$WS_ID/export > /tmp/$WS_ID.tar
```

workspace.yml + resource data. Restore via unpack + `workspace add`.

## Check daemon before automating

```bash
deno task atlas daemon status || deno task atlas daemon start --detached
# or pure HTTP:
curl -sf http://localhost:8080/health > /dev/null || echo "daemon down"
```

## SSE event shapes (for parsers)

```
data: {"type":"data-agent-block-start","data":{"agentName":"planner"}}
data: {"type":"data-text-delta","data":{"text":"..."}}
data: {"type":"data-tool-call","data":{"name":"fs_read_file","args":{...}}}
data: {"type":"job-complete","data":{"success":true,"sessionId":"...","status":"completed"}}
data: [DONE]
```

Final line is literal `data: [DONE]`, not JSON.

## Autopilot flywheel pattern (putting it together)

1. Author / update workspace.yml locally.
2. Create via `POST /api/workspaces/create` (new) or partial-update endpoints
   (existing).
3. Fire smoke signal, stream SSE, confirm `job-complete` with
   `success: true`.
4. If failure → inspect `GET /api/sessions/:id` + `atlas logs --session <id>`.
5. Fix workspace.yml or agent prompt → partial-update endpoint.
6. Re-fire signal.
7. Once stable, attach cron signal (`provider: cron` with schedule), or let
   autopilot-tick-cron pick it up from backlog narrative memory.

Full loop without CLI restarts. Every mutation is either reversible (sessions,
chats) or gated (partial-config writes destroy runtime but preserve yaml).
