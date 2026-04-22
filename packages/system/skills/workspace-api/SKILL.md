---
name: workspace-api
description: "Create, list, and manage workspaces via the daemon HTTP API (localhost:8080). Use when the user asks to create a workspace, space, project, or environment; add or patch signals / agents / jobs / memory / skills on an existing workspace; convert a workspace.yml into a live workspace; or wire up triggers (HTTP webhooks, cron, fs-watch, Slack/Telegram/WhatsApp). Covers the full workspace.yml schema inline so agents without repo source still get accurate field shapes, and calls out the non-obvious runtime rules (fsm-required jobs, scratch-sandboxed write_file, tool-name resolution)."
user-invocable: false
---

# Workspace API

Create and manage Friday workspaces by calling the daemon at `localhost:8080`.
The whole surface is covered here — partner with the `friday-cli` skill only
when you need to trigger signals or inspect sessions.

## Preflight

```bash
curl -sf http://localhost:8080/health && echo OK
```

If that fails, see `friday-cli` for daemon lifecycle.

---

## Top gotchas — read before writing any config

1. **Jobs must use `fsm:`, not `execution:`.** The schema accepts both, but the
   runtime (`packages/workspace/src/runtime.ts:515`) silently skips any job
   without `jobSpec.fsm`. A job with `execution:` only will fail signal
   dispatch at runtime with `"No FSM job handles signal '<name>'"`. Every
   job in this skill uses `fsm:`.
2. **Don't use `write_file` for workspace.yml edits.** The `write_file` tool
   writes to `{ATLAS_HOME}/scratch/{sessionId}/` only. To edit a workspace's
   yml, use `run_code` with an absolute path (details in
   `references/updating-workspaces.md`).
3. **Tool names in `agents.*.config.tools` resolve against
   `tools.mcp.servers.*`** — the platform does not ship `fs_read_file` /
   `fs_write_file` as built-ins for workspace-chat LLM agents. Listing a tool
   name without a configured MCP server that provides it is a no-op.
   *Exception:* the platform ships narrative-memory tools
   (`memory_narrative_append`, `memory_narrative_read`,
   `memory_narrative_forget`) and state tools
   (`state_append`, `state_filter`, `state_lookup`) for both chat and FSM
   LLM agents without any MCP server config.
4. **Never tell the user "saved to memory" without verifying the write
   landed.** Workspace setup can look successful end-to-end — signals
   registered (201), agents listed, job wired — and still have a silent
   failure anywhere in the chain (job skipped, agent lacks `memory_write`,
   HTTP signal never matches a runtime signal, session 404s, FSM guard
   rejects the output). The user won't notice until they ask later and
   memory comes up empty. **Before reporting a successful "saved to memory"
   or "the workspace will log this":**
   1. Fire the signal once with a canary payload (your own test note).
   2. Wait for the session to reach terminal status (`completed` or
      `failed`) via `GET /api/sessions/:id`.
   3. Read back with `GET /api/memory/:workspaceId/narrative/:memoryName`
      and confirm the payload is there.
   4. Only then tell the user the pipeline works. If any step fails,
      surface the failure explicitly — don't paper over it.

---

## Quick start — create a workspace

Everything goes through `POST /api/workspaces/create` with the whole config
inline:

```bash
curl -s -X POST http://localhost:8080/api/workspaces/create \
  -H 'Content-Type: application/json' \
  -d '{
    "config": {
      "version": "1.0",
      "workspace": { "name": "my-workspace", "description": "What it does" },
      "memory": {
        "own": [
          { "name": "user-profile", "type": "long_term",  "strategy": "narrative" },
          { "name": "notes",        "type": "long_term",  "strategy": "narrative" },
          { "name": "scratchpad",   "type": "scratchpad", "strategy": "narrative" }
        ]
      }
    },
    "workspaceName": "my-workspace"
  }'
```

Response at **201 Created**:

```json
{
  "success": true,
  "workspace": { "id": "grilled_xylem", "name": "my-workspace", "path": "...", "configPath": "...", ... },
  "created": true,
  "workspacePath": "...",
  "filesCreated": ["workspace.yml", ".env"]
}
```

The runtime id (`grilled_xylem`-style) is random per daemon. Never hardcode —
always resolve via `GET /api/workspaces`.

