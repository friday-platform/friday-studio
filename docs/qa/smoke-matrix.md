# Friday Smoke Matrix

Last updated: 2026-02-23

Refer to `docs/product-map.md` for ports, routes, and CLI commands.

## Infrastructure

### Daemon health
**Trigger**: `deno task atlas daemon status`
**Verify**: Returns running status with PID and uptime

### API responsiveness
**Trigger**: `curl http://localhost:8080/api/health`
**Verify**: Returns 200

### User identity
**Trigger**: `curl http://localhost:8080/api/me`
**Verify**: Returns JSON with user ID (default-user in dev)

### Web client loads
**Trigger**: Navigate to `http://localhost:1420/chat`
**Verify**: Page renders, no console errors, daemon connection indicator shows
connected

## Chat

### New conversation
**Trigger**: `deno task atlas prompt "Hello, what can you help me with?"`
**Verify**: Returns response with chat ID, response is coherent

### Chat appears in history
**Trigger**: `deno task atlas chat` after sending a message
**Verify**: Most recent chat shows with correct title

### Chat UI renders
**Trigger**: Navigate to `http://localhost:1420/chat/<chatId>` from previous
case
**Verify**: Messages display, input field is functional

## Workspace Lifecycle

### Create workspace from chat (historically fragile)
**Trigger**: Send a workspace creation prompt via chat — e.g. "Can you set up a
workspace that sends me a weekly digest of newly released gravel bikes with 50mm+
tire clearance?"
**Expect**: Planner asks clarifying questions → answer plausibly → workspace plan
card appears in chat → click Approve → workspace appears in sidebar
**If broken**: `deno task atlas logs --chat <id>`, check
`fsm-workspace-creator` agent, inspect `/api/workspaces`

### Workspace detail page
**Trigger**: Navigate to `/spaces/<workspaceId>`
**Verify**: Page renders with workspace name, color, session list

### Workspace edit page
**Trigger**: Navigate to `/spaces/<workspaceId>/edit`
**Verify**: Config editor loads, color picker works, integrations section visible

## Session Lifecycle (historically fragile)

### Trigger execution from chat
**Trigger**: `deno task atlas prompt "Can you run my <workspace> please?"` (use
an existing workspace)
**Expect**: Conversation agent triggers workspace signal, session ID returned
**If broken**: Check `/api/workspaces/<id>/sessions`, inspect how conversation
agent triggers signals

### Session appears in workspace
**Trigger**: Navigate to `/spaces/<workspaceId>/sessions` or curl
`/api/sessions?workspaceId=<id>`
**Verify**: New session shows with status and timestamp

### Session detail streams (historically fragile)
**Trigger**: Navigate to `/spaces/<workspaceId>/sessions/<sessionId>` while
session is active
**Verify**: Timeline events stream in, agent blocks display progressively
**If broken**: Check `GET /api/sessions/<id>` response, inspect SSE at
`/api/sessions/<id>/stream`

### Completed session shows summary
**Trigger**: View a completed session detail page
**Verify**: Agent blocks are all rendered, summary section shows with natural
language description
**If broken**: Check `aiSummary` field in `GET /api/sessions/<id>`

### Failed session shows error
**Trigger**: View a failed session detail page
**Verify**: Error summary displays with actionable description

## Library

### Library page loads
**Trigger**: Navigate to `/library`
**Verify**: Page renders with artifact list or empty state

### Artifact detail renders
**Trigger**: Navigate to `/library/<artifactId>` (use an existing artifact)
**Verify**: Artifact content displays

## Settings & Integrations

### Settings page loads
**Trigger**: Navigate to `/settings`
**Verify**: Page renders, credentials list loads via `/api/link/v1/credentials`

### Credential status
**Trigger**: `curl http://localhost:8080/api/link/v1/credentials`
**Verify**: Returns array of credentials with provider and status fields

## Global Navigation

### Sidebar renders workspaces
**Trigger**: Load any app page
**Verify**: Sidebar shows workspace list matching `GET /api/workspaces`

### Global sessions page
**Trigger**: Navigate to `/sessions`
**Verify**: Session list renders across all workspaces

### Daemon reconnection
**Trigger**: Stop and restart daemon while web client is open
**Verify**: Error banner appears with countdown, disappears when daemon returns
