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

1. **Find the failing session or trigger.** Use daemon/session tools when available. If the user gives a URL, identify workspace id, chat id/session id, job name, and failing action.
2. **Read the workspace config.** Locate signals, agents, jobs, permissions, validation settings, and MCP servers.
3. **Identify the action type.** `type: llm`, `type: agent` wrapping `type: llm`, `type: agent` wrapping `type: user`, and `type: agent` wrapping `type: atlas` have different contracts.
4. **Inspect the actual tool catalog.** Do not infer tool names from prose or old generated code. Use the platform discovery/listing path from `using-mcp-servers` / `workspace-api`.
5. **Inspect persisted output.** If a downstream action received empty/stub data, find the upstream `outputTo` writer and verify whether it called the required output tool.

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

The chat-agent's tool surface was renamed for verb-first consistency.
If a workspace's Python agent or `tools:` whitelist references an old
name, the workspace will fail validation or the agent will get
"unknown tool" at runtime. The fix is grep-and-replace.

| Old name | New name | Applies to |
|---|---|---|
| `workspace_delete` | `delete_workspace` | tool calls in agents / `permissions.tools.allow` |
| `remove_item({kind, id})` | `delete_agent({id})` / `delete_signal({id})` / `delete_job({id})` | per-kind delete; the union form is gone |
| `memory_save` | `save_memory_entry` | chat-surface tool calls; user-agent SDK still uses the old name (the daemon's MCP `memory/save.ts` was not renamed) |
| `memory_read` | `list_memory_entries` | chat surface only — same caveat as above. The new shape adds `query` / `since` / `until` / `metadata` filters and pagination; `since` and `limit` keep their meaning, the rest are additive. |
| `memory_remove` | `delete_memory_entry` | chat surface only — same caveat as above |
| `artifacts_get` | `get_artifact` | tool calls in agents / `permissions.tools.allow` |
| `artifacts_create` | `create_artifact` | tool calls in agents / `permissions.tools.allow` |
| `get_mcp_dependencies` | `describe_mcp_server({id})` (with `scope=workspace`, default) | folded into describe — output now includes `agentIds` / `jobIds` plus the wired config |

Repair pattern:

1. Grep the workspace dir for the old name(s):
   `grep -RIn 'memory_read\|memory_save\|memory_remove\|workspace_delete\|remove_item\|artifacts_get\|artifacts_create\|get_mcp_dependencies' .`
2. For each hit, replace with the new name using the table above. The
   per-kind `delete_agent` / `delete_signal` / `delete_job` rename
   from `remove_item` requires reading the call site to pick the
   right kind.
3. Re-validate the workspace and re-run the failing job/signal.

User-agent caveat: the user-agent SDK (`ctx.tools.call(...)`) goes
through the daemon's MCP server, which still exposes
`memory_save` / `memory_read` / `memory_remove` for backwards
compatibility with installed Python agents. Renaming inside a Python
agent is therefore optional — the chat-surface renames don't break
user agents — but flagged for consistency.

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
