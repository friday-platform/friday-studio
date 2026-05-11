---
name: repairing-workspaces-agents
description: Repairs and upgrades existing Friday workspaces, jobs, user agents, and generated agents to current runtime contracts. Use when a workspace/job/agent is failing, when upgrading old workspace.yml or Python agents, when tools are missing or unauthorized, when jobs emit empty outputs, or when an interactive workflow needs HITL repair.
---

# Repairing workspaces and agents

Use this skill as the repair runbook for existing Friday workspaces, jobs, and agents. The goal is to preserve the user's intent while upgrading the implementation to the current runtime contracts: host capabilities, refs over data, explicit output emission, and real HITL.

Copy this checklist into your working notes:

```text
Repair checklist:
- [ ] 1. Reproduce or inspect the failing session/job before editing.
- [ ] 2. Load companion skills for the surface being repaired.
- [ ] 3. Identify the failing boundary: workspace config, signal, job/FSM, agent source, MCP/tool catalog, output contract, or HITL.
- [ ] 4. Make the smallest repair that restores the current contract.
- [ ] 5. Validate the workspace/job/agent through the daemon, not just by reading files.
- [ ] 6. Leave durable notes: what failed, what contract was violated, and how to avoid regenerating the old pattern.
```

## Load companion skills first

Load the narrow skill for the part you are touching:

| Repair target | Load |
|---|---|
| Workspace CRUD, `workspace.yml`, validation, live daemon API | `@friday/workspace-api` |
| Jobs, FSM actions, `outputTo`, `inputFrom`, validation defaults | `@friday/writing-workspace-jobs` |
| Python `type: user` agents, `AgentContext`, tool calls | `@friday/writing-friday-python-agents` |
| MCP servers, tool discovery, auth/connect flows, real tool names | `@friday/using-mcp-servers` |
| Output validation, `validate: self`, complete-vs-validation confusion | `@friday/validating-llm-outputs` |
| Daemon sessions, logs, NATS streams, signals | `@friday/friday-cli` |

Do not treat this skill as a replacement for those. This skill gives the repair sequence and production anti-patterns; the companion skills give exact APIs and authoring details.

## First pass: classify the failure

Start from evidence, not guesses.

1. **Find the failing session or trigger.** Call `list_sessions` / `describe_session(id)` from chat, or `deno task atlas session list/get` from a terminal. If the user gives a URL, identify workspace id, chat id/session id, job name, and failing action.
2. **Read the workspace config.** Call `describe_workspace(id)` for the full record, then drill in with `list_agents` / `list_jobs` / `list_signals` / `list_memory_stores` / `list_communicators` / `describe_draft` as needed.
3. **Identify the action type.** `type: llm`, `type: agent` wrapping `type: llm`, `type: agent` wrapping `type: user`, and `type: agent` wrapping `type: atlas` have different contracts.
4. **Inspect the actual tool catalog.** Do not infer tool names from prose or old generated code. Call `list_mcp_servers(scope=workspace)` for what's wired, `list_mcp_tools({serverId})` to see a server's tool names + input schemas, `describe_mcp_server({id})` for back-references (which agents/jobs use it), and `list_bundled_agents` / `describe_bundled_agent({id})` for atlas-agent invocation contracts.
5. **Inspect persisted output.** If a downstream action received empty/stub data, find the upstream `outputTo` writer and verify whether it called the required output tool. Use `list_artifacts` / `get_artifact(id)` to inspect what was actually written.

## Current contracts to repair toward

### Python/user agents must use host capabilities

Generated Python agents must call tools through Friday SDK host capabilities:

```python
names = [tool.name for tool in ctx.tools.list()]
result = ctx.tools.call("real_tool_name", {"arg": "value"})
```

Repair old agents that:

- POST directly to `localhost:8002/mcp`, daemon HTTP routes, or arbitrary MCP endpoints.
- Hard-code bearer tokens or assume local auth state.
- Invent names like `search_gmail_messages` without checking the live catalog.
- Hide tool use from observability by bypassing `ctx.tools`.

A repaired user agent should list tools when uncertain, call only real tool names, return schema-safe data, and show tool calls in session observability.

### `outputTo` actions must emit output explicitly

If an LLM/LLM-agent action has `outputTo`, it must call the required output emission tool (`complete` in current FSM prompts). Validation is advisory; it cannot substitute for output emission.

Repair old jobs that:

- Stream prose and stop without calling `complete`.
- Call `record_validation` and accidentally persist no action output.
- Return an empty string or stub object to satisfy the action mechanically.
- Store bulky message bodies inline instead of emitting artifact refs and summaries.

The repaired path should persist a durable document, keep bulky data in artifacts/refs, and make downstream `inputFrom` actions consume the referenced data mechanically.

### HITL is a blocking platform primitive

Interactive decisions belong in `request_human_input`, not in free-form chat menus inside a single action.

Use `request_human_input` when the agent needs:

- A decision between options.
- Approval before a consequential action.
- Disambiguation it cannot safely infer.
- User text before continuing the same run.

Repair old workflows that print "choose A/B" and then expect a later chat turn to resume the same FSM action. The repaired workflow should create an Activity elicitation, block, then resume or terminate with `answered`, `declined`, or `expired` status.

For repeated choices (for example, one action per email), keep the tool contract flat but encode the item id in option labels/values: `[1] Archive — Subject` / `1:archive`, `[1] Keep — Subject` / `1:keep`, etc. Do not invent unsupported `multi_select` fields; grouped answers are returned as a string containing a JSON array of selected values, with optional per-item comments in `note`.

### Tool access requests are only for real tools

`request_tool_access` is for granting access to a known existing tool that is blocked by policy. It is not a discovery mechanism.

