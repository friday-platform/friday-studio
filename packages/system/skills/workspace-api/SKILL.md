---
name: workspace-api
description: "Create, list, and manage workspaces via the daemon HTTP API (localhost:8080). Use when the user asks to create or edit a workspace, space, project, or environment; add or patch signals / agents / jobs / memory / skills; convert a workspace.yml into a live workspace; or wire up triggers (HTTP webhooks, cron, fs-watch, Slack / Telegram / WhatsApp)."
user-invocable: false
---

# Workspace API

Create and manage Friday workspaces. This skill teaches the shape; the
`workspace_create` tool enforces it. Companion skill for signals/sessions:
`friday-cli`.

## Preflight

```bash
curl -sf http://localhost:8080/health && echo OK
```

If that fails, see `friday-cli` for daemon lifecycle.

---

## Top gotchas — read before writing any config

1. **Jobs must use `fsm:`, not `execution:`.** The schema accepts both; the
   runtime silently skips any job lacking `fsm:` and signal dispatch fails
   at runtime with `"No FSM job handles signal '<name>'"`.

2. **FSM shape is XState-style.** States are
   `{ entry: [...actions], on: { EVENT: { target: 'next' } } }` or
   `{ type: 'final' }`. Do **not** use `type: action, action: {...}, next: ...`
   — the validator rejects it with `fsm_structural_error`.

3. **`write_file` writes to scratch only** (`{ATLAS_HOME}/scratch/{sessionId}/`).
   To edit a workspace on disk, use `run_code` with an absolute path.

4. **Tool names in `agents.*.config.tools` resolve against `tools.mcp.servers.*`.**
   There are no platform-default filesystem tools. Listing a tool name without
   a configured MCP server that provides it is a no-op. *Exception:* the
   platform ships memory tools (`memory_save`, `memory_read`, `memory_remove`)
   and state tools (`state_{append,filter,lookup}`) for both chat and FSM LLM
   agents without any MCP server config.

5. **Never report "saved to memory" without verifying.** Setup can look
   successful end-to-end and still silently fail. Before reporting success:
   1. Fire the signal once with a canary payload.
   2. Poll `GET /api/sessions/:id` until terminal (`completed` / `failed`).
   3. Read back with `GET /api/memory/:workspaceId/narrative/:memoryName`.
   4. Surface any mismatch explicitly — don't paper over it.

---

## How chat reaches your workspace — the contract

**Chat interacts with your workspace through `jobs`. Nothing else.** Agents
and MCP servers are internals of the jobs that wrap them. This is the single
most important mental model to get right:

```
user message → workspace-chat (platform meta-agent)
                      │
                      ├─ calls memory_save / memory_read (built-in)
                      │
                      └─ calls <job-name> tool → fires signal → FSM runs
                                                     │
                                                     └─ invokes agents, uses MCP tools
                                                        (all internal to this job)
```

**What this means for authoring:**

- **Declaring an agent without a job that invokes it makes the agent
  unreachable from chat.** Chat can't call agents directly, only jobs. A
  lone `agents.kb-agent` with MCP tools attached will sit idle while the
  user's save/retrieve requests get handled by chat's defaults. The
  validator rejects this shape with `unreachable_agent`.
- **For trivial save-and-recall** (notes, URLs, quotes, reading list),
  **skip jobs and agents entirely.** Declare only a `memory.own.notes`
  corpus — chat will use `memory_save` to save and auto-read
  the entries out of its prompt. Zero agents, zero MCP, zero FSM. See
  `assets/example-kb-workspace.yml`.
- **For anything non-trivial** (structured data, signal-triggered
  automation, multi-step work), **express it as one or more jobs.** Each
  job declares a signal, an FSM, and agents internal to that FSM. Chat
  sees the jobs as tools (via `createJobTools`) and calls them with
  typed input. See `assets/example-jobs-pipeline.yml`.

There is no third path. "Standalone conversation agent with MCP tools, no
jobs" is a dead-end shape.

---

## Quick start — create a workspace

**Always call the `workspace_create` tool. Never shell out to curl.** One
typed call, structured errors on 422, fix-and-retry in the same conversation.

### Pick a template — match to the use case

**Trivial save-and-recall → `assets/example-kb-workspace.yml`.** No jobs,
no agents, no MCP. Just a `memory.own.notes` corpus. Chat uses
`memory_save` to save; recent entries auto-inject into
chat's prompt on every turn for retrieval. Use for notes, URLs, quotes,
reading list, journaling, "second brain" — anything unstructured.

