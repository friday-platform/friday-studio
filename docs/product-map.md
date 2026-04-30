# Friday Product Map

Operational surface area of the product. What's running, where, and how to
interact with it.

## Ports

| Service | URL | Startup |
|---------|-----|---------|
| Daemon (API) | `http://localhost:8080` | `deno task atlas daemon start --detached` |
| Agent playground | `http://localhost:5200` | `deno task playground` |

The playground expects the daemon to be running on `:8080` — it won't start it
automatically.

## Key API Endpoints

Base: `http://localhost:8080/api`

### Health (root-level, not under /api)

- `GET /health` — daemon health check (`http://localhost:8080/health`)

### Identity

- `GET /me` — current user identity

### Chat

- `GET /chat` — list recent chats (cursor pagination)
- `POST /chat` — create chat, streams response via SSE
- `POST /chat/:chatId` — append message, streams response
- `GET /chat/:chatId` — chat details
- `DELETE /chat/:chatId` — delete chat

### Workspaces

- `GET /workspaces` — list all workspaces
- `POST /workspaces/create` — create from config
- `GET /workspaces/:id` — workspace details
- `POST /workspaces/:id/update` — update config
- `PATCH /workspaces/:id/metadata` — update name, color
- `DELETE /workspaces/:id` — delete workspace
- `POST /workspaces/:id/signals/:signalId` — trigger execution
- `GET /workspaces/:id/sessions` — workspace session list

### Workspace Chat

- `GET /workspaces/:id/chat` — list workspace chats (cursor pagination)
- `POST /workspaces/:id/chat` — create workspace chat, streams response via SSE
- `GET /workspaces/:id/chat/:chatId` — chat details with messages
- `GET /workspaces/:id/chat/:chatId/stream` — resume SSE stream
- `DELETE /workspaces/:id/chat/:chatId/stream` — stop stream (cosmetic)
- `POST /workspaces/:id/chat/:chatId/message` — append message
- `PATCH /workspaces/:id/chat/:chatId/title` — update chat title

### Sessions

- `GET /sessions` — list sessions (optional `?workspaceId=` filter)
- `GET /sessions/:id` — session details with agent blocks
- `GET /sessions/:id/stream` — SSE stream for active sessions
- `DELETE /sessions/:id` — cancel running session

### Library & Artifacts

- `GET /library` — list/search library items
- `GET /artifacts/:id` — get artifact content

### Agents

- `GET /agents` — list all available agents (bundled + user-built)
- `GET /agents/:agentId` — get agent metadata by ID
- `POST /agents/register` — register a NATS-protocol agent from a local `.py` or `.ts` file

### Credentials (Link service)

- `GET /link/v1/credentials` — list credentials
- `GET /link/v1/oauth/authorize/:providerId` — start OAuth flow
- `GET /link/v1/providers/:id` — provider info

## CLI Quick Reference

```bash
# Daemon
deno task atlas daemon start --detached
deno task atlas daemon stop
deno task atlas daemon status

# Chat / Prompts
deno task atlas prompt "message"              # new chat
deno task atlas prompt --chat <id> "message"  # continue chat
deno task atlas chat                          # list recent
deno task atlas chat <id> --human             # readable transcript

# Workspaces
deno task atlas workspace list

# Sessions
deno task atlas session list
deno task atlas session get <id>
deno task atlas session watch <id>

# Agents
deno task atlas agent exec <id> -i "prompt"     # execute agent directly
deno task atlas agent exec <id> -i "prompt" --json  # NDJSON output
deno task atlas agent exec <id> -i "prompt" --url http://localhost:15200  # docker

# Signals
deno task atlas signal trigger <name>

# Logs
deno task atlas logs --since 30s
deno task atlas logs --chat <id>
deno task atlas logs --level error,warn
```

## Auth in Dev Mode

- No FRIDAY_KEY needed — falls back to "default-user" identity
- Daemon accepts requests without authentication
- OAuth integrations (Google, Slack, GitHub, etc.) require real credentials
  configured via the Link service
- OAuth flow: popup-based → `/oauth/callback` → postMessage to opener
- Credentials can expire — check status via `GET /link/v1/credentials`

## Gotchas

- **Daemon must run first** — clients connect to `localhost:8080` on load
- **Live reload** — daemon auto-restarts on code changes, no manual restart
  needed
- **Port conflicts** — daemon 8080, playground 5200, both must be free
- **Workspace names are generated** — slugs like `herbal_ginger`, not
  user-chosen names
- **SSE streams** — chat and session endpoints use SSE, not polling
- **Popup blockers** — OAuth falls back to same-tab redirect if popup blocked
