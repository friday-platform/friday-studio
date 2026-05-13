---
name: workspace-api
description: "Create, list, update, delete, and clean up workspaces via the daemon HTTP API on localhost:8080 (or https://localhost:8080 when TLS is enabled via scripts/setup-tls.sh). Use when the user asks to create, edit, delete, or list workspaces, spaces, projects, or environments; add or patch signals / agents / jobs / memory / skills; convert a workspace.yml into a live workspace; wire up triggers (HTTP webhooks, cron, fs-watch, Slack / Telegram / WhatsApp); or clean up test/scratch workspaces."
---

# Workspace API

Create and manage Friday workspaces. This skill is where LLM judgment lives: when to use each tool, in what order, and how to recover when stuck. Companion skills: `friday-cli` (daemon lifecycle, signals, sessions) and `using-mcp-servers` (MCP catalog, install/enable, credentials).

## Cheat sheet

**Reachability model.** Signals trigger jobs. Jobs run agents. Agents call MCP tools and read/write memory. Nothing else triggers anything else. An agent declared without a wrapping job is unreachable. Memory is accessed by agents, not signals or jobs directly.

**Agent types — pick deliberately.**

| Type | When | Example |
|---|---|---|
| `atlas` | A bundled platform agent fits the task **and its `constraints` allow it** | `type: atlas, agent: "web"` |
| `llm` | Default for open-ended work — classifying, summarizing, scoring, choosing among options. Use when in doubt. | `type: llm, config: { prompt, tools }` |
| `user` | ONLY when each call's decision is mechanical (regex, schema, fixed routing). If the agent body would call `ctx.llm.generate` to decide anything, this is wrong — use `llm`. User agents must use host capabilities (`ctx.tools`, `ctx.http`, `ctx.llm`) rather than direct local MCP/API calls. | `type: user, agent: "csv-parser"` |

**Decision rule.** Inspect what's available with the per-domain tools: `list_bundled_agents` for atlas-agent candidates (then `describe_bundled_agent({id})` to read `constraints`); `list_mcp_servers(scope=workspace)` for currently-wired MCP servers, or `scope=catalog` to see what could be enabled. Reach for `list_capabilities` only when the question genuinely spans both surfaces ("what could I use here?"). If a bundled agent's `constraints` cover the user's intent end-to-end, pick `atlas`. Otherwise default to `llm` with the right MCP tools wired. Reach for `user` only when you can name the deterministic decision the agent body makes — never as a fallback. If the user names a type explicitly (`use an llm agent`), respect it.

**Bundled vs MCP-as-tool.** Bundled when the work is open-ended within a domain (you want a sub-agent that reasons). MCP server when the work is deterministic / single-call (you want a tool). A `web` bundled agent that browses, scrapes, and summarises beats `playwright-mcp` wired into a `type: llm` agent every time the work is open-ended; a single `slack_post_message` call is cleanest as an MCP tool.

**7-step recipe.**
1. Inventory: `list_bundled_agents` for atlas options, `list_mcp_servers(scope=all)` for wired + catalog MCP, `list_skills` for skills already attached to the workspace. Use `list_capabilities` only for the cross-domain "what can I do here?" rung when you don't yet know which surface you need.
2. Wire by surface: bundled → straight into `upsert_agent` with `type: atlas`; MCP enabled → already wired; MCP available in catalog → `enable_mcp_server` first.
3. For each provider needing credentials: `connect_service`.
4. Decide direct vs draft: single atomic change → direct; multi-entity build → draft.
5. If draft: `begin_draft` (pass `workspaceId` if targeting a newly created workspace). Then `upsert_agent` → `upsert_job` → `upsert_signal` in dependency order (agents before jobs, jobs before signals). **All draft/upsert tools accept an optional `workspaceId` parameter.** Use it after `create_workspace` so operations land on the new workspace, not the current session workspace.
6. `validate_workspace` — fix errors, address warnings or accept them.
7. If draft: `publish_draft` after user confirms. If direct: done.

