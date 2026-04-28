---
name: workspace-api
description: "Create, list, update, delete, and clean up workspaces via the daemon HTTP API (localhost:8080). Use when the user asks to create, edit, delete, or list workspaces, spaces, projects, or environments; add or patch signals / agents / jobs / memory / skills; convert a workspace.yml into a live workspace; wire up triggers (HTTP webhooks, cron, fs-watch, Slack / Telegram / WhatsApp); or clean up test/scratch workspaces."
user-invocable: false
---

# Workspace API

Create and manage Friday workspaces. This skill is where LLM judgment lives: when to use each tool, in what order, and how to recover when stuck. Companion skills: `friday-cli` (daemon lifecycle, signals, sessions) and `using-mcp-servers` (MCP catalog, install/enable, credentials).

## Cheat sheet

**Reachability model.** Signals trigger jobs. Jobs run agents. Agents call MCP tools and read/write memory. Nothing else triggers anything else. An agent declared without a wrapping job is unreachable. Memory is accessed by agents, not signals or jobs directly.

**7-step recipe.**
1. Identify required MCP servers from the user's intent.
2. For each not yet enabled: `enable_mcp_server` (see `using-mcp-servers` skill).
3. For each provider needing credentials: `connect_service`.
4. Decide direct vs draft: single atomic change → direct; multi-entity build → draft.
5. If draft: `begin_draft` (pass `workspaceId` if targeting a newly created workspace). Then `upsert_agent` → `upsert_job` → `upsert_signal` in dependency order (agents before jobs, jobs before signals). **All draft/upsert tools accept an optional `workspaceId` parameter.** Use it after `create_workspace` so operations land on the new workspace, not the current session workspace.
6. `validate_workspace` — fix errors, address warnings or accept them.
7. If draft: `publish_draft` after user confirms. If direct: done.

**Direct vs draft.**
- Direct: upserts write live `workspace.yml`, full validation runs immediately, runtime reloads. Best for one change.
- Draft: upserts stage to `workspace.yml.draft`, permissive per-entity validation, cross-entity checks at `validate_workspace` + `publish_draft`. Best for new workspaces or pipelines.

**Tool selection.**
- Workspace building: `create_workspace`, `begin_draft`, `upsert_agent`, `upsert_signal`, `upsert_job`, `remove_item`, `validate_workspace`, `publish_draft`, `discard_draft`.
- Daemon CRUD (list, get, delete): `run_code` bash + curl to `localhost:8080`.
- MCP install/enable/credentials: `using-mcp-servers` skill.
- Codebase edits: `agent_claude-code`.

**Key one-liners.**
- Jobs must use `fsm:`, not `execution:` — the runtime silently skips jobs without `fsm:`.
- `write_file` writes to scratch only; use `run_code` with an absolute path to edit `workspace.yml`.
- Tool names in `agents.*.config.tools` resolve against `tools.mcp.servers.*`; there are no platform-default filesystem tools outside MCP.

---

## Reachability model — the runtime call chain

Friday workspaces have a fixed call chain:

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

**Chat interacts with your workspace through jobs. Nothing else.** Agents and MCP servers are internals of the jobs that wrap them. This is the single most important mental model to get right:

