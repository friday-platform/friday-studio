---
name: friday-cli
description: "Interact with a running Friday daemon via CLI and HTTP — list/create/modify workspaces, trigger signals, watch sessions, publish skills and agents. Use whenever you need to poke at a local Friday daemon, inspect its state, fire a signal, drive the autopilot / self-modification flywheel, create a workspace programmatically, or validate that a workspace.yml you just authored actually runs. Also use when the task involves `$FRIDAYD_URL`, `deno task atlas`, curl-ing the daemon, or automating Friday itself."
---

# Friday CLI & HTTP

Friday is orchestrated by a daemon at `$FRIDAYD_URL`. The exact scheme/port
varies by install — installed Friday Studio runs on `:18080` (with TLS
configured automatically by the launcher), in-tree dev runs on `:8080`
(plain HTTP unless you opt in with `bash scripts/setup-tls.sh`), and
`FRIDAY_PORT_FRIDAY` can override either. Don't hardcode the URL — resolve
`$FRIDAYD_URL` from your own process env via `run_code` (preamble below)
and emit the resolved literal in every command you show the user.

There are two surfaces for interacting with the daemon: the `deno task
atlas` CLI (thin HTTP client, great for humans and shell scripts) and the
raw HTTP API (more endpoints, SSE streaming, the only option for many
CRUD ops on workspace internals).

## Daemon URL — resolve before emitting curl commands

`$FRIDAYD_URL` is in the **Friday daemon's process env**, not the user's
shell. If you emit a curl example with a literal `$FRIDAYD_URL`, the user
pastes it into a shell that has no such variable and gets `curl: (3) URL
rejected: No host part in the URL`.

**Always resolve `$FRIDAYD_URL` to a concrete value before showing a
command to the user.** Use `run_code` to read your own env:

```python
import os
print(os.environ["FRIDAYD_URL"])
```

That prints a URL like `https://localhost:18080` (installed Studio with
TLS) or `http://localhost:8080` (in-tree dev). Take whatever string the
lookup returns and substitute it as a literal in the curl command.

### Two load-bearing rules

1. **Resolve `$FRIDAYD_URL` first, emit the literal URL.** Never emit
   `$FRIDAYD_URL` (the variable name) in a command the user is supposed
   to paste — they don't have it in their env. Always run the lookup
   above, then substitute. If the user mentions a host/port in their
   message, IGNORE it and use the resolved value from your env — that's
   the only one guaranteed to match the running daemon.

   **Worked example.** Your `run_code` lookup returns
   `FRIDAYD_URL=https://localhost:18080`. User asks "hit /health":
   - ❌ Wrong: `curl -k "$FRIDAYD_URL/health"` (user's shell has no
     `$FRIDAYD_URL`).
   - ❌ Wrong: `curl -k "http://localhost:8080/health"` (guessed the
     wrong port — user runs installed Studio, not dev).
   - ✅ Right: `curl -k "https://localhost:18080/health"` (the literal
     value from `os.environ["FRIDAYD_URL"]`).

2. **Always use `curl -k` for daemon calls, never bare `curl`.** The
   daemon ships a private-CA TLS cert that the system trust store
   doesn't know about; plain `curl` against the daemon on a TLS install
   fails with `self signed certificate in certificate chain`. `-k`
   skips cert verification, which is fine here because the daemon
   binds loopback only — anyone who can MitM `localhost` already owns
   the machine.

## When to use CLI vs HTTP

**CLI** — inspection, prompting, watching. The happy path for most read ops and
the common "trigger + stream" workflow. Shell-friendly.

**HTTP** — anything the CLI doesn't cover: partial workspace config updates
(signals/agents/credentials), resource uploads, memory reads, activity
tracking, MCP registry mutations, chat-storage RPC, library CRUD beyond what
`atlas library` exposes. Also the only way to get proper SSE streams with full
control over headers.

See `references/cli.md` and `references/http.md` for the full surface. The
**HTTP-only ops** list at the bottom of `cli.md` is the fastest way to answer
"can I do X from the CLI?"

## Workflow preflight

Before touching anything, confirm the daemon is up:

```bash
deno task atlas daemon status
# or (after resolving $FRIDAYD_URL via run_code and substituting the
# literal value — see preamble above):
curl -k -sf "<resolved-url>/health" && echo OK
```

