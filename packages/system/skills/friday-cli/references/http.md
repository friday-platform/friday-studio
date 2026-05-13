# Friday Daemon HTTP API

Base: `$FRIDAYD_URL` — set by the launcher (installed Friday Studio,
typically `:18080`) or `deno task atlas daemon start` (in-tree dev,
typically `:8080`); `FRIDAY_PORT_FRIDAY` can override either. Scheme is
`https://` when TLS is on (automatic for installed Studio; in-tree dev
opts in via `bash scripts/setup-tls.sh`), otherwise `http://`. **Don't
hardcode the URL — always use `$FRIDAYD_URL`.** No auth on localhost.
JSON in/out unless noted.

To run the curl examples in this file, source the daemon `.env` once per
shell so `$FRIDAYD_URL` and `$FRIDAY_TLS_CA` are exported. The block below
tries the installed-Studio location first (`${FRIDAY_HOME:-~/.friday/local}/.env`)
then falls back to the dev location (`~/.atlas/.env`):

```bash
set -a
. "${FRIDAY_HOME:-$HOME/.friday/local}/.env" 2>/dev/null \
  || . "$HOME/.atlas/.env" 2>/dev/null || true
set +a
# Wrapper that adds --cacert exactly when TLS is on. Use this in place of
# plain `curl` for every daemon call below.
friday_curl() { curl ${FRIDAY_TLS_CA:+--cacert "$FRIDAY_TLS_CA"} "$@"; }
```

**Rule: every daemon HTTP call in this reference uses `friday_curl`, not
plain `curl`.** The wrapper auto-adds `--cacert "$FRIDAY_TLS_CA"` when TLS
is on; plain `curl` against `$FRIDAYD_URL` on a TLS install fails with
`self signed certificate in certificate chain`.

SSE: pass `Accept: text/event-stream`. Streams end with `data: [DONE]`.

## Contents

- Workspaces — list / create / add / inspect / export / config / delete
- Workspace partial config — signals, agents, credentials
- Workspace resources
- Signal trigger — JSON blocking + SSE streaming
- Platform webhooks — Signal Gateway → daemon
- Sessions
- Jobs
- Chat (global) + Workspace chat + Chat storage RPC
- Library — shared assets
- Agents registry
- Skills — list / install / publish
- Activity

## Workspaces

### `GET /api/workspaces`
List all. Returns `{ id, name, path, description, type, metadata }[]`.

### `POST /api/workspaces/create`
Create from config. Body: `{ config: WorkspaceConfig, workspaceName?, ephemeral? }`.
Returns `{ workspaceId, path, name }`. Side: writes directory + workspace.yml.
409 on name conflict.

### `POST /api/workspaces/add`
Register existing dir. Body: `{ path, name?, description? }`.

### `POST /api/workspaces/add-batch`
Body: `{ paths: string[] }`. Partial success OK.

### `GET /api/workspaces/:id`
Full workspace: signals, agents, jobs, integrations.

### `GET /api/workspaces/:id/export`
Tarball. `application/x-tar` stream. Workspace.yml + resource data.

### `GET /api/workspaces/:id/config`
Parsed workspace.yml as JSON.

### `POST /api/workspaces/:id/config`
**Full replacement.** Body: `{ config, backup? }`. Destroys active runtime.
Prefer partial-update routes below.

### `DELETE /api/workspaces/:id`
Hard delete: stop runtime + remove directory. 403 on system workspace.

## Workspace partial config

Mount: `/api/workspaces/:id/config`. Mutates workspace.yml directly. All
writes destroy active runtime (reboots on next signal). **Prefer these over
any full-config rewrite or delete + recreate.**

### Signals

- `GET /signals` — list
- `GET /signals/:signalId` — single
- `POST /signals` — create. Body: `{ signalId, signal: WorkspaceSignalConfig }`. 409 on dup, 403 on system.
- `PUT /signals/:signalId` — full replace. Body: `WorkspaceSignalConfig`.
- `PATCH /signals/:signalId` — partial (schedule, timezone). Body: `SignalConfigPatchSchema`.
- `DELETE /signals/:signalId?force=true` — cascade to job triggers if `force`. 409 if in use.

### Agents

- `GET /agents` — list FSM-embedded agents
- `GET /agents/:agentId` — single
- `PUT /agents/:agentId` — update prompt/model/tools. Body: `{ prompt?, model?, tools? }`. Mutates workspace.yml.
- `POST /agents` — **405**. Agents FSM-wired via workspace.yml.
- `DELETE /agents/:agentId` — **405**.

### Credentials

