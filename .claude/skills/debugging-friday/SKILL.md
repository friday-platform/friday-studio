---
name: debugging-friday
description: Use when debugging Friday agent behavior with a user - covers local debugging with atlas CLI and remote debugging via GCS logs.
compatibility: Requires gcloud CLI configured for GCS queries
---

# Friday Debugging

## Prerequisites

**Local:** Daemon running (`deno task atlas daemon start`)

**GCS:** gcloud CLI authenticated and configured

## Local Debugging

### Commands

- `deno task atlas logs --since 30s` - recent logs (JSON lines)
- `deno task atlas logs --level error,warn` - filter by level
- `deno task atlas logs --chat <id>` - filter by chat ID
- `deno task atlas logs --session <id>` - filter by session ID
- `deno task atlas logs --human` - human-readable (debugging only)
- `deno task atlas chat <id>` - view chat transcript (JSON lines)
- `deno task atlas chat <id> --human` - human-readable transcript
- `deno task atlas chat <id> --show-prompts` - view system prompt sent to LLM
- `deno task atlas chat <id> --show-prompts --human` - human-readable system
  prompt

### Workflow

```bash
# Start daemon
deno task atlas daemon start --detached
# make changes (daemon auto-restarts)
deno task atlas prompt "test artifact extraction"
# if issues:
deno task atlas logs --since 30s --level error
# Stop daemon
deno task atlas daemon stop
```

### Best Practices

- Parse `cli-summary` for `chatId`; use `--chat` for multi-turn
- Scope logs with `--since 30s` to recent run
- Filter with `--level error,warn` to reduce noise
- JSON is default; `--human` only for debugging

### Viewing Chat History

```bash
# Get chatId from cli-summary
deno task atlas prompt "test the API"
# output includes: {"type":"cli-summary","chatId":"abc123",...}
# View full conversation
deno task atlas chat abc123
# Or human-readable
deno task atlas chat abc123 --human
```

### Debugging Agent Behavior

When the agent behaves unexpectedly, inspect its system prompt:

```bash
deno task atlas chat <chatId> --show-prompts --human
```

Shows all system messages sent to the LLM:

- Main prompt (with workspace/agent/credential context)
- Current datetime
- Scratchpad notes (if any)

## GCS (Production)

Query logs via gcloud CLI. All queries return JSON.

**Note:** Use `streamId` for chat queries - it's synonymous with chatId but has
better coverage across components.

### Use a Subagent for Log Retrieval

**Always delegate GCS log retrieval to a subagent.** Production logs are verbose
and will consume significant context. Spawn a sub-agent with explicit
instructions:

```
"Query GCS logs for streamId='CHAT_ID' (or sessionId, userId, etc.).
Filter for errors/warnings. Return a summary of:
1. Any errors with stack traces (condensed)
2. The sequence of events leading to the issue
3. Relevant context fields (workspaceId, agentId, etc.)
Do NOT return raw logs - summarize findings only."
```

The subagent handles the raw log volume; you receive a digestible summary.

### By chatId (streamId)

```bash
gcloud logging read 'jsonPayload.context.streamId="CHAT_ID"' \
  --format=json --freshness=1d
```

### By sessionId

```bash
gcloud logging read 'jsonPayload.context.sessionId="SESSION_ID"' \
  --format=json --freshness=1d
```

### Errors only

```bash
# By chatId (streamId)
gcloud logging read 'jsonPayload.context.streamId="CHAT_ID" severity>=ERROR' \
  --format=json --freshness=1d

# By sessionId
gcloud logging read 'jsonPayload.context.sessionId="SESSION_ID" severity>=ERROR' \
  --format=json --freshness=1d
```

### By userId

```bash
gcloud logging read 'labels."k8s-pod/user-id"="USER_ID"' \
  --format=json --freshness=1d
```

### By workspaceId

```bash
gcloud logging read 'jsonPayload.context.workspaceId="WORKSPACE_ID"' \
  --format=json --freshness=1d
```

### Common options

- `--freshness=1d` - how far back (1d, 7d, etc.)
- `--limit=100` - cap results
- Pipe to `jq` for filtering

## Log Structure

Key fields in GCS logs:

| Field       | Path                                                    |
| ----------- | ------------------------------------------------------- |
| streamId    | `jsonPayload.context.streamId` (synonymous with chatId) |
| sessionId   | `jsonPayload.context.sessionId`                         |
| workspaceId | `jsonPayload.context.workspaceId`                       |
| agentId     | `jsonPayload.context.agentId`                           |
| level       | `jsonPayload.level`                                     |
| message     | `jsonPayload.message`                                   |
| userId      | `labels."k8s-pod/user-id"`                              |
| error       | `jsonPayload.context.error.message`                     |
| stack       | `jsonPayload.context.error.stack`                       |

## Chats (Remote)

Coming soon. For now, use GCS logs filtered by streamId.
