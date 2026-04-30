---
name: debugging-friday
description: Covers debugging Friday agent behavior — local debugging with atlas CLI and remote debugging via GCS logs. Provides log access tooling; pairs with the `debugging` skill for investigation methodology.
compatibility: Requires gcloud CLI configured for GCS queries
---

# Friday Debugging

Prerequisite: Daemon running (`deno task atlas daemon start`). See CLAUDE.md for
basic CLI usage.

## Reading Chat Files Directly

Chat transcripts are stored as JSON files. Given a URL like
`http://localhost:5200/platform/{workspaceId}/chat/{chatId}`, the file is at:

```
~/.atlas/chats/{workspaceId}/{chatId}.json
```

The `messages` array uses `parts` (not `content`). Each part has a `type` field.
Tool calls appear as `tool-{name}` types; errors are in `output.error`. The FSM
session events that show agent execution status are in `data-nested-chunk` parts.

```bash
# Quick parse to see messages and errors
python3 -c "
import json
data = json.load(open('/path/to/chat.json'))
for m in data['messages']:
    for p in m.get('parts', []):
        if p.get('type', '').startswith('tool-') and p.get('output', {}).get('error'):
            print('ERROR:', p['output']['error'])
        elif p.get('type') == 'data-nested-chunk':
            chunk = p['data']['chunk']
            if 'error' in chunk.get('data', {}):
                print('FSM ERROR:', chunk['data']['error'])
"
```

## Local Log Analysis

```bash
deno task atlas logs --since 30s              # recent logs
deno task atlas logs --level error,warn       # filter by level
deno task atlas logs --chat <id>              # filter by chat ID
deno task atlas logs --session <id>           # filter by session ID
deno task atlas logs --human                  # human-readable (debugging only)
```

### Inspecting Agent Behavior

When the agent behaves unexpectedly, inspect its system prompt:

```bash
deno task atlas chat <chatId> --show-prompts --human
```

Shows all system messages sent to the LLM (workspace/agent context, datetime,
scratchpad notes).

### Tips

- Parse `cli-summary` for `chatId`; use `--chat` for correlated logs
- Scope logs with `--since 30s` to recent run
- Filter with `--level error,warn` to reduce noise
- JSON is default; `--human` only for debugging

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

### Query Examples

```bash
# By chatId (streamId)
gcloud logging read 'jsonPayload.context.streamId="CHAT_ID"' \
  --format=json --freshness=1d

# By sessionId
gcloud logging read 'jsonPayload.context.sessionId="SESSION_ID"' \
  --format=json --freshness=1d

# Errors only
gcloud logging read 'jsonPayload.context.streamId="CHAT_ID" severity>=ERROR' \
  --format=json --freshness=1d

# By userId
gcloud logging read 'labels."k8s-pod/user-id"="USER_ID"' \
  --format=json --freshness=1d

# By workspaceId
gcloud logging read 'jsonPayload.context.workspaceId="WORKSPACE_ID"' \
  --format=json --freshness=1d
```

### Common Options

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