**Signal-triggered or multi-step work → `assets/example-jobs-pipeline.yml`.**
One signal per user-invokable operation; each signal has a job with an
FSM; agents live inside the FSM. Chat sees the jobs as tools. Use for
anything structured (tag-filtered bookmarks, expense tracker, invoice
processor), anything signal-driven (webhook / cron / fs-watch), or
anything multi-step (triage → classify → respond pipelines).

If neither template fits, read the schema below and build from scratch —
but verify first: trivial save-and-recall almost always fits the first
template, and anything beyond that almost always fits the second.

```
workspace_create({
  config: {
    version: "1.0",
    workspace: { name: "my-space", description: "What it does" }
  },
  workspaceName: "my-space"   // optional; kebab-case directory name
})
```

### Fix-and-retry loop (worked example)

**Attempt 1 — wrong package name:**

```
workspace_create({ config: { ..., tools: { mcp: { servers: { sqlite: {
  transport: { command: "npx", args: ["-y", "mcp-sqlite"] }
} } } } } })
// → 422 {
//   code: "npm_package_not_found",
//   path: "tools.mcp.servers.sqlite.transport.args",
//   message: "npm package 'mcp-sqlite' returned 404"
// }
```

**Attempt 2 — corrected (SQLite ships on PyPI, use `uvx`):**

```
workspace_create({ config: { ..., tools: { mcp: { servers: { sqlite: {
  transport: { command: "uvx",
               args: ["mcp-server-sqlite", "--db-path", "/abs/path/kb.sqlite"] }
} } } } } })
// → 201 {
//   success: true,
//   workspace: { id: "buttery_gouda", name: "my-space", path: "..." },
//   ...
// }
```

Read every issue in `result.error.detail.data.report.issues[]` and fix them
all before retrying — a second 422 with the same code signals a real
misunderstanding, not a typo. Common codes: `npm_package_not_found`,
`pypi_package_not_found`, `unknown_agent_id`, `unknown_signal_name`,
`unknown_mcp_server_ref`, `unknown_memory_corpus`, `fsm_structural_error`.

Never hardcode the runtime id (`buttery_gouda`-style, random per daemon) —
resolve via `GET /api/workspaces`.

---

## The workspace.yml schema

Every key lives inside `config.` when sent to `workspace_create`. `version` is
pinned to `"1.0"`. Unknown keys are rejected. Duration format everywhere:
`\d+[smh]` → `30s`, `5m`, `2h`.

Top-level keys covered below: `workspace`, `signals`, `jobs`, `agents`,
`memory`, `resources`, `skills`, `server`, `tools`. Plus a top-level
`improvement: "surface" | "auto"` flag.

### `workspace` — identity and timeouts

```yaml
workspace:
  id: "stable-id"              # optional (platform workspaces pin this)
  name: "display-name"         # required, non-empty
  description: "What this does"
  timeout:                     # defaults: progressTimeout 2m, maxTotalTimeout 30m
    progressTimeout: "2m"
    maxTotalTimeout: "30m"
```

### `signals` — triggers

```yaml
signals:
  run-now:                     # HTTP webhook — POST only
    provider: http
    description: "External webhook"
    schema: { type: object, properties: { ... } }
    config:
      path: "/run-now"
      timeout: "5m"            # optional

  daily-summary:               # Cron
    provider: schedule
    config:
      schedule: "0 9 * * 1-5"                    # cron-parser compatible
      timezone: "America/Los_Angeles"            # default "UTC"

  on-drop:                     # Filesystem watcher
    provider: fs-watch
    config:
      path: "./inbox"                            # abs or workspace-relative
      recursive: true

  boot:                        # Platform-internal only
    provider: system
```

Messaging providers (Slack, Telegram, WhatsApp): see
`references/messaging-signals.md`.

### `jobs` — FSM pipelines

Keyed by **MCP tool name** (`[a-zA-Z0-9_-]+`). Every job has an `fsm:` block
with `id`, `initial`, and `states`. Each state is either:

- An action state: `{ entry: [...actions], on: { EVENT: { target: 'next' } } }`
- A terminal state: `{ type: 'final' }`

**Entry action types:**
- `{ type: agent, agentId, outputTo, outputType, prompt }` — invoke a declared agent
- `{ type: emit, event: 'EVENT_NAME' }` — fire an event routed by this state's `on` map

Minimal FSM job (one agent, triggered by a signal):