If it's not:

```bash
deno task atlas daemon start --detached
```

The daemon auto-restarts on code changes in dev. Hard-reload (rare, but
sometimes needed after schema changes):

```bash
deno task atlas daemon restart --force
```

## The five operations that cover 90% of tasks

### 1. List workspaces and find IDs

```bash
deno task atlas workspace list --json
```

Workspace IDs are runtime-assigned (e.g. `grilled_xylem`, `mild_almond`) — not
stable across machines. Always resolve IDs from the list; never hardcode.

### 2. Inspect a workspace's signals before firing

```bash
deno task atlas signal list -w <workspace-id-or-name> --json
```

Or HTTP for full schema:

```bash
curl -k -sf \
  "$FRIDAYD_URL/api/workspaces/<id>/signals" | jq
```

The signal's `schema` is a JSON Schema — your payload must match it or the
trigger returns 400.

### 3. Fire a signal — three modes

The HTTP signal-trigger endpoint has three response modes. Pick the one that
matches what the caller actually needs:

**(a) Fire-and-forget — `?nowait=true`** (RECOMMENDED for any caller that
doesn't need cascade output to compose its response):

```bash
curl -k -sf -X POST \
  "$FRIDAYD_URL/api/workspaces/<id>/signals/<signal-id>?nowait=true" \
  -H 'Content-Type: application/json' \
  -d '{"payload":{"some":"value"}}'
# → 202 {"status":"accepted","correlationId":"...","streamUrl":"/api/workspaces/<id>/signals/stream/<correlationId>"}
```

Atlasd publishes to the SIGNALS JetStream subject and returns immediately
(<100ms). The cascade runs async on the CASCADES consumer. Use this for
webhooks, cron, fire-and-forget RPC, anything where the HTTP caller is just
the publisher. The webhook-tunnel uses this internally.

**(b) Synchronous JSON** (legacy default — caller waits for cascade
completion, up to 10 minutes):

```bash
curl -k -sf -X POST \
  "$FRIDAYD_URL/api/workspaces/<id>/signals/<signal-id>" \
  -H 'Content-Type: application/json' \
  -d '{"payload":{"some":"value"}}'
# → 200 {"status":"completed","sessionId":"...","output":[...],"summary":"..."}
```

Use this only when the calling code needs `output` / `summary` to build its
own response. The CLI's `signal trigger` defaults to this mode. Holds an
HTTP connection open for the full cascade duration — be aware of timeouts on
your side (e.g. webhook upstreams typically cap at 30s).

**(c) Streaming SSE** — same publish, but stream cascade events as they happen:

```bash
# trigger + stream in one request
curl -k -N -X POST \
  "$FRIDAYD_URL/api/workspaces/<id>/signals/<signal-id>" \
  -H 'Content-Type: application/json' \
  -H 'Accept: text/event-stream' \
  -d '{"payload":{"some":"value"}}'

# OR: publish nowait, then follow by correlationId
curl -k -N \
  "$FRIDAYD_URL/api/workspaces/<id>/signals/stream/<correlationId>" \
  -H 'Accept: text/event-stream'
```

The second form is useful when the publisher and the watcher are different
processes — publish with `?nowait=true`, hand the correlationId to whatever
needs to watch.

The CLI wrapper:

```bash
deno task atlas signal trigger -n <signal-name> -w <workspace> \
  --data '{"some":"payload"}' --stream
```

The payload MUST be wrapped in `{"payload": {...}}` for HTTP. The CLI unwraps
this for you.

### 4. Watch a running session's agent activity + read the outcome

**From chat:** prefer `list_sessions(scope?)` + `describe_session(id)` — same data, no curl required. Use the CLI/HTTP recipes below from terminals or shell scripts.

```bash
deno task atlas session list --json           # find the session
deno task atlas session get <session-id> --json  # full SessionView
```

SSE replay/live stream (survives reconnect within the replay window):

```bash
curl -k -N \
  "$FRIDAYD_URL/api/sessions/<id>/stream" \
  -H 'Accept: text/event-stream'
```

After the session finalizes, `SessionView` has an `aiSummary` field with a
human-readable summary + keyDetails (with URLs). Prefer it over walking
`agentBlocks[]` when you just want "what happened":

```bash
curl -k -sf \
  "$FRIDAYD_URL/api/sessions/<id>" | jq '.aiSummary'
```

Full shape + failure extraction recipes + log access + SSE event types →
**`references/session-and-logs.md`**. Load it any time you need to answer
"did the signal succeed, what happened, any errors".

### 5. Create a workspace from a workspace.yml

No single-flag CLI command for "create from yaml"; use HTTP. The config must be
JSON — convert from YAML inline:

```bash
CONFIG=$(python3 -c "import yaml,json,sys; print(json.dumps(yaml.safe_load(open('$1'))))" workspaces/my-thing/workspace.yml)
curl -k -sf -X POST \
  "$FRIDAYD_URL/api/workspaces/create" \
  -H 'Content-Type: application/json' \
  -d "{\"config\":$CONFIG,\"workspaceName\":\"My Thing\"}"
```

Returns `{"workspaceId":"...","path":"...","name":"..."}`. The `workspaceId`
is the runtime ID you'll use in subsequent signal triggers.

Alternative: if the workspace already exists on disk, register it instead of
recreating:

```bash
deno task atlas workspace add -p ./workspaces/my-thing
```

## Update workspaces in-place — use the workspace-api skill, never delete + recreate

**Rule:** when a workspace needs changes, use the `@friday/workspace-api` skill's
typed tools (`upsert_agent`, `upsert_signal`, `upsert_job`, `begin_draft` /
`publish_draft`, etc.). Do not curl partial-config endpoints from chat. Do not
`POST /api/workspaces/:id/update`. Do not `DELETE` + `POST /create`.

**Why typed tools, not curl:**
- They handle draft-vs-live mode automatically.
- They return structured `{ok, diff, structural_issues}` so a single call
  shows you what changed and what's broken.
- They accept the natural shape (full agent config) — the partial REST
  surface accepts only `{prompt?, model?, tools?}` and rejects everything
  else with a generic 400.
- The next dispatch reads fresh config from `workspace.yml` automatically;
  no reload step to manage.

**Why never `/update`:**
- Wholesale config replace, no diff guardrails. `upsert_*` (single change)
  and `begin_draft → upserts → publish_draft` (multi-entity, atomic) cover
  every use case with the same validator and a structured failure report.
- 409s when the workspace has in-flight sessions; a chat turn always does.

**Why never `DELETE` + recreate:**
- Loses durable state (sessions, chats, memory, scratchpad).
- New workspace gets a different id (random, e.g. `grilled_xylem` →
  `fuzzy_plum`). Hardcoded references break silently.

**Tool choice cheatsheet:**

| Change | Tool |
|---|---|
| Edit an agent's prompt / model / tools | `upsert_agent({id, config: <full agent config>})` |
| Add or replace a signal | `upsert_signal({id, config})` |
| Patch a signal's schedule / timezone | `upsert_signal({id, config: <full signal config with edit>})` |
| Delete an agent / signal / job | `delete_agent({id})` / `delete_signal({id})` / `delete_job({id})` |
| Add or replace a job | `upsert_job({id, config})` |
| Multi-entity edits | `begin_draft` → upserts → `validate_workspace` → `publish_draft` |
| Workspace metadata (name, color) | `PATCH /api/workspaces/:id/metadata` (still safe — does not touch runtime) |
| Skill scoping | `POST /api/skills/scoping/:skillId/assignments` |

The raw partial REST surface (`PUT /config/agents/:id`, etc.) still exists for
external automation — but from chat, always use the tools above.

## Guardrails

Friday's API has **no auth on localhost**. You can do real damage fast.
Reversible vs sticky ops:

**Reversible / safe to retry:**
- Any `list`, `status`, `describe`, `get`, `inspect`
- `daemon status`, `health`
- `prompt` / `chat` — creates a chat but doesn't mutate workspace state
- `signal trigger` — creates a session; cancel with `session cancel`

**Sticky — verify before firing:**
- `POST /api/workspaces/create` — writes a directory; dup name → 409
- `POST /api/workspaces/:id/update` — wholesale config replace, no diff guardrails; never call from chat (use `upsert_*` / `publish_draft` instead)
- `PUT /signals/:id`, `PATCH /signals/:id` — persists to workspace.yml
- `DELETE /api/workspaces/:id` — removes the directory entirely (system
  workspaces rejected with 403; userland workspaces just vanish)
- `POST /api/skills/.../upload` — publishes a new version to the registry
- `atlas reset` — wipes `~/.friday/local/` (preserves `.env` and `bin/` only)

**Before a sticky op:**
1. List first — confirm target ID matches expectation
2. Describe — confirm the current state you're about to overwrite
3. Back up if destructive — for workspace.yml writes, pass `"backup": true`
   on `POST /api/workspaces/:id/config`
4. Do the write
5. Verify — re-list or re-describe

**Never** guess workspace IDs. Runtime IDs like `grilled_xylem` look
deterministic but are random per daemon instance. If you can't find it via
`workspace list`, it doesn't exist on this daemon.

## Patterns for the flywheel

The autopilot/self-modification loop uses this surface heavily. See
`references/recipes.md` for end-to-end recipes:

- Author a skill, publish it, assign it to a workspace
- Generate a workspace.yml from a template, create it, fire a smoke-test signal
- Update a single signal's cron schedule without rewriting workspace.yml
- Read narrative memory to pick up an autopilot backlog item
- Deploy and register an SDK agent

**For authoring SDK agents** (NATS clients): use the sibling
`writing-friday-python-agents` skill. The Python SDK (`friday_agent_sdk`) is the
current reference implementation. This skill covers deploy + register;
`writing-friday-python-agents` covers the source.

## Output formats — the `--json` and `--human` convention

Most CLI commands output NDJSON by default (one JSON object per line, final
line is a `cli-summary` with `chatId` / `sessionId` / continuation hints).
`--human` flips to Ink-formatted tables and streaming text. For programmatic
use, always stick with the default NDJSON and parse with `jq`.

HTTP endpoints return JSON unless the request carries `Accept: text/event-stream`
(in which case they stream SSE) or the route is explicitly a tarball / CSV /
image.

## When things go wrong

- **409 Conflict on signal trigger** — workspace has an active session. Cancel
  first: `deno task atlas session cancel <id>`.
- **422 on signal trigger** — your payload fails the signal's JSON Schema, OR
  the workspace config is invalid, OR env vars are missing. The response body
  has the specific reason.
- **404 on a workspace ID that "should" exist** — runtime IDs are per-daemon.
  Re-list.
- **Session starts but no agent output** — check `deno task atlas logs
  --session <id>` (`debugging-friday` skill has the log playbook).
- **`"Signal 'X' not found"` on `POST /signals/:id` immediately after
  creating the signal** — the dispatch read a config snapshot that
  doesn't have the new signal. Two common causes: (a) you used the
  `write_file` tool to edit `workspace.yml`, which writes to
  `{FRIDAY_HOME}/scratch/{sessionId}/` only — the real file never changed.
  Use `run_code` with an absolute path instead. (b) Your config edit
  failed Zod validation, so the workspace's mtime-cached entry rejected
  the new config — check the workspace log for `"Invalid workspace
  configuration detected"`.
- **`"No FSM job handles signal 'X'"` when a cron or HTTP signal fires** —
  the job uses `execution:` only. The runtime silently skips jobs without
  an `fsm:` block. Rewrite as an FSM (see the `workspace-api` skill). The
  error surfaces through the session, not through the trigger call.
- **HTTP trigger returns 404 but `atlas signal trigger` works** — the CLI
  resolves signals through the runtime directly; raw HTTP posts to
  `/api/workspaces/:id/signals/:id` depend on exact id matching. Prefer the
  CLI (`deno task atlas signal trigger -n <name> -w <ws> --data '{}'
  --stream`) when shell-automating — it gives the same path discovery plus
  SSE streaming in one command.

## Read more

- `references/cli.md` — every CLI subcommand with flags, side effects, exit codes
- `references/http.md` — every HTTP route with request/response shape and side effects
- `references/recipes.md` — end-to-end recipes for the autopilot/self-mod flywheel
- `references/session-and-logs.md` — SessionView shape, aiSummary, SSE event types, log structure — the "did it work?" surface
- `writing-friday-python-agents` skill — authoring SDK agents (NATS clients)
- `debugging-friday` skill — log forensics, GCS, multi-hop correlation
- Project docs: `docs/STUDIO_QUICKSTART.md`, `docs/product-map.md`
