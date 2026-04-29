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
A compute unit invoked by a job FSM action. Three user-authorable types:
- `llm`: Inline LLM agent with provider, model, prompt, temperature, tools array. The author wires it themselves.
- `atlas`: Bundled platform agent (`web`, `email`, `slack`, `gh`, `claude-code`, `data-analyst`, `image-generation`, `knowledge`, etc.). The agent has its own internal prompt and tool surface; the author supplies a per-invocation string prompt as additive task context. Discoverable via `list_capabilities`.
- `user`: SDK agent (Python/TypeScript) compiled to WebAssembly. The author registers the agent build, then references it by ID.

A fourth type, `system`, exists in `WorkspaceAgentConfigSchema` but is reserved for platform-internal use — never authorable from workspace-chat, never surfaced in discovery.

Agents are declared in the top-level `agents` section and referenced by `agentId` within job FSM actions. **All bundled atlas agents take a string as per-invocation input** (the FSM action passes a string, the agent layers it on top of its own internal prompt).

### MCP Server
An external tool server (stdio, HTTP, or SSE transport) that exposes tools agents can call. The daemon spawns the server process, manages its lifecycle, and routes tool calls from agents.

### MCP Registry Entry
A daemon-scoped catalog record that describes an MCP server and how to configure it for workspaces. It may carry a Link Provider blueprint for credential setup. Avoid using “MCP server” when you mean the catalog metadata record.

### Blessed MCP Registry Entry
An MCP Registry Entry shipped with the Friday binary. Blessed entries are supplied by the target daemon and are not exported in workspace bundles.

### Dynamic MCP Registry Entry
An MCP Registry Entry added by a user, registry import, or bundle import and stored in the daemon registry. Dynamic entries are portable bundle data.

### Curated Upstream Override
A Friday-maintained override applied while installing an upstream MCP registry entry, such as a display name or static Link Provider ID. The installed entry is still a Dynamic MCP Registry Entry, not a Blessed MCP Registry Entry.

### Enabled MCP Server
A workspace-scoped MCP server configuration declared under `tools.mcp.servers.<id>`. It may come from an MCP Registry Entry template or be authored directly in the workspace config.

### Link Provider
A credential schema registered with Link that tells `connect_service` how to collect OAuth or API-key credentials. A bundled dynamic Link Provider belongs one-to-one to its MCP Registry Entry and uses the same ID. Link Providers are recreated from bundle metadata, but credential values are not exported.

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

## Validator (Workspace)

> Naming note: "Validator" without qualification means **this** — the workspace config compiler. The post-hoc LLM-output checker is the **Output Validator** (see below). Do not conflate.

The workspace validator is the compiler. Three layers:
1. **Structural:** Zod schema parse. Walks `ZodError.issues[]` and emits one `Issue` per issue with `path` (dot-notation) and `message` (plain English). Never string-coerces a `ZodError`.
2. **Reference integrity:** Named refs resolve (agent IDs, signal IDs, MCP tools, memory corpora, npm/pypi packages). MCP registry unavailability is treated as a **system failure**, not a warning.
3. **Semantic warnings:** Dead signals, dead agents, LLM agent missing `tools` array, cron parse, HTTP signal path collisions.

Output shape: `{ status: "ok" | "warning" | "error", errors: Issue[], warnings: Issue[] }`. Errors block publish; warnings do not.

## Output Validator (Hallucination Judge)

A separate, post-hoc verifier that runs on the output of an LLM action (FSM action or ad-hoc agent invocation). Not the workspace Validator above — different concept, different package (`@atlas/hallucination`).

### Judge
The LLM call inside the Output Validator that reads the agent's output plus its tool-result context and emits a structured opinion on whether the output is grounded. Out-of-scope for the judge: arithmetic, timezone conversion, date math (the most common false-positive class).

### Verdict
The Judge's structured output. Three-state status: `pass` / `uncertain` / `fail`. Status is **derived in code** from the judge's confidence and a threshold tied to supervision level, not picked by the judge. `uncertain` proceeds identically to `pass` downstream — it is observability only, not gating. Only `fail` triggers retry.

### Issue
A single per-claim entry on a Verdict. Carries a category (fixed enum: `sourcing`, `no-tools-called`, `judge-uncertain`, `judge-error`), a per-issue severity (derived in code from category, not judge-picked), the flagged claim, the judge's reasoning, and a citation — a verbatim quote from the tool result that should have backed the claim, or `null` when the issue is the absence of a tool call.

### Supervision Level
A workspace-scoped knob (`MINIMAL` / `STANDARD` / `PARANOID`) that sets the confidence threshold for the pass/uncertain boundary. Does not change retry behavior — that stays at one retry on `fail`.

## Tool Surface (workspace-chat)

The workspace-chat agent exposes tools the LLM uses to build and manage workspaces. Current tools:

**Discovery & MCP Management (8):** `list_capabilities`, `search_mcp_servers`, `install_mcp_server`, `create_mcp_server`, `get_mcp_dependencies`, `enable_mcp_server`, `disable_mcp_server`, `connect_service`

**Workspace CRUD (9):** `create_workspace` (thin, name only), `upsert_agent`, `upsert_signal`, `upsert_job`, `remove_item`, `begin_draft`, `validate_workspace`, `publish_draft`, `discard_draft`

`list_capabilities` is the unified discovery surface — returns bundled agents, enabled MCP servers, and available MCP servers as a flat tagged-union list. Bundled-first ordering, alphabetical within each kind. Cached once per session; re-call after `enable_mcp_server`. `get_mcp_dependencies` is the dependency-graph drill-down (which agents/jobs reference each enabled MCP server in this workspace).

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