**Direct vs draft.**
- Direct: upserts write live `workspace.yml`, full validation runs immediately, runtime reloads. Best for one change.
- Draft: upserts stage to `workspace.yml.draft`, permissive per-entity validation, cross-entity checks at `validate_workspace` + `publish_draft`. Best for new workspaces or pipelines.

**Tool selection.**
- Discovery: `list_bundled_agents` / `describe_bundled_agent` for atlas-agent inspection; `list_mcp_servers` / `describe_mcp_server` for MCP servers; `list_skills` / `describe_skill` for skills; `list_capabilities` only as a cross-domain router.
- Workspace building: `create_workspace`, `begin_draft`, `upsert_agent`, `upsert_signal`, `upsert_job`, `upsert_memory_own`, `upsert_memory_mount`, `delete_agent` / `delete_signal` / `delete_job`, `validate_workspace`, `publish_draft`, `discard_draft`.
- Skill management (persistent assignment, not ephemeral load): `assign_workspace_skill` attaches a global-catalog skill to a workspace so every agent and job sees it in `<available_skills>`. `unassign_workspace_skill` removes it. For one-time use in the current chat only, use `load_skill` instead.
- Daemon CRUD (list, get, delete): `run_code` bash + curl to the daemon HTTP API.
- MCP install/enable/credentials: `using-mcp-servers` skill.
- Codebase edits: `agent_claude-code`.

**Key one-liners.**
- Jobs must use `fsm:`, not `execution:` — the runtime silently skips jobs without `fsm:`.
- `write_file` writes to scratch only; use `run_code` with an absolute path to edit `workspace.yml`.
- Tool names in `agents.*.config.tools` resolve against `tools.mcp.servers.*` for workspace-scoped MCP servers. Atlas-platform built-ins (memory, artifacts, fs, `request_tool_access`, `request_human_input`) auto-inject everywhere and use bare names (`save_memory_entry`, `fs_glob`, `request_human_input`); no `serverId/` prefix.
- Jobs that return data need `outputTo`; LLM-backed `outputTo` actions must finish with the injected `complete` tool (`outputType` schema args, or `{ response }` for untyped output).

---

## Reachability model — the runtime call chain

Friday workspaces have a fixed call chain:

```
user message → workspace-chat (platform meta-agent)
                      │
                      ├─ calls save_memory_entry / list_memory_entries (built-in)
                      │
                      └─ calls <job-name> tool → fires signal → FSM runs
                                                     │
                                                     └─ invokes agents, uses MCP tools
                                                        (all internal to this job)
```

**Chat interacts with your workspace through jobs. Nothing else.** Agents and MCP servers are internals of the jobs that wrap them. This is the single most important mental model to get right:

- **An agent declared without a job that invokes it is unreachable.** Chat cannot call agents directly, only jobs. A lone `agents.kb-agent` with MCP tools attached will sit idle. The validator catches this as `orphan_agent`.
- **Memory is accessed by agents, not signals or jobs directly.** Agents see narrative memory auto-injected into their prompts. Agents call `save_memory_entry`, `list_memory_entries`, `delete_memory_entry` explicitly for older entries or specific filters.
- **Tools belong to agents** (via the agent's `tools:` array), and the tools have to be enabled at workspace scope (in `tools.mcp.servers`) for the agent to use them.

**What this means for authoring:** work backward from the trigger. What signal fires this? What job does that signal start? What agents does that job invoke? What tools do those agents need? Declare agents first, then jobs that reference them, then signals that trigger those jobs.

---

## Recipe: build or modify a workspace

Follow this order exactly. Skipping steps produces the failure modes documented in real chat transcripts.

### 1. List available capabilities

Call `list_capabilities` once at the start of any new workspace work. The response returns bundled agents first (alphabetical), then enabled MCP servers, then available MCP servers from the catalog. Scan top-down and pick the first match for each piece of work the workspace needs — bundled comes first because it is zero-config and platform-managed.

The result is stable for the session — re-call only after `enable_mcp_server` (which adds to the enabled set). Bundled agents and the catalog do not change during a session. **Do not duplicate this list into the skill or your own notes; `list_capabilities` is the source of truth.**

Scan top-down and pick the first match **whose `constraints` don't rule out the user's intent**. Bundled comes first because it is zero-config, but a bundled agent that cannot do what the user asked is worse than a correctly wired MCP tool.

### 2. Wire capabilities

For each capability you picked, branch on the entry's `kind`:

- **`bundled`** — pass straight into `upsert_agent` as `type: atlas, agent: "<id>"`. No enable step, no credentials beyond what the agent declares in `requiresConfig`.
- **`mcp_enabled`** — already wired into the workspace. Reference the server's tools directly from your agent's `tools` array.
- **`mcp_available`** — call `enable_mcp_server` first. If the server isn't in the platform catalog yet, call `search_mcp_servers` → `install_mcp_server` first. See the `using-mcp-servers` skill for the full decision tree.

### 2b. Discover tool names

Before adding an agent that uses MCP tools, call `list_mcp_tools({ serverId })` to get the exact tool names the server exposes. Use these names verbatim in the agent's `tools` array. Do not guess tool names.

Example: `list_mcp_tools({ serverId: "google-gmail" })` returns `[{ name: "gmail_list_messages", description: "..." }, ...]` — use `"gmail_list_messages"` in the agent config.

### 3. Connect credentials

If an enabled server requires credentials (GitHub token, API key, OAuth), call `connect_service(provider)` before any agent references the server's tools. The user will be prompted to authenticate; on `data-credential-linked`, continue.

### 4. Decide direct vs draft mode

**Direct mode** — use when the change is a single atomic operation:
- Add one signal to an existing workspace.
- Update one agent's prompt or model.
- Remove one entity with `delete_agent` / `delete_signal` / `delete_job` (per-kind).

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

**Memory stores.** Every workspace has a default memory baseline:

| Name | Kind | Type | Notes |
|---|---|---|---|
| `notes` | own | short_term / narrative | Agent writes — observations, results, preferences |
| `memory` | own | long_term / narrative | Long-lived context, populated by system reflector |
| `user-notes` | mount | ro / workspace scope | Read-only view of the user workspace's `notes` store |
| `user-memory` | mount | ro / workspace scope | Read-only view of the user workspace's `memory` store |

To add a custom store: `upsert_memory_own({ id: "findings", config: { type: "short_term", strategy: "narrative" } })`.
To add a cross-workspace mount: `upsert_memory_mount({ id: "shared-kb", config: { source: "<wsId>/narrative/kb", mode: "ro", scope: "workspace" } })`.
Both tools upsert-by-name: passing an existing `id` replaces the entry; a new `id` appends to the array.

`unknown_memory_store` validation error — fix path: an agent prompt references a store name (e.g. `"ghost-store"`) that isn't declared in `memory.own` or visible via `memory.mounts`. Fix by calling `upsert_memory_own({ id: "ghost-store", config: { type: "short_term", strategy: "narrative" } })` before the agent upsert, or update the prompt to reference an existing store name.

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

**For broken Python/TS agent code (workspace YAML validates clean but the job fails at runtime):** load `@friday/writing-friday-python-agents`. Fix the agent source via `fs_write_file` (writes to host paths — agent source lives at `~/.friday/local/agents/{id}@{version}/agent.py`, outside the workspace-chat `write_file` scratch sandbox), then re-register via the daemon API (`POST /api/agents/register` with `{"entrypoint": "<abs path>"}`). Once you can name the specific fix, stop diagnosing and apply it — don't keep investigating because something else might also be broken.

**For codebase exploration or multi-file edits:** `agent_claude-code` is the right tool.

The failure mode this prevents: reaching for `agent_claude-code` as a panic button when uncertain, turning a 5-second curl into an 8-minute agent call.

---

## CRUD reference — curl examples

All examples below use `$FRIDAYD_URL` and a `friday_curl` helper that adds
`--cacert` when TLS is on. Paste this preamble once per shell so the
examples work on both plain-HTTP and TLS-enabled installs:

```bash
set -a
. "${FRIDAY_HOME:-$HOME/.friday/local}/.env" 2>/dev/null \
  || . "$HOME/.atlas/.env" 2>/dev/null || true
set +a
friday_curl() { curl ${FRIDAY_TLS_CA:+--cacert "$FRIDAY_TLS_CA"} "$@"; }
```

Confirm the daemon is up:

```bash
friday_curl -sf "$FRIDAYD_URL/health" && echo OK
```

### List workspaces

```bash
friday_curl -s "$FRIDAYD_URL/api/workspaces" | jq
```

Resolve a display name to a runtime id:

```bash
friday_curl -s "$FRIDAYD_URL/api/workspaces" | \
  jq -r '.[] | select(.name == "my-workspace") | .id'
```

### Get workspace + config

```bash
# Summary (id, name, status, path)
friday_curl -s "$FRIDAYD_URL/api/workspaces/$WS" | jq

# Full parsed config
friday_curl -s "$FRIDAYD_URL/api/workspaces/$WS/config" | jq
```

### Update workspace (full replacement)

```bash
friday_curl -s -X POST "$FRIDAYD_URL/api/workspaces/$WS/update" \
  -H 'Content-Type: application/json' \
  -d '{"config": {"version":"1.0","workspace":{"name":"new-name"}}, "backup": true}'
```

Pass `backup: true` to preserve a timestamped `workspace.yml.backup-<ts>`. Pass `force: true` to override the active-session guard.

**For single-entity changes (add/update an agent, job, or signal), always use the upsert tools — not curl.** `upsert_agent`, `upsert_job`, and `upsert_signal` are typed, return structured diffs, and handle draft/live switching automatically. The raw HTTP partial-update endpoints (`PUT /config/agents/:id`, `PATCH /config/signals/:id`, `POST /config/signals`) require the full entity shape including fields the model may not know (e.g. `type`), produce opaque errors, and bypass draft mode. Never use them for agent/job/signal edits.

### Delete a workspace (single)

```bash
friday_curl -sf -X DELETE "$FRIDAYD_URL/api/workspaces/$WS"
```

**Rejects 403** for system workspaces (`system`, `user`, `thick_endive`). Resolve name → id first; never guess runtime IDs.

### Delete workspaces (batch — by name prefix)

```bash
friday_curl -s "$FRIDAYD_URL/api/workspaces" | \
  jq -r '.[] | select(.name | startswith("test-")) | .id' | \
  while read -r id; do
    result=$(friday_curl -sf -X DELETE "$FRIDAYD_URL/api/workspaces/$id")
    echo "$id: $result"
  done
```

**Dry-run first** — list names before deleting:

```bash
friday_curl -s "$FRIDAYD_URL/api/workspaces" | \
  jq -r '.[] | select(.name | startswith("test-")) | "\(.id)  \(.name)"'
```

### Delete workspaces (batch — explicit id list)

```bash
for id in layered_ham smoky_almond ripe_eggplant; do
  result=$(friday_curl -sf -X DELETE "$FRIDAYD_URL/api/workspaces/$id")
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

## Agent type — worked examples

The cheat-sheet table covers the decision rule. These are worked examples for each authorable type.

- **`atlas` (bundled platform agent).** Browse + scrape + summarise the top headlines from Hacker News → `type: atlas, agent: "web"`. Post a daily standup to Slack → `type: atlas, agent: "slack"`. The bundled agent already knows the domain — you supply intent in `prompt`, not mechanics.
- **`llm` (inline LLM with prompt + tools).** Default for open-ended work — classifying, summarizing, scoring, choosing among options. Email triage → `type: llm` with gmail MCP tools. PR summarization → `type: llm` with github MCP tools. If the agent's job is "decide what to do given this input," it's `llm`.
- **`user` (Python or TS SDK agent).** ONLY when each call's decision is mechanical — regex match, schema validation, fixed routing table, deterministic format conversion. A CSV-row parser that extracts fixed fields → `user`. A tile renderer using PIL → `user`. **If the agent body would call `ctx.llm.generate` to decide anything, this is the wrong type — use `llm`.** Python-agent authoring is an out-of-flow step the user kicks off explicitly — see the `writing-friday-python-agents` skill.
- **Hybrid.** A map-builder that calls an LLM for design but Python for tile rendering — one `llm` agent delegates to one `user` agent for the render step.

---

## Top gotchas — read before writing any config

1. **Don't reach for an MCP server when a bundled agent exists for the same domain *and* the work is open-ended.** Common over-MCP traps: `playwright-mcp` instead of `type: atlas, agent: "web"`; `slack-mcp` instead of `type: atlas, agent: "slack"`. The flip side: when the work is a deterministic single call, MCP-as-tool is the right pick — don't over-bundle. Run `list_capabilities` first; if a bundled agent matches and the work is open-ended, use it.

2. **Atlas agents are self-contained black boxes — they do not invoke MCP tools.** Bundled agents ship with hard-wired transport (Playwright for `web`, etc.). If the user's intent requires calling a specific MCP tool — e.g., `google-gmail/send_gmail_message`, `github-mcp/create_issue` — `type: atlas` is the wrong choice. To call an MCP tool, use `type: llm` with the tool in `config.tools`. **Read the bundled agent's `constraints` in `list_capabilities`.** That's where the agent explicitly flags what it *cannot* do. If `constraints` rule out the intent, skip the bundled agent and fall through to MCP-enabled / MCP-available.

3. **For `type: atlas`, the `prompt` field is task-specific context layered on the agent's bundled behavior.** Describe the user's intent, not the mechanics. The bundled agent already knows how to drive a browser / call the GitHub API — don't re-teach it.

   ```yaml
   agents:
     news-scout:
       type: atlas
       agent: "web"
       prompt: |
         Pull the top 5 headlines from news.ycombinator.com.
         Save the title, URL, and points to memory under "daily-headlines".
   ```

3. **`browser` and `research` are server-side aliases for the unified `web` agent.** They are not advertised in `list_capabilities` and you should not write them in new workspaces. If you encounter `agent: "browser"` or `agent: "research"` in an existing workspace, leave it alone — the server still accepts it.

4. **Pass `workspaceId` after `create_workspace`.** The draft and upsert tools default to the current session workspace. When you create a new workspace from a chat session in a different workspace, every subsequent `begin_draft`, `upsert_*`, `validate_workspace`, `publish_draft`, `discard_draft`, `enable_mcp_server`, and `disable_mcp_server` call must include `workspaceId: '<new-id>'` or the changes land on the wrong workspace.

5. **Jobs must use `fsm:`, not `execution:`**. The schema accepts both; the runtime silently skips any job lacking `fsm:` and signal dispatch fails at runtime with `"No FSM job handles signal '<name>'"`.

6. **FSM shape is XState-style.** States are `{ entry: [...actions], on: { EVENT: { target: 'next' } } }` or `{ type: 'final' }`. Do **not** use `type: action, action: {...}, next: ...` — the validator rejects it with `fsm_structural_error`.

   For detailed job authoring guidance, load `@friday/writing-workspace-jobs` before creating or editing any `fsm:` job.

   For detailed signal authoring guidance (schema payloads, provider configs, path collisions), load `@friday/writing-workspace-signals` before creating or editing any signal.

7. **`write_file` writes to scratch only** (`{FRIDAY_HOME}/scratch/{sessionId}/`). To edit a workspace on disk, use `run_code` with an absolute path.

8. **Always call `list_mcp_tools` before referencing MCP tools in an agent.** Tool names are not predictable — they come from the server implementation, not the server ID. Guessing produces `unknown_tool` validation errors. Call `list_mcp_tools({ serverId })`, then use the returned names verbatim in the agent's `tools` array. The returned names are already prefixed as `serverId/toolName`.

9. **Never report "saved to memory" without verifying.** Setup can look successful end-to-end and still silently fail. Before reporting success:
   1. Fire the signal once with a canary payload.
   2. Poll `GET /api/sessions/:id` until terminal (`completed` / `failed`).
   3. Read back with `GET /api/memory/:workspaceId/narrative/:memoryName`.
   4. Surface any mismatch explicitly — don't paper over it.

10. **Always resolve workspace IDs from the API.** Runtime IDs like `layered_ham` are random per daemon. Never hardcode them.

11. **Never DELETE+CREATE a workspace to edit it.** That loses the runtime id, kills sessions, and breaks cross-workspace mounts. Use in-place updates (`POST /update` or partial endpoints) instead.

12. **Per-job and per-workspace policy blocks.** workspace.yml carries a few optional blocks beyond the core wiring. All precedence chains follow **per-job > per-workspace > daemon-level** (env var or runtime default), except `validation:` which extends one level higher to action-level.
    - **`permissions: { dangerouslySkipAllowlist: bool }`** — bypass tool/skill allowlist enforcement. Floor: daemon `FRIDAY_DANGEROUSLY_SKIP_PERMISSIONS=1` env var. Trusted contexts only. Without bypass, allowlist denials become elicitations: an agent that calls `request_tool_access(toolName, reason)` produces a `tool-allowlist` elicitation surfaced via `GET /api/elicitations`, the Activity page, and sidebar pending badges. The blocked action waits for allow/deny/expiry; on allow it resumes in the same session. For non-permission user decisions, call `request_human_input({ question, options? })`; it creates an `open-question` elicitation and returns the answer to the same run.
    - **`delegation: { max_depth, max_steps_per_call, max_output_tokens, max_input_tokens, max_wall_time_ms, max_cost_usd }`** — bounds for the `delegate` tool when an agent uses it. Workspace-level + per-job override (`jobs.<name>.delegation`) — per-field merge, job wins. Default `max_depth: 1`.
    - **`validation: { default, skill }`** — default LLM-output validation strategy applied to `type: llm` / `type: agent` actions that don't set `validate:` themselves. See the dedicated `validation:` section below for the full precedence chain (action > job > workspace > `"auto"`).
    - **`memory.own[].ttl: <duration>`** — explicit TTL on a memory store. Without it, `type: short_term` (notes) defaults to ephemeral session-bound and `type: long_term` (memory) to durable.
    - **`artifacts: { default_grace: <duration> }`** — workspace-level grace window after job completion before ephemeral artifacts are swept (default `24h`). Per-job override: `jobs.<name>.artifacts: { default_grace, ephemeral }`. Promotion-by-reference (a `save_memory_entry` text containing the artifact id, a `display_artifact` call, or `aiSummary.keyDetails[].url`) keeps an artifact alive past the grace window with no author opt-in.
    - **`jobs.<name>.elicitations: { timeout: <duration> }`** — per-job elicitation timeout, independent of `config.timeout`. Useful for long batch jobs whose individual prompts shouldn't sit unanswered.

    Worked example showing every option in one workspace.yml. Comments
    flag mutually exclusive choices and per-job overrides.

    ```yaml
    # ── Workspace-level defaults (top of workspace.yml) ────────────
    permissions:
      # Bypass tool/skill allowlist enforcement. When true, NO elicitations
      # fire — the elicitation flow and bypass are mutually exclusive.
      # Trusted contexts only. Job-level setting wins; daemon
      # FRIDAY_DANGEROUSLY_SKIP_PERMISSIONS=1 env var is the floor.
      dangerouslySkipAllowlist: false

    delegation:
      # Per-field merge with per-job override. Job wins per-field; unset
      # fields fall through to workspace, then to runtime defaults.
      max_depth: 1                # default 1; child cannot itself delegate
      max_steps_per_call: 40
      max_output_tokens: 20000
      max_input_tokens: 100000
      max_wall_time_ms: 120000
      max_cost_usd: null          # reserved; not enforced until cost-tracking lands

    validation:
      # Default LLM-output validation strategy. Per-field merge with
      # per-job override; action-level `validate:` always wins. See the
      # `validation:` section below for the four-level precedence chain
      # and what each strategy means at runtime.
      default: auto               # auto | skip | self | external
      skill: validating-llm-outputs   # OPTIONAL: override the validator skill

    artifacts:
      # Workspace-level grace window after job completion before ephemeral
      # artifacts are swept. Default '24h'. Promotion-by-reference
      # (save_memory_entry text containing the id, display_artifact, or
      # aiSummary.keyDetails[].url) keeps an artifact past the window.
      default_grace: 24h

    memory:
      own:
        - name: notes
          type: short_term        # ephemeral session-bound
          strategy: narrative
          # ttl: 7d               # OPTIONAL: explicit TTL overrides the
                                  #   type-default. With ttl set, type
                                  #   becomes advisory.
        - name: memory
          type: long_term         # durable across sessions
          strategy: narrative

    # ── Per-job overrides (under jobs.<name>) ─────────────────────────
    jobs:
      sensitive-job:
        config:
          timeout: 30m            # parent timeout; default for elicitation TTL
          max_steps: 60

        # Per-job permissions override. Wins over workspace; daemon env
        # var is the floor for both.
        permissions:
          dangerouslySkipAllowlist: true   # this job bypasses; siblings stay strict

        # Per-job delegation override. Per-field merge with workspace.
        delegation:
          max_depth: 2            # only this job; siblings inherit workspace 1
          max_wall_time_ms: 60000

        # Per-job validation override. Per-field merge with workspace;
        # action-level `validate:` still wins over both.
        validation:
          default: external       # this job's actions get judged unless action overrides
          # skill: "@my/financial-claims"   # OPTIONAL: domain-specific judge

        # Per-job artifact lifecycle. EITHER ephemeral (whole-job) OR
        # default_grace (window override) — both can coexist; ephemeral
        # is the kind, default_grace is the sweep delay.
        artifacts:
          ephemeral: true         # all this job's artifacts ephemeral
                                  # (omit for per-action defaults: terminal-state
                                  #  outputs durable, non-terminal ephemeral)
          default_grace: 6h       # shorter grace than workspace 24h

        # Per-job elicitation timeout. Independent of config.timeout —
        # use to constrain individual prompt latency on a long job.
        elicitations:
          timeout: 5m

        triggers:
          - signal: ...
        fsm:
          # ...
    ```

    Mutually exclusive / precedence reminders:
    - `permissions.dangerouslySkipAllowlist: true` and the elicitation
      flow are exclusive. Bypass-on jobs never emit elicitations; their
      `request_tool_access` calls return `{ ok: true, granted: true,
      reason: "bypass" }` immediately.
    - `memory.own[].ttl` overrides the type-based default. Set it only
      when the type default is wrong; otherwise omit and let `short_term`
      stay session-bound, `long_term` durable.
    - `artifacts.ephemeral: true` (job-level) forces every artifact this
      job emits to be ephemeral. Omit it to let the runtime apply
      per-action defaults (terminal-state outputs durable, non-terminal
      ephemeral). The two are exclusive within a single job.
    - `delegation.max_cost_usd` accepts `null` for "no enforcement";
      a positive number is reserved for the future cost-tracking layer
      and currently has no runtime effect.

---

## `validation:` — LLM-output validation defaults

Workspace- and job-level defaults for the LLM-output validation
policy applied to every `type: llm` and `type: agent` action that
doesn't set `validate:` itself. Sits alongside `permissions:` and
`delegation:` and follows the same merge model — except the
precedence chain extends one level higher to action-level.

### The block

```yaml
# workspace.yml — workspace-wide default
validation:
  default: external      # auto | skip | self | external
  skill: "@my/judge"     # optional; defaults to validating-llm-outputs

# workspace.yml — job-level override
jobs:
  review-inbox:
    validation:
      default: skip
```

Both `default` and `skill` are optional. Per-field merge with the
workspace block: a job that sets only `default:` inherits
`workspace.validation.skill`, and vice versa.

### Precedence (highest wins)

```
action.validate.strategy
  > job.validation.default
  > workspace.validation.default
  > "auto"   (the classifier — see writing-workspace-jobs)
```

`skill` resolution follows the same chain; falls back to
`validating-llm-outputs` when nothing is set.

### What each `default:` value means

- `auto` — runtime classifier picks per-action: `skip` for
  read-only / structured actions, `self` for prose / mutating
  actions. Never auto-picks `external`.
- `skip` — bypass validation entirely.
- `self` — LLM self-checks its draft via the
  `validating-llm-outputs` skill (or your `skill:` override).
- `external` — separate-judge LLM call after the action emits.

For the deeper auto-detect rules (which tools count as read-only,
which verbs as mutating), see the **Validation strategies**
section in `@friday/writing-workspace-jobs`.

### Skill override

Pin a domain-specific validator with `skill:`:

```yaml
validation:
  default: self
  skill: "@my/financial-claims"
```

The same skill works for both `self` and `external` strategies —
one source-of-truth for what counts as a sourced claim. Useful for
financial / medical / legal workspaces where the generic validator
under-flags domain claims.

### Real-world configs

Always check everything (high-stakes workspace, latency-tolerant):

```yaml
validation:
  default: external
```

Trust everything; the FSMs verify with deterministic agents:

```yaml
validation:
  default: skip
```

Per-job mix — workspace defaults to `external`, one high-volume
job downgrades to `self`:

```yaml
validation:
  default: external

jobs:
  triage-inbox:
    validation:
      default: self     # cheaper; runs on every inbound message
    fsm:
      # ...
```

### Cross-references

- `@friday/writing-workspace-jobs` — **Validation strategies**
  section covers action-level `validate:` (string and object form),
  the auto-detect classifier rules, and worked overrides.
- `@friday/validating-llm-outputs` — system skill the runtime
  composes into action prompts when the resolved strategy is
  `self`. Not user-loadable; runtime composes it automatically.

---

## Go deeper

- `assets/example-kb-workspace.yml` — narrative-memory-only workspace. No jobs, no agents, no MCP. Use for trivial save-and-recall (notes, URLs, quotes, reading list).
- `assets/example-jobs-pipeline.yml` — signals + jobs + FSM + MCP. Use for structured storage, signal-triggered work, or multi-step pipelines.
- `references/updating-workspaces.md` — partial-update API details, disk-edit path, when to use each.
- `references/messaging-signals.md` — Slack, Telegram, WhatsApp signal configuration.
- `references/platform-friday-yml.md` — platform-level overrides (transport, auth, rate limits).
- `references/agent-types.md` — `atlas` / `user` / `llm` worked examples with full agent + FSM wiring.
- `writing-workspace-jobs` skill — FSM job authoring: trigger wiring, MCP tool naming, state-machine shapes, validation error decoder, runtime anti-patterns. Load before creating or editing any `fsm:` job.
- `writing-workspace-signals` skill — Signal authoring: JSON Schema payloads, provider configs, HTTP path collisions, cron validation, runtime payload checks. Load before creating or editing any signal that accepts parameters or needs a webhook endpoint.
- `using-mcp-servers` skill — MCP catalog, install/enable/disable, credentials, delegation.
- `writing-friday-python-agents` skill — authoring and registering Python/TS SDK agents.
- `friday-cli` skill — daemon lifecycle, signal triggering, session streaming, log forensics.