If the tool name is unknown:

1. Use capability/MCP discovery.
2. Connect or enable the relevant MCP server if needed.
3. Update the job/agent to use the actual tool name.
4. Only then request access if policy blocks it.

## Repair workflow

### 1. Make a precise diagnosis

Write down:

- What the user expected.
- What actually failed, with the exact error.
- Which runtime contract was violated.
- Which file or persisted config owns the bad behavior.

Good diagnosis examples:

- "Python user agent bypasses `ctx.tools` and posts to local MCP; tool calls are invisible and auth fails."
- "FSM action has `outputTo` but stops with prose; downstream `inputFrom` receives no durable document."
- "Agent asks the user to choose in chat instead of using `request_human_input`; the action cannot resume."

Bad diagnosis examples:

- "Gmail is broken."
- "Need better prompt."
- "Maybe auth issue."

### 2. Repair the owning boundary

Prefer changing the layer that owns the bad contract:

| Symptom | Repair boundary |
|---|---|
| Missing/old tool names | MCP catalog config or agent code using discovery |
| 401 from direct MCP HTTP | Python agent source: replace raw HTTP with `ctx.tools` |
| Empty action document | Job/FSM action prompt + output contract |
| Downstream hallucination after empty input | Upstream `outputTo`, not downstream prompt patch |
| Menu printed but no resume | Add `request_human_input` to the action/agent |
| Bulky data in chat/job result | Output artifact refs + compact summary |

Do not patch around broken jobs by scraping chat logs, replaying child transcripts into a supervisor prompt, or delegating to reconstruct data that should have been persisted.

### 3. Validate through the daemon

Validation should prove the repaired runtime behavior, not just syntax.

Minimum gates for a production repair:

- Workspace validates/loads.
- The failing signal/job can be triggered.
- The action emits the expected durable output document or artifact ref.
- Relevant tool calls appear in session observability.
- HITL paths are tested for at least the expected terminal status (`answered`, `declined`, or `expired`).

When external auth is unhealthy, use deterministic fake/no-auth tooling to prove the contract shape, then separately report the credential issue.

## Tool renames — workspaces with hard-coded old names

The platform's tool surface was renamed for verb-first consistency in
2026-05. The rename hit every caller — chat agents, FSM `type: llm`
actions, and Python `type: user` agents calling `ctx.tools.call(...)`.
There are no aliases; old names return "unknown tool" at runtime.

| Old name | New name | Where it appears |
|---|---|---|
| `workspace_delete` | `delete_workspace` | `ctx.tools.call(...)` in Python agents, `permissions.tools.allow` lists, FSM `tools:` whitelists |
| `remove_item({kind, id})` | `delete_agent({id})` / `delete_signal({id})` / `delete_job({id})` | chat tool only; the union form is gone — per-kind matches `upsert_<kind>` |
| `memory_save` | `save_memory_entry` | every caller (chat, FSM, `ctx.tools.call`) |
| `memory_read` | `list_memory_entries` | every caller. New shape adds `query` / `since` / `until` / `metadata` filters and pagination; `since` and `limit` keep their meaning, the rest are additive. The legacy `ReadResponse` envelope is gone — direct `{items, has_more, next_cursor?}` shape. |
| `memory_remove` | `delete_memory_entry` | every caller |
| `artifacts_get` | `get_artifact` | every caller |
| `artifacts_create` | `create_artifact` | every caller |
| `get_mcp_dependencies` | `describe_mcp_server({id})` (with `scope=workspace`, default) | chat tool only; output now includes `agentIds` / `jobIds` plus the wired config |

Repair pattern:

1. Grep the workspace dir + any installed Python agents under
   `~/.friday/agents/<id>@<version>/` for the old name(s):

   ```sh
   grep -RIn 'memory_read\|memory_save\|memory_remove\|workspace_delete\|remove_item\|artifacts_get\|artifacts_create\|get_mcp_dependencies' .
   ```

2. For each hit, replace with the new name using the table above. The
   per-kind `delete_agent` / `delete_signal` / `delete_job` rename
   from `remove_item` requires reading the call site to pick the
   right kind. Most replacements are bare grep-and-replace; the
   `memory_read` → `list_memory_entries` rename also drops the
   `ReadResponse` envelope, so callers that read `result.items`
   continue to work and callers that read `result.provenance` need
   to drop that field reference.

3. Re-register the agent (`register_agent({entrypoint})`) so the
   updated source overwrites the install dir, then re-validate the
   workspace and re-run the failing job/signal.

If a Python agent fails with `ToolCallError("unknown tool: memory_save")`
post-upgrade, that's the rename surfacing; apply step 2 to the agent's
source and re-register.

## Gotchas

- **Do not preserve non-user-visible compatibility shims.** If an old generated pattern is wrong, remove it rather than wrapping it.
- **Do not invent MCP tool names.** Always inspect the live catalog or fixture catalog.
- **Do not use local daemon/MCP HTTP from Python agents.** Use `ctx.tools`; the host supplies NATS/session/tool scope.
- **Do not turn validation into output.** `record_validation` does not satisfy `outputTo`.
- **Do not fan child data back into the supervisor.** Persist refs/artifacts and return compact summaries.
- **Do not solve a blocking user decision with a prompt-only menu.** Use `request_human_input`.
- **Do not silently skip a failing installed agent.** If the installed source under Friday home is wrong, patch/regenerate it or clearly tell the user it remains unrepaired.

## Repair note template

When done, summarize like this:

```text
Repair summary:
- Failing surface:
- Root cause:
- Contract restored:
- Files/config changed:
- Validation run:
- Remaining external dependency, if any:
```