**Author JSON directly. Don't write YAML client-side** — the API only takes
JSON. The YAML file on disk is the daemon's business. If you need to read
a config, `GET /api/workspaces/:id/config` returns it pre-parsed as JSON.

---

## The complete `workspace.yml` schema

Every key lives inside `config.` when sent to the create endpoint. `version`
is pinned to `"1.0"`. Unknown keys are rejected.

```yaml
version: "1.0"                    # required, literal "1.0"
workspace:                        # required
  id: "stable-id"                 # optional (platform workspaces pin this)
  name: "display-name"            # required, non-empty
  version: "0.1.0"                # optional
  description: "What this does"   # optional
  timeout:                        # optional
    progressTimeout: "2m"         # default "2m" — inactivity cancellation
    maxTotalTimeout: "30m"        # default "30m" — hard ceiling

signals: { ... }                  # map of triggers
jobs:    { ... }                  # map of FSM pipelines (fsm-required)
agents:  { ... }                  # map of per-workspace agents
memory:  { ... }                  # memory corpora + mounts
resources:     [ ... ]            # first-class declared resources
skills:        [ ... ]            # global or inline skill refs
server:        { ... }            # expose this workspace as MCP
tools:         { ... }            # external MCP servers
notifications: { ... }
federation:    { ... }
improvement: "surface" | "auto"   # default "surface"
```

Duration format everywhere: `\d+[smh]` → `30s`, `5m`, `2h`.

### `signals` — triggers

Keyed by signal id. Discriminated on `provider`:

```yaml
signals:
  run-now:                    # HTTP webhook — POST only
    provider: http
    description: "External webhook"
    schema: { type: object, properties: {...} }   # optional JSON Schema for payload
    config:
      path: "/run-now"                            # required
      timeout: "5m"                               # optional

  daily-summary:              # Cron
    provider: schedule
    description: "9am weekdays"
    config:
      schedule: "0 9 * * 1-5"                     # cron-parser compatible
      timezone: "America/Los_Angeles"             # default "UTC"

  on-drop:                    # Filesystem watcher
    provider: fs-watch
    description: "File lands"
    config:
      path: "./inbox"                             # abs or workspace-relative
      recursive: true                             # default true

  boot:                       # Platform-internal only
    provider: system
    description: "Fires once on workspace boot"

  # Messaging providers — auto-wired where applicable; all env-var fallbacks:
  slack-msg:
    provider: slack
    description: "Slack app event"
    config: { app_id: "" }                        # populated by auto-wire
  tg:
    provider: telegram
    description: "Telegram update"
    config: { bot_token: "", webhook_secret: "" } # env TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET
  wa:
    provider: whatsapp
    description: "WhatsApp message"
    config:                                       # env WHATSAPP_{ACCESS_TOKEN,APP_SECRET,PHONE_NUMBER_ID,VERIFY_TOKEN}
      access_token: ""
      app_secret: ""
      phone_number_id: ""
      verify_token: ""
      api_version: "v21.0"                        # optional
```

### `jobs` — FSM pipelines

Keyed by **MCP tool name** (`[a-zA-Z0-9_-]+`). Every job must have an `fsm:`
block. Jobs declared with only `execution:` pass schema validation but the
runtime skips them silently.

Minimal FSM job (one LLM step):

```yaml
jobs:
  summarize:
    title: "Daily Summary"
    description: "Summarize today's notes"
    triggers:
      - signal: daily-summary
    fsm:
      initial: step_summarize
      states:
        step_summarize:
          type: action
          action:
            type: llm
            agent: summarizer                    # matches agents.summarizer below
            outputSchema:                        # optional structured output
              type: object
              properties:
                summary: { type: string }
              required: [summary]
          next: done
        done:
          type: final
    outputs:
      memory: "notes"                            # where findings land
      entryKind: "summary"
    config:
      timeout: "10m"
      max_steps: 10                              # LLM tool-call iterations
```