- `GET /credentials` — list refs. Path format: `mcp:server_id:ENV_VAR` or `agent:agent_id:ENV_VAR`.
- `PUT /credentials/:path` — swap credential. Body: `{ credentialId }`. Validates provider match via Link. 400 on mismatch.

## Workspace resources

Mount: `/api/workspaces/:id/resources`.

- `GET /` — list, enriched with artifact metadata.
- `GET /:slug` — document resource. Prose or tabular.
- `GET /:slug/export` — CSV stream for tabular.
- `POST /upload` — multipart `file`. Auto-classify + Ledger provision. 201. 409 slug conflict.
- `POST /link` — external_ref. Body: `{ url, name, provider, description? }`.
- `PUT /:slug` — multipart `file` replace. 422 on type mismatch (`.md` for prose, `.csv` for tabular).
- `DELETE /:slug` — cascade Ledger + artifact.

## Signal trigger

### `POST /api/workspaces/:id/signals/:signalId` (JSON)
Body: `{ payload?, streamId?, skipStates? }`.
Returns `{ message, status, sessionId }`.
Errors: 400 payload schema, 404, 409 active session, 422 invalid config.

### Same route with `Accept: text/event-stream` (SSE)
Events: `data-agent-block-start`, `data-text-delta`, `data-tool-call`,
`job-complete`, `job-error`. Ends with `data: [DONE]`.

**Payload wrapping:** HTTP requires `{"payload": {...}}`. CLI unwraps.

## Platform webhooks (Signal Gateway → daemon)

### `POST /signals/slack`
Slack event. Gateway looks up workspace by `api_app_id`, delegates to
Chat SDK SlackAdapter. 400 missing app_id, 404 no workspace match.

## Sessions

- `GET /api/sessions?workspaceId=` — list
- `GET /api/sessions/:id` — full view with agent blocks
- `GET /api/sessions/:id/stream` — SSE replay + live. 404 if not in registry. 410 on outdated storage format.
- `DELETE /api/sessions/:id` — cancel running session.

## Jobs

- `GET /api/jobs/:jobId/:workspaceId` — `{ id, name, description, integrations, signals, agents }`.

## Chat (global)

Mount: `/api/chat`. Gated on membership of the `user` workspace (`USER_WORKSPACE_ID`); legacy chats under `friday-conversation` / `system` are treated as user-scoped for the purpose of the gate.

- `GET /` — list recent. Query `limit`, `cursor`.
- `POST /` — create + stream. Body: `{ id, message: AtlasUIMessage, datetime? }`. Header `X-Workspace-Id`. SSE response.
- `GET /:chatId` — chat + last 100 messages + systemPromptContext.
- `GET /:chatId/stream` — resume SSE. 204 if no active stream. Header `X-Turn-Started-At`.
- `DELETE /:chatId/stream` — cosmetic stop.
- `POST /:chatId/message` — append user message.
- `PATCH /:chatId/title` — body `{ title }`.
- `DELETE /:chatId` — delete chat.

## Workspace chat

Mount: `/api/workspaces/:id/chat`. Same shape as global chat. Header
`X-Atlas-User-Id` auto-injected from `FRIDAY_KEY` JWT.

## Chat storage RPC

Mount: `/api/chat-storage`. Low-level; CLI uses `/api/chat` wrapper.

- `GET /` — `{ conversations: string[], conversationCount }`
- `GET /:streamId` — `{ messages, messageCount }`
- `PUT /:streamId` — replace. Body: `{ messages: AtlasUIMessage[] }`.

## Library

Mount: `/api/library`.

- `GET /` — search. Query: `query|q`, `type`, `tags`, `since`, `until`, `limit`, `offset`.
- `POST /` — create. JSON or multipart (`file` + `metadata` JSON).
- `GET /:itemId` — detail
- `DELETE /:itemId`
- `GET /templates`
- `GET /stats`

## Agents registry

Mount: `/api/agents`.

- `GET /` — list. Query `limit` (1-500).
- `GET /:id` — metadata (id, displayName, description, version, expertise, input/outputSchema).
- `POST /register` — multipart `files` + optional `entry_point`. Registers agent source, writes to agents dir, reloads registry. **Authoring: use the `writing-friday-python-agents` skill.**

## Skills

Mount: `/api/skills`. Auth required on mutations.

