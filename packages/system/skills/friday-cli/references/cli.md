# Atlas CLI Reference

Complete reference for `deno task atlas <subcommand>`. The CLI is a thin HTTP
client over `$FRIDAYD_URL` (host/port and scheme vary by install — installed
Friday Studio runs `:18080`, in-tree dev runs `:8080`, both can be on TLS).
Every subcommand maps to one or more daemon routes. When the CLI lacks a
flag you need, drop to HTTP (`references/http.md`).

## Daemon URL preamble (required for raw HTTP)

A few subcommands document HTTP fallback paths (notably `agent register`
below — there is no CLI subcommand). For those, **use `curl -k`, never
plain `curl`** — plain `curl` against `$FRIDAYD_URL` on a TLS-enabled
install fails with `self signed certificate in certificate chain`. Source
the daemon `.env` once per shell:

```bash
```

Conventions:
- `--json` on most commands → NDJSON (one object per line) + a final
  `cli-summary` line with continuation hints.
- `--human` (or default for some) → Ink tables / formatted text.
- Exit 1 on daemon unreachable or resource-not-found unless noted.
- Aliases are listed with each command — short forms are just ergonomics.

---

## Daemon lifecycle

### `daemon start`
`daemon start [--port 8080] [--hostname 127.0.0.1] [--detached] [--max-workspaces 10] [--idle-timeout 300] [--log-level info] [--atlas-config <path>]`

Starts the HTTP server. `--detached` forks and returns; otherwise runs in
foreground. Exits 1 if already running or port unavailable. With `FRIDAY_KEY`
set, fetches credentials and re-execs with OTEL env.

Aliases: `daemon run`

### `daemon stop`
`daemon stop [--port 8080] [--force]`

Graceful shutdown via `POST /api/daemon/shutdown` + 2s wait. `--force` skips
the "active workspaces" check. Exits 1 if daemon not running or doesn't stop
within 2s.

### `daemon status`
`daemon status [--port 8080] [--json]`

Returns running/not-running + active workspace count. Exits 1 if daemon down
(useful as a guard: `atlas daemon status || atlas daemon start --detached`).

### `daemon restart`
`daemon restart [--port 8080] [--force] [--max-workspaces <n>] [--idle-timeout <s>]`

Stop → 3s wait → start detached. Same flags as `start`. `--force` bypasses the
active-workspace check.

---

## Workspaces

### `workspace list`
`workspace list [--json]` — aliases: `workspace ls`, `work list`, `w list`

All registered workspaces (persistent + ephemeral + system). Primary way to
resolve runtime IDs.

### `workspace add`
`workspace add -p <path> [--name <n>] [--description <d>] [--scan <dir>] [--depth 3] [--json]`

Aliases: `workspace register`

Registers an existing workspace directory. `--scan` recurses to find multiple
`workspace.yml` files at once. Does NOT create files — for creation from
config, use `POST /api/workspaces/create` (see recipes.md).

### `workspace status`
`workspace status -w <id-or-name> [--json]`

Workspace metadata + signals + agents + integrations.

### `workspace remove`
`workspace remove -w <id-or-name> --yes [--json]`

Aliases: `workspace rm`, `workspace delete`

Unregisters from daemon. **Does not delete the directory.** For hard delete
(directory + registration), use `DELETE /api/workspaces/:id`.

### `workspace cleanup`
`workspace cleanup --yes [--json]`

Removes workspaces whose directories have been deleted out from under the
registry.

---

## Signals

### `signal list`
`signal list -w <workspace> [--json]`

Aliases: `signal ls`, `sig list`

Signal IDs, descriptions, providers, JSON schemas.

### `signal trigger`
`signal trigger -n <name> [-w <workspace> | --all] [--data '<json>'] [--exclude <ids>] [--stream] [--json]`

Aliases: `signal fire`, `signal send`

Fires a signal. `--data` is JSON payload (unwrapped — no `{"payload":...}`
envelope needed, CLI adds it). `--stream` holds the connection open and
streams SSE events (text deltas, tool calls, job-complete). `--all` fires on
every running workspace; combine with `--exclude` to skip specific ones.

---

## Sessions

### `session list`
`session list [--workspace <name>] [--json]`

Aliases: `session ls`, `sesh list`, `ps`

Active + recent sessions.

### `session get`
`session get <id> [--json]`

Aliases: `session show`, `session describe`

Full session: agent blocks, events, metadata.

### `session cancel`
`session cancel <id> [--force] [--yes]`

Aliases: `session kill`, `session stop`

Cancels a running session. Exit 0 if already completed. `--yes` skips the
confirmation prompt; use in automation.

---

## Chat / prompting

### `prompt`
`prompt <message> [--chat <chatId>] [--workspace <id>] [--human]`

Alias: `p`

Sends a prompt. Default output is NDJSON — `cli-summary` at the end has the
`chatId` for continuation. `--workspace` routes to a workspace-scoped chat
instead of the default `user` workspace.

### `chat`
`chat [<chatId>] [--limit 25] [--show-prompts] [--human]`

Alias: `ch`

No ID → lists recent chats. With ID → full transcript. `--show-prompts` dumps
system messages (workspace/agent context, datetime, scratchpad) — invaluable
for understanding why an agent did what it did.

---

## Logs

### `logs`
`logs [--since <dur>] [--level <lvl>] [--chat <id>] [--session <id>] [--workspace <id>] [--human]`