Multi-step agent pipelines (what you'd reach for `execution:` to express)
become a linear chain of FSM `action` states:

```yaml
fsm:
  initial: step_scout
  states:
    step_scout:
      type: action
      action: { type: llm, agent: scout }
      next: step_rank
    step_rank:
      type: action
      action: { type: llm, agent: ranker }
      next: step_report
    step_report:
      type: action
      action: { type: llm, agent: reporter }
      next: done
    done: { type: final }
```

Other optional job fields — `prompt` (supervisor guidance), `inputs` (JSON
Schema exposed as MCP tool params), `context.files` (glob patterns +
base_path + max_file_size), `success.condition` / `success.schema`,
`error.condition`, `config.supervision.level` (`"minimal"|"standard"|"detailed"`),
`config.supervision.skip_planning`, arbitrary loose `config.<key>` keys
(read via `context.config.<key>`), `scope_exclusions`,
`improvement: "surface"|"auto"`.

### `agents` — per-workspace agent definitions

Keyed by stable kebab-case id. Discriminated on `type`:

```yaml
agents:
  summarizer:                   # LLM — most common
    type: llm
    description: "Summarizes incoming docs"
    config:
      provider: "anthropic"                       # required
      model: "claude-sonnet-4-6"                  # required
      prompt: "You summarize..."                  # required
      temperature: 0.3                            # default 0.3
      max_tokens: 2000
      max_steps: 10                               # tool-call iterations
      tool_choice: "auto"                         # "auto" | "required" | "none"
      tools: ["fetch_mcp_tool_name"]              # ⚠ resolves via tools.mcp.servers.*
      provider_options: { ... }                   # SDK pass-through
      max_retries: 2
      timeout: "90s"

  conversation:                 # System — built-in platform agent
    type: system
    agent: "conversation-agent"                   # required, platform agent id
    description: "Shared chat handler"
    config:                                       # optional overrides
      model: "claude-sonnet-4-6"
      prompt: "Override system prompt"
      tools: [...]
      use_reasoning: true
      max_reasoning_steps: 10

  my-code-agent:                # User — Python WASM via `atlas agent build`
    type: user
    agent: "my-code-agent"                        # matches build output id
    description: "Custom Python WASM agent"
    prompt: "Additional workspace context"        # optional
    env:                                          # strings OR credential refs
      GITHUB_TOKEN: { credentialId: "cred_abc123" }
      STATIC_VAR: "literal-value"
```

**Tool names warning:** `agents.*.config.tools` is a list of tool-name strings
that must match tools exposed by the MCP servers you wire in
`tools.mcp.servers.*`. There are no platform-default filesystem tools.
Populate `tools.mcp.servers.filesystem` with `@modelcontextprotocol/server-filesystem`
(or equivalent) first, then reference its tool names.

### `memory` — corpora and cross-workspace mounts

```yaml
memory:
  own:                          # corpora this workspace creates
    - name: "user-profile"
      type: "long_term"                           # short_term | long_term | scratchpad
      strategy: "narrative"                       # narrative | retrieval | dedup | kv
    - { name: "notes",      type: "long_term",  strategy: "narrative" }
    - { name: "scratchpad", type: "scratchpad", strategy: "narrative" }

  mounts:                       # read/write other workspaces' memory
    - name: "backlog"
      source: "thick_endive/narrative/autopilot-backlog"  # "{wsId|_global}/{kind}/{name}"
      mode: "ro"                                  # "ro" | "rw"
      scope: "workspace"                          # "workspace" | "job" | "agent"
      scopeTarget: "summarize"                    # required when scope != workspace
      filter:                                     # optional narrowing
        status: ["open", "triaged"]
        priority_min: 2
        since: "2026-04-01T00:00:00Z"

  shareable:
    list: ["notes"]
    allowedWorkspaces: ["fuzzy_plum"]
```

**Standard baseline:** unless told otherwise, include the three narrative
`own` corpora above — `user-profile`, `notes`, `scratchpad`. Persistent
state across sessions lives here.

#### Reading and writing narrative memory at runtime

**Reads auto-inject into the chat system prompt.** The workspace-chat runtime
fetches every declared narrative memory on every turn
(`GET /api/memory/:workspaceId/narrative/:memoryName?limit=20`) and flattens
the entries into `<memory workspace="…">` blocks in the system prompt. An
agent in chat already *sees* recent narrative entries without calling
anything — so reach for `memory_narrative_read` only when you need older
entries, a specific `since` cutoff, or more than the default 20.

**Writes go through `memory_narrative_append`:**

```
memory_narrative_append({
  workspaceId: "grilled_xylem",
  memoryName: "notes",                   // must be declared in memory.own OR a mount
  entry: {
    text: "User prefers morning meetings.",
    metadata: { source: "2026-04-17 chat" }
  }
})
```

The tool validates `memoryName` against `memory.own` / `memory.mounts` before
writing — undeclared names are rejected with a list of what IS declared.
`ro` mounts reject writes; `rw` mounts rewrite to the source workspace
transparently. `id` and `createdAt` are filled in if omitted. Companion
tools: `memory_narrative_read(workspaceId, memoryName, since?, limit?)` and
`memory_narrative_forget(workspaceId, memoryName, entryId)`.

**FSM jobs can also call these three tools.** They're in the FSM LLM
allowlist, so a `type: llm` agent inside a job can append to memory without
needing a code action or a `type: atlas` agent. The validator still runs,
so a job can only write corpora the workspace declares.

**Memory vs session state.** Narrative memory is the persistence surface the
user sees next time — use it for notes that should survive. `state_append` /
`state_filter` / `state_lookup` are **session-scoped** (SQLite, per-workspace
state.db, no cross-session replay into the prompt) — use them for working
data inside a job pipeline that the next session shouldn't see.

**Building a workspace that recalls information.** Declare the corpora you
need in `memory.own`, then let the chat agent call `memory_narrative_append`
whenever the user says something worth remembering, or have a job's FSM step
write to memory as its final action. No jobs, signals, or resources are
needed just for persistence — memory alone is enough.

### `resources` — declared data references

Tagged union, four `type` variants. Every variant needs `slug`, `name`,
`description`. Additional per-type fields:

- `type: document` — `schema: {...}` (JSON Schema for document structure).
- `type: prose` — free-form; no extra fields.
- `type: artifact_ref` — `artifactId: "..."` (points at an existing artifact).
- `type: external_ref` — `provider: "notion|drive|..."`, optional `ref` (URL),
  optional `metadata: {...}`.

These are *declared* resources in config.

### `skills` — global and inline skill entries

```yaml
skills:
  - name: "@tempest/debugging-friday"            # global ref (@namespace/name)
    version: 3                                   # optional pin; omit for latest
  - name: "ad-hoc-skill"                         # inline (workspace-local)
    inline: true
    description: "Short prose (no < or > chars)"
    instructions: |
      Skill body in markdown.
```

Name/namespace: lowercase alphanumeric + single hyphens. Reserved words
(`anthropic`, `claude`) are rejected.

### `server` — expose this workspace as an MCP server

```yaml
server:
  mcp:
    enabled: false
    discoverable:
      capabilities: ["workspace_*"]
      jobs: ["review-*"]
```

Extended platform-wide fields (`transport`, `auth`, `rate_limits`) only work
in `friday.yml`. See `references/platform-friday-yml.md`.

### `tools` — external MCP servers agents can call

```yaml
tools:
  mcp:
    client_config:
      timeout: { progressTimeout: "2m", maxTotalTimeout: "30m" }
    servers:
      filesystem:
        transport:
          type: stdio
          command: "npx"
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp/friday-scratch"]
```

Tool names exposed by these servers are what you list in
`agents.*.config.tools`. Platform-wide allow/deny policies live in
`friday.yml` (see `references/platform-friday-yml.md`).

---

## Updating an existing workspace

Three paths, in preference order. Full recipes and decision tree live in
`references/updating-workspaces.md` — read it when you're adding agents,
adding jobs, or any change the partial-update API doesn't cover.

| Need | Path |
|---|---|
| Add/update/delete a **signal** | `POST/PUT/PATCH/DELETE /api/workspaces/:id/config/signals[/:id]` |
| Update an **agent's prompt/model/tools** | `PUT /api/workspaces/:id/config/agents/:id` |
| Swap a **credential** reference | `PUT /api/workspaces/:id/config/credentials/:path` |
| Rename / recolor metadata | `PATCH /api/workspaces/:id/metadata` |
| Add a **new agent**, add a **new job**, restructure FSM, edit `skills:` list | Edit `workspace.yml` on disk via `run_code` with an absolute path — the file watcher hot-reloads |
| Full rebuild (last resort) | `DELETE` + `POST /api/workspaces/create` |

**There is no `POST /api/workspaces/:id/config` full-replace endpoint.** Don't
try — it 404s.

**`write_file` ≠ disk write.** The `write_file` tool is sandboxed to
`{ATLAS_HOME}/scratch/{sessionId}/`. To actually edit `workspace.yml`, use
`run_code` with an absolute path:

```python
import json

workspace_path = "/Users/kenneth/.atlas/workspaces/my-workspace/workspace.yml"

# 1. Read current config as JSON via the API, not by parsing YAML
# 2. Mutate the dict
# 3. Write YAML back with a small stringifier, OR:

# Emit YAML by going through run_code with language: javascript
# (Deno has @std/yaml built in, no install step)
```

`run_code` (javascript) for the YAML write step:

```javascript
import { stringify } from "jsr:@std/yaml";
import { writeFileSync } from "node:fs";

const config = JSON.parse(Deno.env.get("CONFIG_JSON"));
writeFileSync(
  "/Users/kenneth/.atlas/workspaces/my-workspace/workspace.yml",
  stringify(config),
);
console.log("ok");
```

The file watcher (`packages/workspace/src/watchers/config-file-watcher.ts`)
hashes the new content, validates against `WorkspaceConfigSchema`, destroys
the runtime, and lets it re-create on the next signal. If a session is
active, the reload defers via `pendingWatcherChanges` until idle. Runtime id,
sessions, memory, scratchpad — all preserved.

**Why not DELETE + CREATE?** Delete-then-create loses the runtime id (new
random word pair), kills any active sessions, and is visible to anything
holding the old id (cron targets, cross-workspace mounts, hardcoded refs).
Only do it if the partial API and disk edit both won't work.

---

## `friday.yml` — platform superset

`friday.yml` is the daemon's top-level config (loaded from the workspace
parent directory at startup). Optional; defaults work with just
`ANTHROPIC_API_KEY`. It's a superset of `workspace.yml` with three extra
blocks: `models` (per-archetype LLM selection), extended `server.mcp`
(transport/auth/rate_limits), and extended `tools.mcp.tool_policy`.