- **An agent declared without a job that invokes it is unreachable.** Chat cannot call agents directly, only jobs. A lone `agents.kb-agent` with MCP tools attached will sit idle. The validator catches this as `orphan_agent`.
- **Memory is accessed by agents, not signals or jobs directly.** Agents see narrative memory auto-injected into their prompts. Agents call `memory_save`, `memory_read`, `memory_remove` explicitly for older entries or specific filters.
- **Tools belong to agents** (via the agent's `tools:` array), and the tools have to be enabled at workspace scope (in `tools.mcp.servers`) for the agent to use them.

**What this means for authoring:** work backward from the trigger. What signal fires this? What job does that signal start? What agents does that job invoke? What tools do those agents need? Declare agents first, then jobs that reference them, then signals that trigger those jobs.

---

## Recipe: build or modify a workspace

Follow this order exactly. Skipping steps produces the failure modes documented in real chat transcripts.

### 1. Identify required MCP servers

From the user's intent, list every external tool the workspace needs (SQLite, GitHub, filesystem, fetch, etc.). For each, check if it's already in the workspace's `tools.mcp.servers`. If not, plan to enable it.

### 2. Enable MCP servers

For each missing server, call `enable_mcp_server`. If the server isn't in the platform catalog yet, call `search_mcp_servers` → `install_mcp_server` first. See the `using-mcp-servers` skill for the full decision tree (install vs enable vs create custom).

### 2b. Discover tool names

Before adding an agent that uses MCP tools, call `list_mcp_tools({ serverId })` to get the exact tool names the server exposes. Use these names verbatim in the agent's `tools` array. Do not guess tool names.

Example: `list_mcp_tools({ serverId: "google-gmail" })` returns `[{ name: "gmail_list_messages", description: "..." }, ...]` — use `"gmail_list_messages"` in the agent config.

### 3. Connect credentials

If an enabled server requires credentials (GitHub token, API key, OAuth), call `connect_service(provider)` before any agent references the server's tools. The user will be prompted to authenticate; on `data-credential-linked`, continue.

### 4. Decide direct vs draft mode

**Direct mode** — use when the change is a single atomic operation:
- Add one signal to an existing workspace.
- Update one agent's prompt or model.
- Remove one entity with `remove_item`.

**Draft mode** — use when the change is a multi-entity coherent build:
- Creating a new workspace from scratch.
- Adding a pipeline (agent + job + signal together).
- Restructuring an FSM or replacing multiple agents.

Draft mode is opt-in: call `begin_draft` to start it. If a draft already exists, ALL mutations write to the draft automatically; direct mode is blocked until you publish or discard.

### 5. Upsert in dependency order

Inside draft (or direct), create entities in this order:

1. **Agents first** — because jobs reference `agentId` in their FSM `entry` actions.
2. **Jobs second** — because they wire agents into the orchestration layer.
3. **Signals last** — because they are external entry points; nothing else depends on them. Jobs reference signals by name in `triggers`, but the runtime resolves those at execution time, so signal existence is not a hard dependency for job creation.

Call `upsert_agent({ id, config, workspaceId? })`, `upsert_job({ id, config, workspaceId? })`, `upsert_signal({ id, config, workspaceId? })`. Each returns `{ ok, diff, structural_issues }`. Read `diff` to confirm intent. If `structural_issues` is non-null, fix them before proceeding — structural issues block the write. Pass `workspaceId` when building a workspace you just created from a chat session in a different workspace.

Common structural issue codes: `unknown_agent_id` (job references an agent you haven't upserted yet — fix by ordering correctly), `fsm_structural_error` (states malformed), `npm_package_not_found` / `pypi_package_not_found` (MCP server transport args point to a bad package).

### 6. Validate

Call `validate_workspace`. It returns a report:

```
{
  status: "ok" | "warning" | "error",
  errors: [{ code, path, message }],     // blocks publish
  warnings: [{ code, path, message }]   // does not block
}
```

**Fix every error before publishing.** Errors mean the workspace will not load or will fail at runtime. Warnings are advisory (`orphan_agent`, `dead_signal`, `missing_tools_array`, `cron_parse_failed`) — address them or accept them explicitly.

### 7. Publish (draft only)

If you used draft mode, propose the changes to the user: "I've drafted X, Y, Z — want me to publish?" On confirmation, call `publish_draft`. It runs the full validator atomically; if any error exists, the draft is left untouched and you get the report to fix. If it succeeds, the draft renames over `workspace.yml` and the runtime reloads.

To abandon a draft: `discard_draft`.

---

## Direct mode vs draft mode — full behavior

| Aspect | Direct mode | Draft mode |
|---|---|---|
| Default state | Yes | Opt-in via `begin_draft` |
| Where mutations write | `workspace.yml` | `workspace.yml.draft` |
| Per-mutation validation | Full strict (entire post-mutation config) | Permissive structural (just that entity) |
| Cross-entity validation | At every mutation | At `validate_workspace` and `publish_draft` |
| Behavior on partial state | Refuses if invalid; order matters | Allowed; intermediate state legitimately incomplete |
| Best for | Single atomic ops | Multi-entity coherent builds |
| MCP enable/disable | Writes live | Writes draft (existing tools are draft-aware) |

**Mutually exclusive.** If `workspace.yml.draft` exists, ALL mutations write to the draft. Direct mode is blocked. Publish or discard to return to direct mode.

**Draft is a fork, not a branch.** `begin_draft` snapshots the live config at creation time. If live changes after the draft begins, publish blindly overwrites them. There is no merge logic.

---

## Tool selection — when to use what

**For workspace shape changes (agents, jobs, signals, validation):** always use the dedicated tools (`create_workspace`, `upsert_*`, `validate_workspace`, `publish_draft`, etc.). They are typed, return structured diffs and issues, and handle draft/live switching automatically. Never shell out to curl for these.

**For daemon CRUD (list workspaces, get config, delete workspace):** use `run_code` bash + curl to `localhost:8080`. These are one-liners; the output is immediate and errors are obvious. Do not spawn `agent_claude-code` for a `DELETE` or a `GET`.

**For MCP server questions (install vs enable, credentials, catalog search):** load the `using-mcp-servers` skill. `workspace-api` does not cover MCP scope.

**For codebase exploration or multi-file edits:** `agent_claude-code` is the right tool.

The failure mode this prevents: reaching for `agent_claude-code` as a panic button when uncertain, turning a 5-second curl into an 8-minute agent call.

---

## CRUD reference — curl examples

All examples assume the daemon is on `localhost:8080`. Confirm first:

```bash
curl -sf http://localhost:8080/health && echo OK
```

### List workspaces

```bash
curl -s http://localhost:8080/api/workspaces | jq
```

Resolve a display name to a runtime id:

```bash
curl -s http://localhost:8080/api/workspaces | \
  jq -r '.[] | select(.name == "my-workspace") | .id'
```

### Get workspace + config

```bash
# Summary (id, name, status, path)
curl -s http://localhost:8080/api/workspaces/$WS | jq

# Full parsed config
curl -s http://localhost:8080/api/workspaces/$WS/config | jq
```

### Update workspace (full replacement)

```bash
curl -s -X POST http://localhost:8080/api/workspaces/$WS/update \
  -H 'Content-Type: application/json' \
  -d '{"config": {"version":"1.0","workspace":{"name":"new-name"}}, "backup": true}'
```

Pass `backup: true` to preserve a timestamped `workspace.yml.backup-<ts>`. Pass `force: true` to override the active-session guard.

**Prefer partial updates for single-entity changes** — they preserve runtime state and reload only the runtime:

```bash
# Add or replace a signal
curl -s -X POST http://localhost:8080/api/workspaces/$WS/config/signals \
  -H 'Content-Type: application/json' \
  -d '{"signalId": "run-now", "signal": {"provider":"http","config":{"path":"/run-now"}}}'

# Update agent prompt + model + tools
curl -s -X PUT http://localhost:8080/api/workspaces/$WS/config/agents/summarizer \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"You summarize rigorously.","model":"claude-sonnet-4-6","tools":["fetch"]}'

# Patch signal schedule
curl -s -X PATCH http://localhost:8080/api/workspaces/$WS/config/signals/daily-summary \
  -H 'Content-Type: application/json' \
  -d '{"config":{"schedule":"*/15 * * * *","timezone":"UTC"}}'
```

### Delete a workspace (single)

```bash
curl -sf -X DELETE http://localhost:8080/api/workspaces/$WS
```

**Rejects 403** for system workspaces (`system`, `user`, `thick_endive`). Resolve name → id first; never guess runtime IDs.

### Delete workspaces (batch — by name prefix)

```bash
curl -s http://localhost:8080/api/workspaces | \
  jq -r '.[] | select(.name | startswith("test-")) | .id' | \
  while read -r id; do
    result=$(curl -sf -X DELETE "http://localhost:8080/api/workspaces/$id")
    echo "$id: $result"
  done
```

**Dry-run first** — list names before deleting:

```bash
curl -s http://localhost:8080/api/workspaces | \
  jq -r '.[] | select(.name | startswith("test-")) | "\(.id)  \(.name)"'
```

### Delete workspaces (batch — explicit id list)

```bash
for id in layered_ham smoky_almond ripe_eggplant; do
  result=$(curl -sf -X DELETE "http://localhost:8080/api/workspaces/$id")
  echo "$id: $result"
done
```

---

## Stuck-recovery heuristic

If validation fails 3+ times on the same operation and the error path is unclear, stop iterating on the current shape. Use binary search:

1. Build the **minimum viable config** (just `version: "1.0"` + `workspace.name`) and confirm it validates cleanly.
2. Add **one section at a time** in this order: signals → agents → jobs.
3. Call `validate_workspace` after each addition.
4. The **first section that breaks** is the one to debug. Fix it before adding the next.

This removes the panic-driven shotgun debugging that produces orphaned agents, malformed FSMs, and circular retries.

---

## Workshop-then-crystallize

A common pattern: the user and chat prove out a flow interactively using real MCP tools, then the user says "save this as a recurring job."

**How to crystallize:**

1. The chat distills its own conversation into one agent prompt + a `tools:` array. No new tool is needed for this — the model is good at summarizing its own behavior into a config shape.
2. Propose an **agent + job + signal triple**:
   - Agent: the distilled prompt and tool set.
   - Job: an FSM with one state that invokes the agent.
   - Signal: the trigger (cron, HTTP webhook, or fs-watch) that starts the job.
3. Use **draft mode by default** for crystallization. The user reviews the triple as a unit before publish.
4. **Address the structural shift.** Interactive flows often need approval steps when made autonomous. Example: if the workshopped flow books meetings, the crystallized version should add a separate `book-meeting` HTTP signal for human-approved actions, or an FSM state that pauses for confirmation.
5. **Suggest organically.** After a successful interactive demonstration: "This worked well. Want me to save it as a daily-automation job? I can draft the agent, job, and signal for you to review before publishing."

---

## LLM vs Python agent decision matrix

Workspaces support two agent types: `type: llm` (inline LLM, most common) and `type: user` (Python/TS SDK agent, registered via NATS).

| Use `type: llm` when | Use `type: user` (Python) when |
|---|---|
| The logic is "figure out what to do" — classification, summarization, routing decisions, creative generation. | The work is mechanical — parsing, transforming, multipart uploads, deterministic routing, heavy data crunching. |
| The task benefits from reasoning inside the prompt and tool-calling loop. | The LLM-loop tax (token latency, cost) dominates the value of the task. |
| One focused `generate_text` or `generate_object` call with a strong prompt suffices. | The task requires libraries unavailable to the LLM (Pandas, PIL, custom compiled code). |
| Speed of iteration matters more than runtime cost. | The task runs unattended at high frequency and cost must be minimized. |

**Examples:**
- A triage agent that reads an email and decides "urgent / tracking / ignore" → `llm`.
- A parser that extracts structured fields from 10,000 PDFs and writes to SQLite → `user` (Python).
- A map-builder that calls an LLM for design but Python for tile rendering → hybrid: `llm` agent delegates to a `user` agent for the render step.

Python agent creation is an out-of-flow step the user kicks off explicitly. See the `writing-friday-agents` skill for authoring, deploying, and registering SDK agents.

---

## Top gotchas — read before writing any config

1. **Pass `workspaceId` after `create_workspace`.** The draft and upsert tools default to the current session workspace. When you create a new workspace from a chat session in a different workspace, every subsequent `begin_draft`, `upsert_*`, `validate_workspace`, `publish_draft`, `discard_draft`, `enable_mcp_server`, and `disable_mcp_server` call must include `workspaceId: '<new-id>'` or the changes land on the wrong workspace.

2. **Jobs must use `fsm:`, not `execution:`**. The schema accepts both; the runtime silently skips any job lacking `fsm:` and signal dispatch fails at runtime with `"No FSM job handles signal '<name>'"`.

3. **FSM shape is XState-style.** States are `{ entry: [...actions], on: { EVENT: { target: 'next' } } }` or `{ type: 'final' }`. Do **not** use `type: action, action: {...}, next: ...` — the validator rejects it with `fsm_structural_error`.

   For detailed job authoring guidance, load `@friday/writing-workspace-jobs` before creating or editing any `fsm:` job.

4. **`write_file` writes to scratch only** (`{ATLAS_HOME}/scratch/{sessionId}/`). To edit a workspace on disk, use `run_code` with an absolute path.

5. **Always call `list_mcp_tools` before referencing MCP tools in an agent.** Tool names are not predictable — they come from the server implementation, not the server ID. Guessing produces `unknown_tool` validation errors. Call `list_mcp_tools({ serverId })`, then use the returned names verbatim in the agent's `tools` array. The returned names are already prefixed as `serverId/toolName`.

6. **Never report "saved to memory" without verifying.** Setup can look successful end-to-end and still silently fail. Before reporting success:
   1. Fire the signal once with a canary payload.
   2. Poll `GET /api/sessions/:id` until terminal (`completed` / `failed`).
   3. Read back with `GET /api/memory/:workspaceId/narrative/:memoryName`.
   4. Surface any mismatch explicitly — don't paper over it.

7. **Always resolve workspace IDs from the API.** Runtime IDs like `layered_ham` are random per daemon. Never hardcode them.

8. **Never DELETE+CREATE a workspace to edit it.** That loses the runtime id, kills sessions, and breaks cross-workspace mounts. Use in-place updates (`POST /update` or partial endpoints) instead.

---

## Go deeper

- `assets/example-kb-workspace.yml` — narrative-memory-only workspace. No jobs, no agents, no MCP. Use for trivial save-and-recall (notes, URLs, quotes, reading list).
- `assets/example-jobs-pipeline.yml` — signals + jobs + FSM + MCP. Use for structured storage, signal-triggered work, or multi-step pipelines.
- `references/updating-workspaces.md` — partial-update API details, disk-edit path, when to use each.
- `references/messaging-signals.md` — Slack, Telegram, WhatsApp signal configuration.
- `references/platform-friday-yml.md` — platform-level overrides (transport, auth, rate limits).
- `writing-workspace-jobs` skill — FSM job authoring: trigger wiring, MCP tool naming, state-machine shapes, validation error decoder, runtime anti-patterns. Load before creating or editing any `fsm:` job.
- `using-mcp-servers` skill — MCP catalog, install/enable/disable, credentials, delegation.
- `writing-friday-agents` skill — authoring and registering Python/TS SDK agents.
- `friday-cli` skill — daemon lifecycle, signal triggering, session streaming, log forensics.
