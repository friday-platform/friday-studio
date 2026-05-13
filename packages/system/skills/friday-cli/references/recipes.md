# Flywheel Recipes

End-to-end patterns for driving Friday via CLI + HTTP. Copy + adapt.

> **Preamble — source the daemon env once per shell.** Every curl-like
> example below uses `$FRIDAYD_URL` and an injected `--cacert` flag (needed
> when TLS is on). Paste this once and the examples below work as-is on
> both plain-HTTP and TLS-enabled installs:
>
> ```bash
> set -a; [ -f ~/.atlas/.env ] && . ~/.atlas/.env; set +a
> # Wrapper that adds --cacert exactly when TLS is on. Use in place of `curl`.
> friday_curl() { curl ${FRIDAY_TLS_CA:+--cacert "$FRIDAY_TLS_CA"} "$@"; }
> ```
>
> See the `friday-cli` SKILL.md "Daemon URL" section for the full
> explanation.

## Contents

- Create workspace from yaml → fire smoke signal
- Register existing workspace dir
- Update signal cron schedule without rewriting workspace.yml
- Update agent prompt
- Swap credential for an agent env var
- Fire signal + watch session end-to-end
- Read narrative memory (autopilot backlog pattern)
- Cancel stuck session
- Publish updated skill
- Assign skill to workspace (scoping)
- Deploy + register SDK agent
- Update env vars in daemon config
- Send a prompt + follow up
- Delete workspace (hard)
- Export workspace as tarball (backup)
- Check daemon before automating
- SSE event shapes (for parsers)
- Autopilot flywheel pattern (putting it together)

## Create workspace from yaml → fire smoke signal

```bash
# 1. Convert yaml to json config
CONFIG=$(python3 -c "import yaml,json; print(json.dumps(yaml.safe_load(open('workspaces/my-thing/workspace.yml'))))")

# 2. Create. Capture workspaceId.
RESP=$(friday_curl -s -X POST "$FRIDAYD_URL"/api/workspaces/create \
  -H 'Content-Type: application/json' \
  -d "{\"config\":$CONFIG,\"workspaceName\":\"My Thing\"}")
WS_ID=$(echo "$RESP" | jq -r '.workspaceId')
echo "Created: $WS_ID"

# 3. Inspect signals.
friday_curl -s "$FRIDAYD_URL"/api/workspaces/$WS_ID/signals | jq '.signals[].id'

# 4. Fire smoke signal, stream events.
friday_curl -N -X POST "$FRIDAYD_URL"/api/workspaces/$WS_ID/signals/smoke-test \
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
friday_curl -s -X PATCH "$FRIDAYD_URL"/api/workspaces/$WS_ID/config/signals/autopilot-tick-cron \
  -H 'Content-Type: application/json' \
  -d '{"config":{"schedule":"*/5 * * * *","timezone":"America/Los_Angeles"}}'
```

Writes workspace.yml directly. Destroys active runtime (reboots on next
signal).

## Update agent prompt

```bash
friday_curl -s -X PUT "$FRIDAYD_URL"/api/workspaces/$WS_ID/config/agents/autopilot-planner \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"New prompt text here."}'
```

Mutates workspace.yml directly.

## Swap credential for an agent env var

```bash
# Find cred refs:
friday_curl -s "$FRIDAYD_URL"/api/workspaces/$WS_ID/config/credentials | jq

# Swap:
friday_curl -s -X PUT "$FRIDAYD_URL"/api/workspaces/$WS_ID/config/credentials/agent:gh-agent:GITHUB_TOKEN \
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
RESP=$(friday_curl -s -X POST "$FRIDAYD_URL"/api/workspaces/$WS_ID/signals/cross-session-reflect \
  -H 'Content-Type: application/json' \
  -d '{"payload":{}}')
SESSION=$(echo "$RESP" | jq -r '.sessionId')

# Replay + live stream:
friday_curl -N "$FRIDAYD_URL"/api/sessions/$SESSION/stream \
  -H 'Accept: text/event-stream'
```

## Read narrative memory (autopilot backlog pattern)

```bash
friday_curl -s "$FRIDAYD_URL/api/memory/$WS_ID/narrative/autopilot-backlog?since=24h&limit=50" | jq
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
# From the skill's directory:
deno task atlas skill publish -p .
# or with an explicit name:
deno task atlas skill publish -p . --name @tempest/my-skill
```

Returns new version. Skill version auto-increments.

## Assign skill to workspace (scoping)

```bash
SKILL_ID=$(friday_curl -s "$FRIDAYD_URL/api/skills?namespace=tempest" | jq -r '.skills[]|select(.name=="my-skill")|.id')

friday_curl -s -X POST "$FRIDAYD_URL"/api/skills/scoping/$SKILL_ID/assignments \
  -H 'Content-Type: application/json' \
  -d "{\"workspaceIds\":[\"$WS_ID\"]}"
```

## Deploy + register SDK agent

An SDK agent is a NATS client — any language that can connect to NATS and speak
the request/reply protocol. The Python SDK (`friday_agent_sdk`) is the current
reference implementation.

**Full authoring workflow: use the `writing-friday-python-agents` skill.**

Register via HTTP (no build step — agent process is spawned per invocation):

```bash
friday_curl -X POST "$FRIDAYD_URL"/api/agents/register \
  -H 'Content-Type: application/json' \
  -d '{"entrypoint": "/abs/path/to/agents/my-new-agent/agent.py"}'
```

`entrypoint` must be an absolute path. The daemon spawns it with `FRIDAY_VALIDATE_ID`,
collects metadata over NATS, and installs the source under
`~/.friday/local/agents/{id}@{version}/`.

## Update env vars in daemon config

```bash
friday_curl -X PUT "$FRIDAYD_URL"/api/config/env \
  -H 'Content-Type: application/json' \
  -d '{"envVars":{"ANTHROPIC_API_KEY":"sk-...","GITHUB_TOKEN":"ghp_..."}}'
```

Writes to `~/.friday/local/.env`. Daemon picks up on next restart.

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
friday_curl -X DELETE "$FRIDAYD_URL"/api/workspaces/$WS_ID
```

403 on system workspace. Userland vanishes silently.

## Export workspace as tarball (backup)

```bash
friday_curl -s "$FRIDAYD_URL"/api/workspaces/$WS_ID/export > /tmp/$WS_ID.tar
```

workspace.yml + resource data. Restore via unpack + `workspace add`.

## Check daemon before automating

```bash
deno task atlas daemon status || deno task atlas daemon start --detached
# or pure HTTP:
friday_curl -sf "$FRIDAYD_URL"/health > /dev/null || echo "daemon down"
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