Full field-by-field walkthrough with worked examples and credential
resolution rules: `references/platform-friday-yml.md`.

---

## Error codes

`POST /api/workspaces/create`:

- **400** — malformed JSON body.
- **409** — workspace name already exists.
- **422** — schema validation failed; response body enumerates Zod errors.
- **500** — internal (filesystem / ledger).

Partial-update routes:

- **404** — workspace / signal / agent id not found.
- **405** — route not allowed (`POST /config/agents` — agents are FSM-wired,
  can't be added via partial update).
- **409** — dup id on `POST /config/signals`.
- **422** — merged config fails schema.

`DELETE /api/workspaces/:id`:

- **403** — refused for system workspaces (`thick_endive`, `atlas-conversation`, etc.).

---

## Pre-create checklist

1. Name is unique (`GET /api/workspaces`).
2. `version` is literal `"1.0"`.
3. Every job has an `fsm:` block — NOT just `execution:`.
4. Every signal `provider` is one of the documented discriminants.
5. Agent ids in `agents.*` match the `agent:` refs inside `jobs.*.fsm.states.*.action`.
6. Tool names in `agents.*.config.tools` are provided by a server in
   `tools.mcp.servers.*`.
7. Cron schedules parse (`crontab.guru`).
8. Memory mount sources match `"{workspaceId|_global}/{kind}/{memoryName}"`.
9. Skill names don't contain reserved words (`anthropic`, `claude`).

---

## Workflow

1. Ask what the workspace should do.
2. Pick a short kebab-case name + 1-sentence description.
3. Build the config as a **Python dict**, dump via `json.dumps`, POST.
4. Parse the response, confirm `workspace.id`.
5. Share the id with the user so they can reference it.
6. For triggering signals + observing sessions, hand off to the `friday-cli`
   skill.

Keep additions minimal — extra signals, jobs, and agents the user didn't ask
for become code they now have to understand. `workspace.yml` can be edited
later on disk (see `references/updating-workspaces.md`).

---

## Go deeper

- `references/updating-workspaces.md` — full three-path guide for editing
  existing workspaces (partial API, disk-edit via `run_code`, delete-recreate).
  Read before adding a new agent or job.
- `references/platform-friday-yml.md` — `friday.yml` platform superset:
  `models`, extended server + tool-policy. Read when configuring LLM
  providers or the platform MCP surface.
