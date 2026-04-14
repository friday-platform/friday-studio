# Session Summaries + Logs

After firing a signal, the question is: did it succeed, what did the agents
do, any errors? This file covers the answer surface.

## Session summary — `GET /api/sessions/:id`

Returns `SessionView`:

```ts
{
  sessionId: string
  workspaceId: string
  jobName: string                // signal name that triggered it
  task: string                   // top-level task description
  status: "active" | "completed" | "failed" | "skipped"
  startedAt: string              // ISO 8601
  completedAt?: string           // ISO 8601 (present when finalized)
  durationMs?: number
  agentBlocks: AgentBlock[]
  results?: Record<string, unknown>   // structured output keyed by agentName
  error?: string                 // session-level error if status=failed
  aiSummary?: {
    summary: string              // 1-2 sentence AI-generated summary
    keyDetails: Array<{
      label: string              // e.g. "Notion Page", "Tickets Found"
      value: string
      url?: string               // clickable URL when applicable
    }>
  }
}
```

**`aiSummary` is gold for the flywheel** — it's a condensed human-readable
readout populated after finalization. Autopilot should prefer this over
walking `agentBlocks` whenever it's present.

### AgentBlock shape

```ts
{
  stepNumber?: number            // set when step:start fires
  agentName: string
  stateId?: string               // FSM state identifier
  actionType: "agent" | "llm"
  task: string
  input?: Record<string, unknown>
  status: "pending" | "running" | "completed" | "failed" | "skipped"
  startedAt?: string
  durationMs?: number
  toolCalls: Array<{
    toolName: string
    args: unknown
    result?: unknown
    durationMs?: number
  }>
  reasoning?: string
  output: unknown                // structured output
  artifactRefs?: unknown[]
  error?: string                 // agent-level error
  ephemeral?: AtlasUIMessageChunk[]
}
```

### Status value cheat sheet

| Level | Values |
|---|---|
| Session | `active`, `completed`, `failed`, `skipped` |
| Agent block | `pending`, `running`, `completed`, `failed`, `skipped` |

Note: session-level uses `active` (NOT `running`). Agent-block-level uses
`running`. Different enums, easy to mix up when filtering with `jq`.

### No token counts

LLM token usage is NOT in session events. If you need token counts, read
the logs (LLM calls are logged with usage metadata by @atlas/logger).

## CLI

### `atlas session get <id>`

Default: Ink-formatted human output with status badge, workspace, signal,
timestamps, duration, agent list, error block, context.

```bash
deno task atlas session get <id>          # human
deno task atlas session get <id> --json   # full SessionView
```

### `atlas session list`

```bash
deno task atlas session list --json
# Filter to active (NOT "running"):
deno task atlas session list --json | jq '[.[]|select(.status=="active")]'
```

## Recipes — did my signal succeed?

### Bash check after triggering a signal

```bash
# 1. Fire signal, capture sessionId
RESP=$(curl -s -X POST http://localhost:8080/api/workspaces/$WS_ID/signals/$SIG \
  -H 'Content-Type: application/json' \
  -d '{"payload":{}}')
SID=$(echo "$RESP" | jq -r '.sessionId')

# 2. Wait for completion (poll or stream — streaming covered below)
while true; do
  STATUS=$(curl -s http://localhost:8080/api/sessions/$SID | jq -r '.status')
  [ "$STATUS" != "active" ] && break
  sleep 2
done

# 3. Read summary
curl -s http://localhost:8080/api/sessions/$SID | jq '{
  status,
  durationMs,
  error,
  summary: .aiSummary.summary,
  details: .aiSummary.keyDetails,
  failedAgents: [.agentBlocks[] | select(.status=="failed") | {agent: .agentName, error}]
}'
```

### Extract failure info

```bash
curl -s http://localhost:8080/api/sessions/$SID | jq '
  if .status == "failed" then
    {
      sessionError: .error,
      agentFailures: [.agentBlocks[] | select(.error) | {
        agent: .agentName,
        stateId,
        error,
        lastToolCall: (.toolCalls | last)
      }]
    }
  else
    { ok: true }
  end'
```

### Tool call inventory across session

```bash
curl -s http://localhost:8080/api/sessions/$SID | jq '
  [.agentBlocks[] | .toolCalls[] | {agent: input_filename, tool: .toolName, durMs: .durationMs}]'
```

## Session events SSE — `GET /api/sessions/:id/stream`

Replay + live stream. For active sessions: replays buffered events then
streams live until finalization. For finalized sessions still in registry:
replays then closes. For sessions dropped from registry: 404 (fall back to
`GET /api/sessions/:id`).

### Durable event types

Format: `data: <JSON>\n\n`

- **`session:start`** — `{sessionId, workspaceId, jobName, task, plannedSteps?, timestamp}`
- **`step:start`** — `{sessionId, stepNumber, agentName, stateId?, actionType, task, input?, timestamp}`
- **`step:complete`** — `{sessionId, stepNumber, status, durationMs, toolCalls, reasoning?, output, artifactRefs?, error?, timestamp}`
- **`step:skipped`** — `{sessionId, stateId, timestamp}`
- **`session:complete`** — `{sessionId, status, durationMs, error?, timestamp}`
- **`session:summary`** — `{summary, keyDetails, timestamp}` (the `aiSummary` arrives as its own event)

### Ephemeral events

Format: `event: ephemeral\ndata: <JSON>\n\n`

Payload: `{stepNumber, chunk: AtlasUIMessageChunk}` — text deltas, tool call
progress. Not buffered, not persisted. Lost if no live subscriber.

For polling (not streaming), `step:complete` events give you the same
information the `agentBlocks[]` array does in the final summary.

## Logs

**Location**: `~/.atlas/logs/global.log` + `~/.atlas/logs/workspaces/<workspaceId>.log`

**Format**: NDJSON. One JSON object per line:

```ts
{
  timestamp: string          // ISO 8601
  level: "trace" | "debug" | "info" | "warn" | "error" | "fatal"
  message: string
  context: {
    workspaceId?: string
    sessionId?: string
    agentId?: string
    chatId?: string          // synonym for streamId
    streamId?: string
    error?: { name, message, stack?, cause? }
    [key: string]: unknown
  }
  stack_trace?: string
}
```

**Correlation**: `sessionId` links entries across global.log and workspace
logs. `chatId` and `streamId` are synonyms — prefer `streamId` per the
`debugging-friday` skill.

**No HTTP endpoint** — logs are file-system only. The CLI reads the files
directly. To fetch logs programmatically, read the NDJSON files yourself.

### CLI flags — `atlas logs`

```bash
--since <duration>       # 30s, 5m, 1h
--level <csv>            # debug,info,warn,error
--chat <chatId>          # resolves to workspaceId
--session <sessionId>    # resolves to workspaceId
--workspace <id|name>
--human                  # human format (NOT parseable — debug only)
```

Without a workspace filter: reads all files, merges, sorts by timestamp.
Chat/session/workspace filters are mutually exclusive — each resolves to one
workspace log file.

### When to use this skill vs `debugging-friday`

Use **this skill** (friday-cli) to:
- Check if a session succeeded
- Extract the summary + failure reasons
- Grep logs for a specific sessionId or chatId

Use **`debugging-friday`** skill when:
- The session succeeded but output is wrong (why?)
- Agent's system prompt seems to be missing context
- Correlating across GCS (production logs)
- Multi-hop debugging (signal → job → agent → tool failure)

`debugging-friday` owns the forensics playbook. This skill is for the "did
it work, what happened at a glance" case.
