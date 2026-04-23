---
name: friday-cli
description: "Interact with a running Friday daemon via CLI and HTTP — list/create/modify workspaces, trigger signals, watch sessions, publish skills and agents. Use whenever you need to poke at a local Friday daemon, inspect its state, fire a signal, drive the autopilot / self-modification flywheel, create a workspace programmatically, or validate that a workspace.yml you just authored actually runs. Also use when the task involves `localhost:8080`, `deno task atlas`, curl-ing the daemon, or automating Friday itself."
user-invocable: false
---

# Friday CLI & HTTP

Friday is orchestrated by a daemon on `localhost:8080`. There are two surfaces
for interacting with it: the `deno task atlas` CLI (thin HTTP client, great for
humans and shell scripts) and the raw HTTP API (more endpoints, SSE streaming,
the only option for many CRUD ops on workspace internals).

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
# or:
curl -sf http://localhost:8080/health && echo OK
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
curl -s http://localhost:8080/api/workspaces/<id>/signals | jq
```

The signal's `schema` is a JSON Schema — your payload must match it or the
trigger returns 400.

### 3. Fire a signal and stream the session

```bash
deno task atlas signal trigger -n <signal-name> -w <workspace> \
  --data '{"some":"payload"}' --stream
```

Or via HTTP with SSE:

```bash
curl -N -X POST http://localhost:8080/api/workspaces/<id>/signals/<signal-id> \
  -H 'Content-Type: application/json' \
  -H 'Accept: text/event-stream' \
  -d '{"payload":{"some":"value"}}'
```

The payload MUST be wrapped in `{"payload": {...}}` for HTTP. The CLI unwraps
this for you.

### 4. Watch a running session's agent activity + read the outcome

```bash
deno task atlas session list --json           # find the session
deno task atlas session get <session-id> --json  # full SessionView
```

SSE replay/live stream (survives reconnect within the replay window):

```bash
curl -N http://localhost:8080/api/sessions/<id>/stream \
  -H 'Accept: text/event-stream'
```

After the session finalizes, `SessionView` has an `aiSummary` field with a
human-readable summary + keyDetails (with URLs). Prefer it over walking
`agentBlocks[]` when you just want "what happened":

```bash
curl -s http://localhost:8080/api/sessions/<id> | jq '.aiSummary'
```

Full shape + failure extraction recipes + log access + SSE event types →
**`references/session-and-logs.md`**. Load it any time you need to answer
"did the signal succeed, what happened, any errors".

### 5. Create a workspace from a workspace.yml

No single-flag CLI command for "create from yaml"; use HTTP. The config must be
JSON — convert from YAML inline:

```bash
CONFIG=$(python3 -c "import yaml,json,sys; print(json.dumps(yaml.safe_load(open('$1'))))" workspaces/my-thing/workspace.yml)
curl -s -X POST http://localhost:8080/api/workspaces/create \
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

## Update workspaces in-place — never delete + recreate

**Rule:** when a workspace needs changes, mutate its `workspace.yml` via the
partial-config endpoints. Do not `DELETE /api/workspaces/:id` followed by a
`POST /api/workspaces/create`.

**Why:**
- Delete + recreate loses runtime state (sessions, chats, memory entries,
  scratchpad notes).
- The new workspace gets a different runtime ID (random, e.g.
  `grilled_xylem` → `fuzzy_plum`). Anything hardcoded against the old ID
  (autopilot cron targets, cross-workspace references, memory paths)
  silently breaks.
- Active sessions are terminated.

In-place updates destroy only the active runtime (which reboots cleanly on the
next signal) and preserve workspace identity + durable state.

**The partial-update surface (all mutate workspace.yml directly):**

| Change | Method + path |
|---|---|
| Add signal | `POST /api/workspaces/:id/config/signals` — body `{signalId, signal: WorkspaceSignalConfig}` |
| Replace signal | `PUT /api/workspaces/:id/config/signals/:signalId` — body `WorkspaceSignalConfig` |
| Patch signal (schedule, timezone) | `PATCH /api/workspaces/:id/config/signals/:signalId` — body `SignalConfigPatchSchema` |
| Delete signal | `DELETE /api/workspaces/:id/config/signals/:signalId?force=true` |
| Update agent prompt/model/tools | `PUT /api/workspaces/:id/config/agents/:agentId` — body `{prompt?, model?, tools?}` |
| Swap credential reference | `PUT /api/workspaces/:id/config/credentials/:path` — body `{credentialId}` |
| Update workspace metadata (name, color) | `PATCH /api/workspaces/:id/metadata` |

**What the partial-update surface can NOT do in-place:**
- **Add a new agent** — agents are FSM-wired; `POST /agents` returns 405. To
  add a new agent you must update the FSM states (see fallback below).
- **Add or remove jobs** — no dedicated endpoint.
- **Edit FSM states / documentTypes / transitions** — no dedicated endpoint.
- **Add or remove skills from a workspace's `skills:` list** — use skill
  scoping (`POST /api/skills/scoping/:skillId/assignments`) instead, which is
  the runtime source of truth for which skills a workspace sees.

**Fallback for changes the partial surface can't cover:** edit
`workspace.yml` on disk, then `POST /api/workspaces/:id/config` with
`{"config": <parsed yaml>, "backup": true}`. This is a full replacement (still
destroys the runtime, preserves the workspace ID + state). Always back up.
Never use `DELETE` + `create` as a shortcut.

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
- `POST /api/workspaces/:id/config` — full replacement; destroys active runtime
- `PUT /signals/:id`, `PATCH /signals/:id` — persists to workspace.yml
- `DELETE /api/workspaces/:id` — removes the directory entirely (system
  workspaces rejected with 403; userland workspaces just vanish)
- `POST /api/skills/.../upload` — publishes a new version to the registry
- `atlas reset` — wipes `~/.atlas/` (preserves `.env` and `bin/` only)

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
- Build and register a Python WASM agent

**For authoring Python WASM agents** (agent.py, `@agent` decorator, `ctx.llm` /
`ctx.http` / `ctx.tools` APIs, JSON Schema strict mode rules): use the sibling
`writing-friday-agents` skill.
This skill covers build + register; `writing-friday-agents` covers the source.

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
- **HTTP route returns HTML instead of JSON** — you hit the web-client dev
  server on :15200 by accident. The daemon is :8080.
- **`"Signal 'X' not found"` on `POST /signals/:id` immediately after
  creating the signal** — the runtime hasn't seen the edit yet. Three
  common causes: (a) you used the `write_file` tool to edit `workspace.yml`,
  which writes to `{ATLAS_HOME}/scratch/{sessionId}/` only — the real file
  never changed. Use `run_code` with an absolute path instead. (b) Your
  config edit failed Zod validation — check the workspace log for
  `"Invalid workspace configuration detected, skipping reload"`. (c) An
  active session deferred the reload — wait for it to finish or cancel it.
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
- `writing-friday-agents` skill — authoring Python WASM agents
- `debugging-friday` skill — log forensics, GCS, multi-hop correlation
- Project docs: `docs/STUDIO_QUICKSTART.md`, `docs/product-map.md`