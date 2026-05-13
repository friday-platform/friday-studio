# Updating an existing workspace

Read this when you're about to change anything about a workspace that already
exists: adding a signal, adding an agent, adding a job, editing an FSM, or
restructuring. The path you pick matters — one path preserves runtime state,
another quietly loses it.

> **Preamble — source the daemon env once per shell.** Every curl example
> below uses `$FRIDAYD_URL` and a `friday_curl` helper that adds `--cacert`
> when TLS is on. Paste this once and the examples below work on both
> plain-HTTP and TLS-enabled installs:
>
> ```bash
> set -a
> . "${FRIDAY_HOME:-$HOME/.friday/local}/.env" 2>/dev/null \
>   || . "$HOME/.atlas/.env" 2>/dev/null || true
> set +a
> friday_curl() { curl ${FRIDAY_TLS_CA:+--cacert "$FRIDAY_TLS_CA"} "$@"; }
> ```


**Rule: every daemon HTTP call below uses `friday_curl`, not `curl`.** Plain `curl` against `$FRIDAYD_URL` on a TLS install fails with `self signed certificate in certificate chain`.
## Contents

- The three paths (preference order)
- Partial-update API (signals / agent prompt / credentials)
- Disk edit via `run_code` (agents / jobs / FSM / skills list)
- Why `write_file` doesn't work
- DELETE + CREATE (last resort)
- Troubleshooting

## The three paths

| Path | Covers | Preserves runtime id, sessions, memory? |
|---|---|---|
| **1. Partial-update API** | signals (full CRUD), agent prompt/model/tools edit, credential swap, metadata | Yes |
| **2. Disk edit via `run_code`** | everything else — add agents, add jobs, restructure FSM, edit `skills:` list | Yes |
| **3. DELETE + CREATE** | rebuild from scratch | **No** — new runtime id, sessions killed, cron targets break |

Prefer 1 → 2 → 3 in that order. Only drop to 3 when the schema shape itself
is changing incompatibly.

## 1. Partial-update API

Mount: `/api/workspaces/:id/config`. Every mutation here writes to
`workspace.yml` AND destroys the active runtime so it reloads on next signal.

### Signals — full CRUD

```bash
# List
friday_curl -s "$FRIDAYD_URL/api/workspaces/$WS/config/signals" | jq

# Get one
friday_curl -s "$FRIDAYD_URL/api/workspaces/$WS/config/signals/daily-summary" | jq

# Create — 201 on success, 409 on dup id
friday_curl -s -X POST "$FRIDAYD_URL/api/workspaces/$WS/config/signals" \
  -H 'Content-Type: application/json' \
  -d '{
    "signalId": "generate-report",
    "signal": {
      "provider": "http",
      "description": "Generate a report on demand",
      "config": { "path": "/generate-report" }
    }
  }'

# Full replace
friday_curl -s -X PUT "$FRIDAYD_URL/api/workspaces/$WS/config/signals/daily-summary" \
  -H 'Content-Type: application/json' \
  -d '{
    "provider": "schedule",
    "description": "Fire at 10am weekdays instead",
    "config": { "schedule": "0 10 * * 1-5", "timezone": "America/Los_Angeles" }
  }'

# Patch (loose — merged with existing)
friday_curl -s -X PATCH "$FRIDAYD_URL/api/workspaces/$WS/config/signals/daily-summary" \
  -H 'Content-Type: application/json' \
  -d '{"config":{"schedule":"*/15 * * * *","timezone":"UTC"}}'

# Delete — 409 if a job triggers on it; pass ?force=true to cascade
friday_curl -s -X DELETE "$FRIDAYD_URL/api/workspaces/$WS/config/signals/daily-summary?force=true"
```

### Agents — update only

Agents are FSM-wired via `workspace.yml`. You can update their
prompt/model/tools but NOT add or delete via the API:

```bash
# Update prompt + model + tools
friday_curl -s -X PUT "$FRIDAYD_URL/api/workspaces/$WS/config/agents/summarizer" \
  -H 'Content-Type: application/json' \
  -d '{
    "prompt": "You produce a rigorous end-of-day summary.",
    "model": "claude-sonnet-4-6",
    "tools": ["fetch", "search"]
  }'

# POST → 405 Method Not Allowed
# DELETE → 405 Method Not Allowed
```

