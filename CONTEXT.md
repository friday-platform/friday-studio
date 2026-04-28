# Friday Domain Context

Friday is an AI agent orchestration platform. Workspaces run autonomous agents triggered by signals (HTTP webhooks, cron schedules, filesystem watches, messaging). Users interact with workspaces through a chat interface (workspace-chat) that configures and manages workspaces via the daemon HTTP API.

## Core Concepts

### Workspace
A unit of agent orchestration. Defined by `workspace.yml` on disk, loaded by the daemon at startup. Contains signals, jobs, agents, memory, tools, skills, and resources. Keyed by a runtime ID (`layered_ham`-style random identifier) and a human-readable name.

### Signal
An external event that triggers a job. Types: `http` (webhook), `schedule` (cron), `fs-watch` (filesystem change), `system` (platform-internal), or messaging (Slack, Telegram, WhatsApp). Each signal has a schema defining its payload.

### Job
An FSM (finite state machine) pipeline that executes when a signal fires. Jobs are keyed by kebab-case IDs. Each job has an `fsm` block with XState-style states: action states (`{ entry: [...actions], on: { EVENT: { target: 'next' } } }`) and terminal states (`{ type: 'final' }`).

### Agent
A compute unit invoked by a job FSM action. Three types:
- `llm`: Inline LLM agent with provider, model, prompt, temperature, tools array.
- `atlas`: Registered agent from the platform registry.
- `user`: SDK agent (Python/TypeScript) compiled to WebAssembly.

Agents are declared in the top-level `agents` section and referenced by `agentId` within job FSM actions.

### MCP Server
An external tool server (stdio, HTTP, or SSE transport) that exposes tools agents can call. Declared in `tools.mcp.servers`. The daemon spawns the server process, manages its lifecycle, and routes tool calls from agents.

### Memory
Persistent state across sessions. Three kinds:
- `short_term` / `long_term`: Narrative or retrieval corpora owned by the workspace.
- `mounts`: Read/write access to other workspaces' memory.
- Chat auto-injects recent narrative entries into the LLM system prompt.

### Skill
A markdown document auto-loaded into an agent's system prompt. Global skills (shipped with the platform) or workspace-local inline skills.

## Call Chain (Reachability)

```
User message → workspace-chat (LLM)
                     │
                     ├─ calls memory_save / memory_read (built-in)
                     │
                     └─ calls job tool → fires signal → FSM runs
                                                │
                                                └─ invokes agents → calls MCP tools
                                                              └─ reads/writes memory
```

**Critical invariant:** An agent declared without a wrapping job is unreachable. Nothing triggers it. The runtime never invokes it. Memory is accessed by agents, not signals or jobs directly. Tools belong to agents (via the agent's `tools` array), and tools must be enabled at workspace scope (`tools.mcp.servers`) for the agent to use them.

## Draft Mode

A workspace can be in **direct mode** (default) or **draft mode** (opt-in). In direct mode, every mutation writes to `workspace.yml` and runs full validation. In draft mode, mutations write to `workspace.yml.draft`; cross-entity validation is deferred to `validate_workspace` and `publish_draft`.

- Draft and direct are **mutually exclusive** — if a draft exists, all mutations write to it.
- `begin_draft` snapshots live config into the draft file. Idempotent (no-op if draft exists).
- `publish_draft` validates the draft, then atomically swaps it to `workspace.yml` and reloads the runtime.
- `discard_draft` deletes the draft file.
- The daemon loader ignores `.draft` files.
- MCP server enable/disable participates in draft mode — config writes to draft, server startup deferred to publish.

## Validator

The workspace validator is the compiler. Three layers:
1. **Structural:** Zod schema parse. Walks `ZodError.issues[]` and emits one `Issue` per issue with `path` (dot-notation) and `message` (plain English). Never string-coerces a `ZodError`.
2. **Reference integrity:** Named refs resolve (agent IDs, signal IDs, MCP tools, memory corpora, npm/pypi packages). MCP registry unavailability is treated as a **system failure**, not a warning.
3. **Semantic warnings:** Dead signals, dead agents, LLM agent missing `tools` array, cron parse, HTTP signal path collisions.

Output shape: `{ status: "ok" | "warning" | "error", errors: Issue[], warnings: Issue[] }`. Errors block publish; warnings do not.

## Tool Surface (workspace-chat)

The workspace-chat agent exposes tools the LLM uses to build and manage workspaces. Current tools:

**MCP Management (8):** `list_mcp_servers`, `search_mcp_servers`, `install_mcp_server`, `create_mcp_server`, `get_workspace_mcp_status`, `enable_mcp_server`, `disable_mcp_server`, `connect_service`

**Workspace CRUD (9):** `create_workspace` (thin, name only), `upsert_agent`, `upsert_signal`, `upsert_job`, `remove_item`, `begin_draft`, `validate_workspace`, `publish_draft`, `discard_draft`

## Key Decisions

- **No blueprints.** The legacy planner/compiler/assembler pipeline (workspace-planner → fsm-workspace-creator → @atlas/workspace-builder compiler) is removed. Reliability comes from schema-tight mutation tools + strong validator + draft atomicity, not LLM-driven plan generation.
- **Validator in @atlas/config.** Moved from `@atlas/workspace-builder` (deleted) to co-locate with `WorkspaceConfigSchema`.
- **Big-bang swap.** Old `workspace_create` is removed atomically; no compatibility shim. Safety net is anti-regression tests against real workspaces.
- **Diff returns structured field-level changes**, not text diffs. The LLM confirms intent by reading `tools.added: ["slack"]`.
- **`remove_item` in direct mode refuses if referenced.** In draft mode, permissive — broken references surface at validation.

## Related Documents

- `docs/plans/2026-04-27-workspace-creation-redesign-resolved.md` — Full resolved decision log from domain model interview.
- `docs/plans/2026-04-25-mcp-workspace-management-design.v5.md` — MCP workspace management plan (shipped).
- `packages/system/skills/workspace-api/SKILL.md` — Chat skill for workspace operations.