Reads `~/.friday/local/logs/global.log` + `~/.friday/local/logs/workspaces/*.log`. Duration
formats: `30s`, `5m`, `1h`. Level can be comma-separated (`error,warn`). When
filtering by chat/session, the CLI resolves the workspace for you.

Use the `debugging-friday` skill for deeper log forensics (GCS, correlation).

---

## Agents

### `agent list`
`agent list [-w <workspace>] [--user] [--json]`

Agents in a workspace. `--user` lists user-built agents in `~/.friday/local/agents/`.
Falls back to `--user` mode if you're outside a workspace directory.

### `agent describe`
`agent describe -n <name> [-w <workspace>]`

Alias: `agent show`, `agent get`

Full agent config as JSON (type, prompt, model, tools, integrations).

### Registering a Python user agent

There is no `atlas agent register` CLI subcommand — register via the daemon's
HTTP API directly. Source the daemon `.env` once per shell so the example
works on TLS-enabled installs (see the SKILL.md "Daemon URL" preamble).

**Rule: use `curl -k`, not plain `curl`.** Plain `curl` against
`$FRIDAYD_URL` on a TLS install fails with `self signed certificate in
certificate chain`. `-k` skips cert verification — safe because the
daemon binds loopback only.

```bash
curl -k -X POST "$FRIDAYD_URL/api/agents/register" \
  -H 'Content-Type: application/json' \
  -d '{"entrypoint": "/abs/path/to/your-agent/agent.py"}'
```

The daemon spawns the entry point with `FRIDAY_VALIDATE_ID`, collects metadata over NATS,
copies the source directory to `~/.friday/local/agents/{id}@{version}/`, and reloads the
registry. No compilation step — the agent process is spawned per invocation and communicates
via NATS request/reply. See the `writing-friday-python-agents` skill for the full authoring flow.

### `agent exec`
`agent exec <agent> -i <input> [--url http://localhost:5200] [--env K=V,K2=V2] [--json] [--stream]`

Executes an agent via the playground. Requires `deno task playground` running
separately on :5200. Good for testing agents in isolation before wiring them
into a workspace.

---

## Skills

### `skill list`
`skill list [--namespace <ns>] [--query <q>] [--all] [--json]`

Published skills.

### `skill get`
`skill get -n @namespace/name [--json]`

Skill metadata + latest version info.

### `skill publish`
`skill publish [-p <path>] [--name @namespace/name] [--json]`

Aliases: `skill pub`

Tars up the skill directory and POSTs to the registry. `--name` overrides
SKILL.md frontmatter. Returns the new version number.

### `skill versions`
`skill versions -n @namespace/name [--json]`

---

## Library

### `library list`
`library list [--tags <csv>] [--since <date>] [--limit 50] [--workspace <path>] [--json]`

Alias: `library ls`

Stored artifacts/templates.

### `library get`
`library get <id> [--content] [--json]`

Supports partial ID match (prefix). `--content` includes the item body.

---

## Artifacts

### `artifacts list`
`artifacts list [--workspace <id>] [--chat <id>] [--limit 100]`

Must provide at least one of `--workspace` or `--chat`.

### `artifacts get`
`artifacts get <id> [--revision <n>]`

Latest revision unless `-r` specified.

---

## Version / misc

### `version` (`v`)
Version info.

### `reset [--force]`
Wipes `~/.friday/local/` (preserves `.env` and `bin/`). Hidden from `--help`.
Stops daemon first.

---

## Common patterns

```bash
# Guard daemon
deno task atlas daemon status || deno task atlas daemon start --detached

# Continue a chat from cli-summary
CHAT_ID=$(deno task atlas prompt "hello" | jq -r 'select(.type=="cli-summary") | .chatId')
deno task atlas prompt --chat "$CHAT_ID" "follow up"

# Fire + stream in one line
deno task atlas signal trigger -n my-signal -w my-workspace --data '{}' --stream

# Correlate logs with a session
deno task atlas logs --session sess_123 --human --since 5m

# Find and cancel the most recent running session
SID=$(deno task atlas session list --json | jq -r '[.[]|select(.status=="active")][0].id')
[ -n "$SID" ] && deno task atlas session cancel "$SID" --yes
```

---

## HTTP-only operations (no CLI equivalent)

When you need any of these, drop to `curl` / `fetch` — see `references/http.md`.

1. **Workspace creation from parsed YAML** — `POST /api/workspaces/create`
2. **Workspace config partial updates** — `PUT/PATCH /api/workspaces/:id/config/signals/:id`, `/agents/:id`, `/credentials/:path`
3. **Resource upload / link** — `POST /api/workspaces/:id/resources/upload`, `.../link`
4. **Activity feed** — `/api/activity/*`
5. **Memory narrative reads** — `GET /api/memory/:workspaceId/narrative/:memoryName`
6. **MCP registry mutations** — `POST /api/mcp-registry`
7. **Direct chat-storage RPC** — `/api/chat-storage/*`
8. **User profile / photo** — `/api/me`, `/api/user`
9. **Env var management** — `PUT /api/config/env`
10. **Share / report** — `/api/share`, `/api/report`
11. **Scratchpad append/read** — `/api/scratchpad/:streamId`
12. **Chunked uploads** — `/api/chunked-upload/*`
13. **Workspace export tarball** — `GET /api/workspaces/:id/export`
14. **Skill scoping** — `/api/skills/scoping/:skillId/assignments`