```yaml
jobs:
  summarize:
    title: "Daily Summary"
    triggers: [ { signal: daily-summary } ]
    fsm:
      id: summarize-pipeline
      initial: idle
      states:
        idle:
          'on':
            daily-summary: { target: step_summarize }
        step_summarize:
          entry:
            - type: agent
              agentId: summarizer                # matches agents.summarizer
              outputTo: summary-output
              outputType: summary-result
              prompt: "Summarize today's notes."
            - type: emit
              event: ADVANCE
          'on':
            ADVANCE: { target: done }
        done: { type: final }
    outputs: { memory: "notes", entryKind: "summary" }
    config: { timeout: "10m", max_steps: 10 }
```

Multi-step pipelines chain states — each agent state emits `ADVANCE`, the next
state's `on.ADVANCE.target` advances it. Keep states small; route with events,
not nested conditionals.

Other optional job fields: `prompt` (supervisor guidance), `inputs` (JSON
schema exposed as MCP tool params), `context.files` (glob patterns +
`base_path` + `max_file_size`), `success.{condition,schema}`, `error.condition`,
`config.supervision.{level,skip_planning}`, loose `config.<key>` keys (read via
`context.config.<key>`), `scope_exclusions`, `improvement: "surface"|"auto"`.

### `agents` — per-workspace agent definitions

Keyed by stable kebab-case id. Discriminated on `type` — three options:

```yaml
agents:
  summarizer:                   # type: llm — inline LLM agent (most common)
    type: llm
    description: "Summarizes incoming docs"
    config:
      provider: "anthropic"                       # required
      model: "claude-sonnet-4-6"                  # required
      prompt: "You summarize..."                  # required
      temperature: 0.3                            # default 0.3
      max_tokens: 2000
      max_steps: 10
      tool_choice: "auto"                         # "auto" | "required" | "none"
      tools: ["fetch_mcp_tool_name"]              # resolves via tools.mcp.servers.*

  my-code-agent:                # type: user — SDK agent (Python/TS, registered via POST /api/agents/register)
    type: user
    agent: "my-code-agent"                        # matches registered agent id
    prompt: "Additional workspace context"        # optional
    env:                                          # strings OR credential refs
      GITHUB_TOKEN: { credentialId: "cred_abc123" }
      STATIC_VAR: "literal-value"
    # To register the agent before referencing it here, see the `writing-friday-agents` skill.

  kb-agent:                     # type: atlas — agent from the Atlas registry
    type: atlas
    agent: "kb-agent"                             # Atlas Agent ID from registry
    description: "Knowledge base agent"
    prompt: "You are a knowledge base assistant..."
    config:                                       # agent-specific config (optional)
      some_setting: "value"
    env:
      API_KEY: { credentialId: "cred_abc123" }
```

### `memory` — corpora and cross-workspace mounts

```yaml
memory:
  own:                          # corpora this workspace creates
    - { name: "notes",   type: "short_term", strategy: "narrative" }
    - { name: "memory",  type: "long_term",  strategy: "narrative" }

  mounts:                       # read/write other workspaces' memory
    - name: "backlog"
      source: "thick_endive/narrative/autopilot-backlog"  # {wsId|_global}/{kind}/{name}
      mode: "ro"                                  # "ro" | "rw"
      scope: "workspace"                          # "workspace" | "job" | "agent"
      scopeTarget: "summarize"                    # required when scope != workspace
      filter:                                     # optional
        status: ["open", "triaged"]
        since: "2026-04-01T00:00:00Z"

  shareable:
    list: ["notes"]
    allowedWorkspaces: ["fuzzy_plum"]
```

**Baseline:** include the three `own` corpora above unless the user says
otherwise. Persistent state across sessions lives here.

**Reads auto-inject into chat system prompts.** The chat runtime fetches every
declared narrative corpus on every turn and flattens entries into
`<memory>` blocks. Agents see recent entries without calling anything —
reach for `memory_read` only for older entries, a specific `since`
cutoff, or more than 20 entries.

**Writes** go through
`memory_save({ workspaceId, memoryName, text, metadata? })`.
The tool validates `memoryName` against `memory.own` / `memory.mounts`; `ro`
mounts reject writes; `rw` mounts rewrite transparently to the source workspace.
Companion tools: `memory_read`, `memory_remove`.
**FSM `type: llm` agents can call these three tools** — they're in the FSM
LLM allowlist.

**Memory vs session state.** Narrative memory persists across sessions — use
for anything the user should see next time. `state_{append,filter,lookup}` are
session-scoped (per-workspace `state.db`) — use for working data inside a job
pipeline.

### `resources` — declared data references

Tagged union on `type`. Every variant needs `slug`, `name`, `description`.

- `document` — `schema: {...}` (JSON Schema for document structure)
- `prose` — free-form; no extra fields
- `artifact_ref` — `artifactId: "..."`
- `external_ref` — `provider: "notion|drive|..."`, optional `ref` (URL), `metadata: {...}`