To add a new agent, use Path 2 (disk edit).

### Credentials

```bash
# List refs — paths are "mcp:<server>:<ENV>" or "agent:<agent>:<ENV>"
friday_curl -s "$FRIDAYD_URL/api/workspaces/$WS/config/credentials" | jq

# Swap — validates the new credential matches the provider; 400 on mismatch
friday_curl -s -X PUT "$FRIDAYD_URL/api/workspaces/$WS/config/credentials/agent:gh-agent:GITHUB_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"credentialId":"cred_abc123"}'
```

### Metadata (name, color)

```bash
friday_curl -s -X PATCH "$FRIDAYD_URL/api/workspaces/$WS/metadata" \
  -H 'Content-Type: application/json' \
  -d '{"name":"New Display Name","color":"#ff0066"}'
```

### What the partial API can't do

- Add a new agent
- Add a new job
- Delete an agent
- Delete a job
- Edit FSM states / transitions inside a job
- Edit the `skills:` list (use scoping: `POST /api/skills/scoping/:skillId/assignments`)
- Edit `resources:` declarations
- Edit `memory.own` / `memory.mounts`
- Edit `tools.mcp.servers.*`

For any of those, go to Path 2.

## 2. Disk edit via `run_code`

The daemon watches `workspace.yml` for every registered workspace. Edits on
disk trigger a hash-check, validate against the config schema, destroy the
active runtime, and ready it for the next signal. Active sessions defer the
reload until they complete.

That means: if you can write to `workspace.yml`, the runtime picks it up.
Runtime id, sessions, and memory are all preserved.

### Step-by-step

```python
# run_code, language: python
import json, os, ssl, urllib.request

WS = "grilled_xylem"
WS_PATH = "/path/to/.friday/local/workspaces/my-workspace/workspace.yml"

# 1. Read current config (API gives parsed JSON — no YAML parsing needed).
#    FRIDAYD_URL + FRIDAY_TLS_CA are exported by the daemon's launcher
#    (installed Friday Studio) or `bash scripts/setup-tls.sh` (in-tree
#    dev). Don't hardcode a default — installed Studio runs on :18080,
#    dev on :8080, and FRIDAY_PORT_FRIDAY can override either. If the env
#    var is missing, fail loud rather than silently misroute.
daemon_url = os.environ["FRIDAYD_URL"]
ca = os.environ.get("FRIDAY_TLS_CA")
ctx = ssl.create_default_context(cafile=ca) if ca else None
with urllib.request.urlopen(f"{daemon_url}/api/workspaces/{WS}/config", context=ctx) as resp:
    config = json.load(resp)["config"]

# 2. Mutate the dict
config.setdefault("agents", {})["map-builder"] = {
    "type": "llm",
    "description": "Generates an interactive map",
    "config": {
        "provider": "anthropic",
        "model": "claude-sonnet-4-6",
        "prompt": "You build HTML maps from listings data.",
    },
}
config.setdefault("jobs", {})["build-map"] = {
    "title": "Build map",
    "triggers": [{"signal": "generate-map"}],
    "fsm": {
        "initial": "step_build",
        "states": {
            "step_build": {
                "type": "action",
                "action": {"type": "llm", "agent": "map-builder"},
                "next": "done",
            },
            "done": {"type": "final"},
        },
    },
}

# 3. Stash the config JSON to scratch so the next run_code call can pick it up
with open("/tmp/config.json", "w") as f:
    json.dump(config, f)
print("ready")
```

Then write it back as YAML using Deno's built-in `@std/yaml` (no install
step):

```javascript
// run_code, language: javascript
import { stringify } from "jsr:@std/yaml";
import { readFileSync, writeFileSync } from "node:fs";

const config = JSON.parse(readFileSync("/tmp/config.json", "utf8"));
const yaml = stringify(config);

const WS_PATH = "/path/to/.friday/local/workspaces/my-workspace/workspace.yml";
writeFileSync(WS_PATH, yaml);
console.log("wrote", yaml.length, "bytes");
```

Or skip YAML entirely and keep the file as JSON-flavored YAML — the daemon's
`@std/yaml` parser handles JSON as a YAML subset:

```python
# run_code, language: python
import json
WS_PATH = "/path/to/.friday/local/workspaces/my-workspace/workspace.yml"
with open(WS_PATH, "w") as f:
    json.dump(config, f, indent=2)
```

Ugly-looking but valid. Prefer the `@std/yaml` route for files humans will
read.

### Finding the workspace path

The `path` field in `GET /api/workspaces/:id` returns the workspace directory.
Append `/workspace.yml`:

```bash
WS_PATH=$(friday_curl -s "$FRIDAYD_URL/api/workspaces/$WS" | jq -r '.path')/workspace.yml
```

Or read `configPath` directly:

```bash
friday_curl -s "$FRIDAYD_URL/api/workspaces/$WS" | jq -r '.configPath'
```

### Verifying the reload

```bash
# After writing, wait ~1s for the debouncer, then confirm the new shape
sleep 1
friday_curl -s "$FRIDAYD_URL/api/workspaces/$WS/config" \
  | jq '.config | {agents: (.agents // {} | keys), jobs: (.jobs // {} | keys)}'
```

If the workspace logs show `"Invalid workspace configuration detected, skipping reload"`,
the YAML parsed but failed Zod validation — the old runtime is still in
place. Fix and re-write.

## Why `write_file` doesn't work

The `write_file` tool in workspace chat is sandboxed to a per-session scratch
directory. Absolute paths and `..` escapes are rejected. It's for staging
intermediate data between `run_code` calls in the same session.

Writing what looks like `workspace.yml` via `write_file` just creates a file
in the scratch directory — invisible to the daemon. That's the bug that forces
agents into unnecessary DELETE + CREATE loops.

`run_code`, in contrast, can read and write anywhere the user account can —
which includes the workspace directory.

## 3. DELETE + CREATE (last resort)

Only drop to this when neither the partial API nor the disk-edit path works
— e.g. the schema itself changed incompatibly, or the workspace is
corrupted beyond repair.

```bash
# Capture the old runtime id so you know what's about to change
OLD_WS=$(friday_curl -s "$FRIDAYD_URL/api/workspaces" | jq -r '.[]|select(.name=="my-workspace")|.id')

# Hard delete (directory + registration)
friday_curl -s -X DELETE "$FRIDAYD_URL/api/workspaces/$OLD_WS"

# Re-create
friday_curl -s -X POST "$FRIDAYD_URL/api/workspaces/create" \
  -H 'Content-Type: application/json' \
  -d "{\"config\":$(cat new-config.json),\"workspaceName\":\"my-workspace\"}"
```

What you lose:

- The old runtime id (`grilled_xylem` → something new). Anything
  hardcoded against the old id is now broken: cron targets in other
  workspaces, cross-workspace memory mounts (`"grilled_xylem/narrative/..."`),
  chat references, skill scoping.
- Active sessions (terminated).
- Chats tied to the old workspace id.
- Memory entries (unless you exported first).

Back up first via `GET /api/workspaces/:id/export` (returns a tarball of
`workspace.yml` + resource data).

Delete is rejected with **403** for system workspaces (`thick_endive`,
`atlas-conversation`, etc.).

## Troubleshooting

**"Signal 'X' not found" right after partial update.** Rare — the
partial-update handler destroys the runtime synchronously before returning
200. If you see this, either (a) the workspace wasn't actually updated (check
the `workspace.yml` content — was it your `write_file` to scratch?), or (b)
the workspace has an active session that's blocking the reload (check
`GET /api/workspaces/:id` for `status: "active"`; wait or cancel the session).

**"No FSM job handles signal 'X'" when the cron fires.** Your job uses
`execution:` instead of `fsm:`. Rewrite as an FSM with `initial` and `states`
(see the minimal example in `SKILL.md`). Jobs without an `fsm:` block are
silently skipped by the runtime.

**File edit doesn't reload.** Confirm the file content hash actually changed
(the watcher skips no-op writes). Confirm the new YAML is valid — the watcher
logs `"Invalid workspace configuration detected, skipping reload"` with
validation errors when it isn't.

**Deferred reload.** If a session is active when you write the file, the
reload is deferred until the session completes. Either wait, or cancel the
session.

**404 on `POST /api/workspaces/:id/config`.** That route doesn't exist.
There is no full-replace endpoint. Use the disk-edit path instead.