- `GET /` — list. Query `namespace`, `query`, `includeAll`, `sort`.
- `POST /` — blank skill. Returns `{ skillId }`.
- `GET /:namespace/:name` — latest. `?include=archive` returns tarball.
- `GET /:namespace/:name/versions`
- `GET /:namespace/:name/files`
- `GET /:namespace/:name/files/*` — `{ path, content }`
- `PUT /:namespace/:name/files/*` — body `{ content }`. Extracts, updates, repacks, publishes new version.
- `POST /:namespace/:name` — publish. JSON: `{ description, instructions, frontmatter?, archive?, skillId?, descriptionManual? }`.
- `POST /:namespace/:name/upload` — multipart `archive` (tar.gz) + optional `skillMd`.
- `GET /:namespace/:name/:version` — specific version
- `DELETE /:namespace/:name/:version`
- `GET /:skillId` — by ID
- `PATCH /:skillId/disable` — body `{ disabled }`
- `DELETE /:skillId` — all versions

### Scoping

- `GET /api/skills/scoping/:skillId/assignments` — `{ workspaceIds }`
- `POST /api/skills/scoping/:skillId/assignments` — body `{ workspaceIds }`. 200/207/500.
- `DELETE /api/skills/scoping/:skillId/assignments/:workspaceId` — 204

## Activity

Mount: `/api/activity`. Auth required.

- `GET /` — list. Query `workspaceId`, `limit`, `offset`, `status`.
- `GET /unread-count?workspaceId=`
- `POST /mark` — body: `{ activityIds, status }` or `{ before, status: "viewed", workspaceId? }`.
- `GET /stream` — SSE unread count. 30s keepalive.

## Memory

- `GET /api/memory/:workspaceId/narrative/:memoryName?since=&limit=`
  Returns `NarrativeEntry[]`. Empty on failure (warn-logged).

## User / me

- `GET /api/user` — `{ user: UserIdentity }`
- `GET /api/me` — same, daemon-local, photo URL resolved
- `PATCH /api/me` — JSON `{ full_name?, display_name?, profile_photo? }` or multipart `photo` + `fields` JSON
- `GET /api/me/photo` — image binary, immutable cache

## MCP registry

- `GET /api/mcp-registry` — `{ servers, metadata: { version, staticCount, dynamicCount } }`
- `GET /api/mcp-registry/:id`
- `POST /api/mcp-registry` — body `{ entry: MCPServerMetadata }`. 409 on blessed conflict.

## Config

- `GET /api/config/env` — `{ envVars }` from `~/.friday/local/.env`
- `PUT /api/config/env` — body `{ envVars }`. Creates dir if missing.

## Daemon

- `GET /api/daemon/status` — `{ status, activeWorkspaces, uptime, timestamp, version, memoryUsage, workspaces, cronManager, cascadeConsumer, migrations, configuration }`. `cascadeConsumer` is `{ inFlight, cap, saturated }` — point-in-time view of the CASCADES dispatch buffer.
- `POST /api/daemon/shutdown` — initiates after 100ms delay

## Health

- `GET /health` — `{ activeWorkspaces, uptime, timestamp, version }` (no `/api` prefix)

## Instance events

Operational feed of cross-workspace cascade events
(`cascade.queue_saturated`, `cascade.queue_drained`, `cascade.queue_timeout`, `cascade.replaced`).
Backed by the `INSTANCE_EVENTS` JetStream stream (Limits retention, 7-day max_age).

- `GET /api/instance/events?stream=true&type=<filter>` — SSE feed; subscribes to `instance.>` (or `instance.<filter>` if `type` set) and forwards each event as a `data:` frame. UI consumers don't poll.
- `GET /api/instance/events?since=<seq>&type=<filter>&limit=<n>` — replay; returns `{ events: [...] }` (newest first). Use for late joiners and reload-after-disconnect.

## Share / report

- `POST /api/share` — raw HTML body, proxies to gist. Returns `{ id, url }`.
- `POST /api/report` — `{ userId, chatId, sessionId }`. Emails support via gateway.

## Link

- `ALL /api/link/*` — proxy to `LINK_SERVICE_URL` (default `http://localhost:3100`). Maps `/api/link/foo` → `/v1/foo`. Forwards `Authorization: Bearer $FRIDAY_KEY`.

## Scratchpad

- `GET /api/scratchpad/:streamId?limit=100` — `{ notes, count }`
- `POST /api/scratchpad/:streamId` — body `{ note }`

## Artifacts + chunked-upload

Mount: `/api/artifacts`, `/api/chunked-upload`. Internal/agent-facing. See
`apps/atlasd/routes/` for detail.

## Error codes (signal trigger path)

- 400 — payload fails signal JSON Schema
- 404 — workspace or signal not found
- 409 — workspace has active session
- 422 — invalid workspace config / session failed / missing env
- 500 — internal
