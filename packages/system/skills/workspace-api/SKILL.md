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
   platform ships narrative-memory tools (`memory_narrative_{append,read,forget}`)
   and state tools (`state_{append,filter,lookup}`) for both chat and FSM LLM
   agents without any MCP server config.

5. **Never report "saved to memory" without verifying.** Setup can look
   successful end-to-end and still silently fail. Before reporting success:
   1. Fire the signal once with a canary payload.
   2. Poll `GET /api/sessions/:id` until terminal (`completed` / `failed`).
   3. Read back with `GET /api/memory/:workspaceId/narrative/:memoryName`.
   4. Surface any mismatch explicitly — don't paper over it.

---

## Quick start — create a workspace

**Always call the `workspace_create` tool. Never shell out to curl.** One
typed call, structured errors on 422, fix-and-retry in the same conversation.

### Start from a template — the default path

**Read `assets/example-kb-workspace.yml` and adapt it.** It's a
narrative-memory-backed workspace with a single conversational agent that
saves via `memory_narrative_append` and reads from the auto-injected
prompt — no SQLite, no jobs, no FSM. Most "let me store and search X"
requests (knowledge base, URL saver, notes app, reading list, journaling)
fit this shape exactly. Change the workspace name and the agent prompt's
domain guidance; leave the scaffolding alone.

Submit it via `workspace_create`. This is the fastest path and avoids
both FSM and MCP setup.

**Do NOT reach for SQLite (or any user-authored storage) for plain
save-and-recall use cases.** Every workspace already gets a `notes`
narrative corpus that the runtime auto-injects into the agent's prompt
on every turn — it's strictly better than user-SQL for unstructured
notes/URLs/quotes/articles (zero setup, zero MCP dependency, zero DB
path to hallucinate, zero bootstrap schema). Reserve SQLite for
genuinely relational data the user explicitly asked for (structured
logs, joined tables, reporting dashboards).

### Build a custom one from scratch — only if the template doesn't fit

Skip to this path only when the workspace needs signals, jobs, or FSM
pipelines (e.g. "when an email arrives, run a multi-step classification
workflow"). For pure data capture, the template above is faster and more
reliable.

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
- `{ type: code, function: 'fnName' }` — call a named function from the FSM's code module
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

Keyed by stable kebab-case id. Discriminated on `type`:

```yaml
agents:
  summarizer:                   # type: llm — most common
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

  kb-chat:                      # type: system — built-in platform agent
    type: system
    agent: "conversation-agent"                   # platform agent id
    config:                                       # optional overrides
      model: "claude-sonnet-4-6"
      prompt: "Override system prompt"
      tools: [...]

  my-code-agent:                # type: user — Python WASM via `atlas agent build`
    type: user
    agent: "my-code-agent"                        # matches build output id
    prompt: "Additional workspace context"        # optional
    env:                                          # strings OR credential refs
      GITHUB_TOKEN: { credentialId: "cred_abc123" }
      STATIC_VAR: "literal-value"
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
reach for `memory_narrative_read` only for older entries, a specific `since`
cutoff, or more than 20 entries.

**Writes** go through
`memory_narrative_append({ workspaceId, memoryName, entry: { text, metadata? } })`.
The tool validates `memoryName` against `memory.own` / `memory.mounts`; `ro`
mounts reject writes; `rw` mounts rewrite transparently to the source workspace.
Companion tools: `memory_narrative_read`, `memory_narrative_forget`.
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

**Default:** edit `workspace.yml` on disk via `run_code` with an absolute
path. The file watcher hashes new content, validates against the schema,
destroys the runtime, and recreates it on the next signal — runtime id,
sessions, memory, and scratchpad are all preserved. If a session is active,
the reload defers until idle.

```javascript
// run_code, language: javascript — Deno has @std/yaml built in
import { stringify } from "jsr:@std/yaml";
import { writeFileSync } from "node:fs";

const cfg = await fetch("http://localhost:8080/api/workspaces/<id>/config").then(r => r.json());
// mutate cfg...
writeFileSync("/Users/you/.atlas/workspaces/my-space/workspace.yml", stringify(cfg));
```

**Escape hatches** — use only when exactly one of these fits and the on-disk
path doesn't:

| Change | Endpoint |
|---|---|
| Add/update/delete a signal | `POST`/`PUT`/`PATCH`/`DELETE /api/workspaces/:id/config/signals[/:id]` |
| Update an agent's prompt / model / tools | `PUT /api/workspaces/:id/config/agents/:id` |
| Swap a credential reference | `PUT /api/workspaces/:id/config/credentials/:path` |
| Rename / recolor metadata | `PATCH /api/workspaces/:id/metadata` |

**There is no full-replace endpoint** — `POST /api/workspaces/:id/config` 404s.

**Never DELETE+CREATE** unless all of the above fail. Delete-then-create loses
the runtime id, kills active sessions, and breaks anything holding the old id
(cron targets, cross-workspace mounts, hardcoded refs).

Full three-path guide with worked examples:
`references/updating-workspaces.md`.

---

## Error codes

`workspace_create` → 400 / 409 / 422 / 500. Partial-update → 404 / 405 / 409
/ 422. `DELETE /api/workspaces/:id` → 403 for system workspaces. Response
body has details; 422 includes `report.issues[]`.

---

## Go deeper

All references are cited inline at the point of use. Dir map: `assets/` for
copy-paste templates (`example-kb-workspace.yml`); `references/` for
deep-dives on messaging signals, workspace editing, and the `friday.yml`
platform superset.
