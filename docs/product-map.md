# Friday Product Map

Operational surface area of the product. What's running, where, and how to
interact with it.

## Ports

| Service | URL | Startup |
|---------|-----|---------|
| Everything | Both ports below | `deno task dev:full` |
| Daemon (API) | `http://localhost:8080` | `deno task atlas daemon start --detached` |
| Web Client | `http://localhost:1420` | `cd apps/web-client && npm run dev` |

`deno task dev:full` starts both the daemon and web client. Alternatively, start
them separately. The web client expects the daemon to be running — it won't
start it automatically.

## Web Client Routes

```
(app)/                              # Authenticated app shell
├── chat/[[chatId]]                 # Chat interface (optional chatId)
├── spaces/[spaceId]/               # Workspace detail
│   ├── edit                        # Workspace config editor
│   └── sessions/                   # Workspace session list
│       └── [sessionId]             # Session detail within workspace
├── sessions/                       # Global session list
│   └── [sessionId]                 # Session detail (standalone)
├── library/                        # Artifact library
│   └── [artifactId]               # Artifact viewer
├── settings                        # Credentials and integrations
│
/about                              # Version info
/oauth/callback                     # OAuth popup callback
```

## Key API Endpoints

Base: `http://localhost:8080/api`

### Health & Identity

- `GET /health` — daemon health check
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

### Sessions

- `GET /sessions` — list sessions (optional `?workspaceId=` filter)
- `GET /sessions/:id` — session details with agent blocks
- `GET /sessions/:id/stream` — SSE stream for active sessions
- `DELETE /sessions/:id` — cancel running session

### Library & Artifacts

- `GET /library` — list/search library items
- `GET /artifacts/:id` — get artifact content

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

# Signals
deno task atlas signal trigger <name>

# Logs
deno task atlas logs --since 30s
deno task atlas logs --chat <id>
deno task atlas logs --level error,warn
```

## Auth in Dev Mode

- No ATLAS_KEY needed — falls back to "default-user" identity
- No login page — daemon accepts requests without authentication
- OAuth integrations (Google, Slack, GitHub, etc.) require real credentials
  configured via Settings page
- OAuth flow: popup-based → `/oauth/callback` → postMessage to opener
- Credentials can expire — check status via `GET /link/v1/credentials`

## Gotchas

- **Daemon must run first** — web client connects to `localhost:8080` on load
- **Live reload** — daemon auto-restarts on code changes, no manual restart
  needed
- **Port conflicts** — daemon 8080, web client 1420, both must be free
- **Workspace names are generated** — slugs like `herbal_ginger`, not
  user-chosen names
- **SSE streams** — chat and session detail pages use SSE, not polling
- **Popup blockers** — OAuth falls back to same-tab redirect if popup blocked