### `skills` — global and inline skill entries

```yaml
skills:
  - { name: "@tempest/debugging-friday", version: 3 }   # global ref; omit version for latest
  - name: "ad-hoc-skill"                                # inline (workspace-local)
    inline: true
    description: "Short prose (no < or > chars)"
    instructions: |
      Skill body in markdown.
```

Reserved words (`anthropic`, `claude`) are rejected.

### `server` — expose this workspace as an MCP server

```yaml
server:
  mcp:
    enabled: false
    discoverable:
      capabilities: ["workspace_*"]
      jobs: ["review-*"]
```

Extended fields (`transport`, `auth`, `rate_limits`) require `friday.yml`
— see `references/platform-friday-yml.md`.

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

Tool names exposed by these servers are what you list in `agents.*.config.tools`.

**Common MCP servers:**

| Need | Transport | Command | Args |
|---|---|---|---|
| SQLite | stdio | `uvx` | `mcp-server-sqlite`, `--db-path`, `${ATLAS_HOME}/workspaces/<ws-name>/<db>.sqlite` |
| Filesystem | stdio | `npx` | `-y`, `@modelcontextprotocol/server-filesystem`, `<root>` |
| GitHub | stdio | `npx` | `-y`, `@modelcontextprotocol/server-github` |
| Postgres | stdio | `npx` | `-y`, `@modelcontextprotocol/server-postgres`, `<conn-str>` |
| Fetch | stdio | `uvx` | `mcp-server-fetch` |
| Time | stdio | `uvx` | `mcp-server-time` |

**Path placeholders in MCP args.** The daemon expands `${HOME}` and
`${ATLAS_HOME}` in every `args` entry at MCP spawn time. **Always prefer
these over hardcoded `/Users/<name>/...` paths** — guessing the username
is the single most common silent-failure mode (the sqlite process can't
open the file, the MCP server dies, the agent's SQL tools vanish, and
"saving" produces apologetic text while nothing persists). There is no
`${WORKSPACE_PATH}` placeholder today; build the path from `${ATLAS_HOME}`
plus the workspace name.

For other servers, search the MCP registry. Validator flags `npm_package_not_found`
/ `pypi_package_not_found` if a package doesn't exist — fix and retry.

---

## Updating an existing workspace

**Default: `POST /api/workspaces/:id/update`** — validates the full config, writes
`workspace.yml`, and destroys the runtime so it rebuilds on the next signal. The
disk file does not auto-reload a live workspace; this endpoint is the correct path.

```javascript
// run_code, language: javascript
const id = "layered_ham";   // runtime id, not the workspace name
const cfg = await fetch(`http://localhost:8080/api/workspaces/${id}/config`).then(r => r.json());

// mutate cfg.config ...

const res = await fetch(`http://localhost:8080/api/workspaces/${id}/update`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ config: cfg.config }),
});
console.log(JSON.stringify(await res.json()));
// → { success: true, workspace: {...}, runtimeReloaded: true }
```

Pass `backup: true` to preserve a timestamped `workspace.yml.backup-<ts>` before
overwriting. Pass `force: true` to override the active-session guard (use with care).

**Surgical endpoints** — prefer these over a full update when only one thing changes:

| Change | Endpoint |
|---|---|
| Add/update/delete a signal | `POST`/`PUT`/`PATCH`/`DELETE /api/workspaces/:id/config/signals[/:id]` |
| Update an agent's prompt / model / tools | `PUT /api/workspaces/:id/config/agents/:id` |
| Swap a credential reference | `PUT /api/workspaces/:id/config/credentials/:path` |
| Rename / recolor metadata | `PATCH /api/workspaces/:id/metadata` |

**Never DELETE+CREATE** — loses the runtime id, kills active sessions, breaks anything
holding the old id (cron targets, cross-workspace mounts, hardcoded refs).

---

## Error codes

`workspace_create` → 400 / 409 / 422 / 500. Partial-update → 404 / 405 / 409
/ 422. `DELETE /api/workspaces/:id` → 403 for system workspaces. Response
body has details; 422 includes `report.issues[]`.

---

## Go deeper

All references are cited inline at the point of use. Dir map:
- `assets/example-kb-workspace.yml` — narrative-memory-only, for trivial
  save-and-recall.
- `assets/example-jobs-pipeline.yml` — signals + jobs + FSM + MCP, for
  structured or signal-triggered work.
- `references/` — messaging signals, workspace editing, `friday.yml`
  platform superset.
