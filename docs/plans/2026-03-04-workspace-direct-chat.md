<!-- v3 - 2026-02-26 - Generated via /improving-plans from docs/plans/2026-02-10-workspace-direct-chat-design.v2.md -->

# Workspace Direct Chat

**Status:** Implemented — `feat/workspace-chat` branch
**Author:** Friday + Eric
**Date:** 2026-02-10 (v2: 2026-02-26, v3: 2026-02-26)
**Supersedes:** `workspace-direct-chat.md`, `workspace-direct-chat.v2.md`, `2026-02-10-workspace-direct-chat-design.md`, `2026-02-10-workspace-direct-chat-design.v2.md`

> **Note for reviewers:** This document is the design reference for the workspace
> direct chat feature. All implementation tasks below are complete. Read this as
> the architectural rationale behind the code, not as a spec to execute.

## Problem Statement

Three customer problems drive this design:

1. **Slack channel scoping** — A customer wants to expose a data analytics workspace via a single Slack channel. Currently, Slack signals route to the global conversation agent, giving access to ALL workspaces. They need chat scoped to one workspace.

2. **Workspace rigidity** — Workspaces only do predefined jobs. A grocery list manager has jobs for "send weekly list" and "add item", but when asked "view my list", it's helpless — even though the data is right there. Users need the flexibility of `do_task`, but scoped to workspace data and capabilities.

3. **Direct workspace chat** — Users want to chat directly with a workspace from the web UI. The existing `chat-session` experience embedded in the space page (`/spaces/[spaceId]`), scoped to that workspace's agents and tools.

## Solution

A **new standalone agent** (`workspace-chat`) purpose-built for scoped workspace conversation, invoked through the standard signal pipeline. Every workspace automatically gets a `chat` signal and job — zero configuration required.

The workspace-chat agent can:

- **Execute ad-hoc tasks** using workspace-preferred agents and MCP servers (via augmented `do_task`)
- **Invoke workspace jobs** as first-class tools with typed inputs
- **Load skills** for extended capability
- **Prompt for OAuth** when bundled agents need credentials (via `connect_service`)

Three integration surfaces:
1. **API** — `POST /api/workspaces/:workspaceId/chat`
2. **Web UI** — chat-session embedded in `/spaces/[spaceId]/chat` (PR #2186)
3. **Slack** — channel-to-workspace routing via same `chat` signal (deferred)

## User Stories

1. As a workspace owner, I want to chat with my workspace so that I can perform ad-hoc queries against my workspace's data and tools
2. As a workspace owner, I want to invoke workspace jobs from chat so that I don't have to navigate to a separate trigger UI
3. As a workspace owner, I want the chat agent to understand my workspace's capabilities so that it can plan multi-step tasks using my configured agents and MCP servers
4. As a workspace owner, I want workspace chat isolated from other workspaces so that conversations and tool access don't leak across boundaries
5. As a Slack user, I want to chat with a specific workspace via a dedicated Slack channel so that my team can interact with workspace capabilities without accessing the global conversation (deferred)
6. As a web UI user, I want a "Chat" tab on my workspace page so that I can converse with the workspace without leaving the space context
7. As a workspace author, I want to define typed inputs for my jobs so that they can be exposed as clean tools in chat
8. As a workspace author, I want my workspace-defined agents to be preferred by the task planner so that domain-specific agents are used before generic system agents
9. As a user, I want workspace chat history separate from global chat so that conversations are organized by context
10. As a user, I want to resume workspace chat streams after disconnection so that I don't lose in-progress responses

## Implementation Decisions

### New Standalone Agent (Not Parameterized Existing)

The existing conversation agent is ~1100 lines handling 10+ concerns: MCP client lifecycle, system prompt assembly (7 optional sections), token budgeting, message windowing, tool filtering, stop condition orchestration, UI message stream plumbing, chat persistence, title generation, and `globalThis.addEventListener("unhandledrejection")` hacks for error interception.

Rather than adding `ConversationScope` branching to this agent, workspace chat gets a **new standalone agent** at `packages/system/agents/workspace-chat/`. This:

- Serves as a proving ground for a simpler agent pattern
- Avoids destabilizing global chat
- Provides a template for eventually rewriting the global conversation agent
- Keeps the workspace chat handler flat (~50 lines of actual logic)

Both agents use the `createAgent` abstraction from `@atlas/agent-sdk`. The existing conversation agent is untouched.

### Model Resilience via maxRetries

The workspace-chat agent uses `maxRetries: 3` on the `streamText` call — same approach as the existing conversation agent. No additional retry infrastructure for MVP.

```typescript
const result = streamText({
  model: registry.languageModel("anthropic:claude-sonnet-4-5"),
  messages: [...],
  tools: allTools,
  maxRetries: 3,
  // ...
});
```

The existing conversation agent's error interception patterns (`globalThis.addEventListener("unhandledrejection")`, `originalStreamError`, etc.) are **not carried forward**. The workspace-chat agent uses a single `try/catch` around `streamText`. If errors surface that `maxRetries` doesn't handle, we'll add targeted error handling then — not preemptively.

### Signal-Based Invocation (Standard Pipeline)

Workspace chat routes through the standard signal pipeline rather than bypassing it. This preserves multi-surface routing — the same `chat` signal can be sent from the web API, Slack, or any future integration surface.

#### Streaming Call Chain

The route uses `runtime.triggerSignalWithSession()` — the same method the conversation agent's chat route uses. The `onStreamEvent` callback is threaded through the entire pipeline:

```
HTTP POST /api/workspaces/:workspaceId/chat
  └─> runtime.triggerSignalWithSession("chat", payload, chatId, CALLBACK)
      └─> runtime.processSignal(signal, CALLBACK)
          └─> runtime.processSignalForJob(job, signal, CALLBACK)
              └─> job.engine.signal(signal, { onEvent, onStreamEvent: CALLBACK })
                  └─> runtime.executeAgent(action, context)
                      └─> orchestrator.executeAgent(agentId, { onStreamEvent: CALLBACK })
                          └─> MCP notification handler → CALLBACK(chunk)
                              └─> streamRegistry.appendEvent(chatId, chunk)
                              └─> streamWriter.write(`data: ${JSON.stringify(chunk)}\n\n`)
```

The workspace-chat agent emits chunks via `pipeUIMessageStream(uiStream, stream)` → `stream.emit(chunk)` → MCP notification → callback chain → SSE response. Identical to the conversation agent.

This gives us for free: duplicate session prevention, metrics, idle timeouts, workspace lifecycle management, session persistence, and **streaming via the established callback chain**.

The FSM overhead is near-zero for conversation — an auto-generated `idle → processing → idle` state machine from the job's `execution.agents` config. No FSM YAML file needed. Full pipeline overhead is accepted for MVP — measure actual latency before optimizing.

`do_task` inside the workspace-chat agent still exercises the full FSM pipeline for every workspace task, preserving dogfooding value.

### Auto-Injected Chat Signal

Every workspace automatically gets a `chat` signal and job at runtime load time. No workspace author configuration required. The runtime injects the equivalent of:

```yaml
signals:
  chat:
    description: "Direct chat with workspace"
    provider: system

jobs:
  handle-chat:
    triggers:
      - signal: chat
    execution:
      strategy: sequential
      agents:
        - id: workspace-chat
```

The `workspace-chat` agent is registered as a system agent (peer to `conversation`). Every workspace is chattable by default.

**Signal name `chat` is reserved.** If a workspace defines its own `chat` signal in `workspace.yml`, the runtime emits an error at load time. This prevents ambiguity — the system `chat` signal has a well-defined contract that the workspace-chat agent depends on.

### Scoped Tool Surface

Workspace chat gets a constrained tool set:

| Tool | Notes |
|------|-------|
| `do_task` (workspace-augmented) | Plans and executes with workspace agents preferred, all agents/MCP visible |
| `<job_name>` (flattened) | One tool per job with typed inputs from `inputs` schema |
| `load_skill` | Load workspace or system skills |
| `connect_service` | OAuth auth flow when bundled agents need credentials |

**Excluded from workspace chat (global-only):**
- Platform management tools (`workspace_list`, `workspace_create`, `workspace_update`, `workspace_delete`)
- `workspace_describe`, `session_describe`, `session_cancel`
- System agents (`workspace-planner`, `fsm-workspace-creator`)
- `connect_mcp_server`
- `library_list`, `library_get`
- All other platform inspection tools

**MCP tools are NOT directly exposed.** They're accessible only through `do_task`, which handles MCP pool lifecycle, credential validation, and structured execution. This keeps the tool surface at ~10-15 tools regardless of how many MCP servers a workspace configures.

**`connect_service` is included** because `do_task` can invoke bundled agents (calendar, email, etc.) that need OAuth credentials. The agent must be able to run the preflight check and prompt the user to authorize when necessary. The `hasToolCall("connect_service")` stop condition carries over — same frontend OAuth flow as global chat.

### Agent Priority in do_task (Preference, Not Restriction)

The workspace-chat agent's `do_task` sees the **full agent catalog and MCP server registry** — not a restricted subset. Workspace agents are *preferred*, not exclusively used. This preserves the full power of `do_task` while providing domain-aware planning.

The implementation uses a **thin wrapper** around the existing `createDoTaskTool`:

```typescript
// workspace-chat/tools/do-task.ts
export function createWorkspaceDoTask(
  workspaceConfig: WorkspaceConfig,
  writer: UIMessageStreamWriter,
  session: DoTaskSession,
  logger: Logger,
  abortSignal?: AbortSignal,
) {
  // Enrich planning context with workspace agents
  // before delegating to the standard do_task
  return createDoTaskTool(writer, session, logger, abortSignal, {
    workspaceAgents: workspaceConfig.agents,
    workspaceMCPServers: workspaceConfig.tools?.mcp?.servers,
  });
}
```

The existing `createDoTaskTool` gains an optional `workspaceContext` parameter. When provided, `generatePlan` prepends workspace agents to the planning prompt with a "prefer these domain-specific agents" annotation. Workspace MCP servers are added to the available server pool alongside system servers.

Priority tiers in the planner prompt:
```
1. Workspace agents (from workspace.yml) — preferred, know the domain
2. Bundled system agents — general purpose fallback
3. On-the-fly LLM agents — last resort, uses MCP tools
```

**All bundled agents and MCP servers remain visible.** The isolation boundary is the tool surface (no platform management tools), not the `do_task` planning scope.

### Job-as-Tool Invocation

Jobs with an `inputs` schema are flattened into first-class tools. Invocation uses `WorkspaceRuntime.executeJobDirectly(jobName, inputs)`.

Flow:
1. Workspace-chat agent calls tool (e.g., `add_item({ item: "milk", quantity: 2 })`)
2. Inputs validated against job's `inputs` JSON Schema via `convertJsonSchemaToZod`
3. `WorkspaceRuntime.executeJobDirectly(jobName, { payload: validatedInputs })` executes the job
4. Blocks until `session.waitForCompletion()`
5. Returns session result to workspace-chat agent

Jobs without an `inputs` schema get a generic `{ prompt: string }` input for free-text interpretation by the job's agents.

Schema addition to `JobSpecificationSchema`:

```yaml
jobs:
  add-item:
    description: "Add an item to the grocery list"
    inputs:
      type: object
      properties:
        item:
          type: string
          description: "The item to add"
        quantity:
          type: number
          default: 1
      required: [item]
```

### System Prompt

The workspace-chat agent has its own `prompt.txt` with Friday's core personality (tone, communication style) copied from the global conversation agent's prompt, plus workspace-specific framing. No shared prompt fragment yet — copypasta is fine for now, extract a shared core identity later when the seam is clear.

Dynamic context is assembled at handler start. The agent fetches workspace config from the daemon API using `session.workspaceId` — same pattern the conversation agent uses for its workspace context section.

Sections:

1. **Base prompt** with workspace identity ("you are operating within workspace X")
2. **Workspace capabilities** (agents, jobs, MCP servers — fetched from daemon API via workspaceId)
3. **Datetime context** (client timezone info)
4. **Integrations section** (Link credentials/providers — from `fetchLinkSummary`)
5. **User identity** (from `fetchUserIdentitySection`)

Three network calls at startup (`GET /api/workspaces/:workspaceId`, `fetchLinkSummary`, `fetchUserIdentitySection`). The workspace config call replaces `fetchWorkspaceContext` — it returns the same data but scoped to the single workspace.

Skills section appended if workspace has skills configured. Scratchpad context if relevant per-workspace.

### Agent Module Structure

```
packages/system/agents/workspace-chat/
  workspace-chat.agent.ts   # The agent (createAgent + maxRetries)
  prompt.txt                # System prompt (core identity + workspace scoping)
  tools/
    do-task.ts              # Thin wrapper: enriches planning context with workspace agents/MCP
    job-tools.ts            # Job-as-tool generator
```

The handler reads like a recipe:

```typescript
handler: async (_, { session, logger, tools, stream, abortSignal }) => {
  // 1. Load chat history from ChatStorage
  // 2. Fetch workspace config from daemon API
  // 3. Assemble scoped tools (do_task wrapper + job tools + load_skill + connect_service)
  // 4. Build system prompt (workspace identity + capabilities + integrations)
  // 5. streamText(maxRetries: 3) → createUIMessageStream → pipeUIMessageStream → persist
}
```

Each step is a function call, not inline logic. The `createUIMessageStream` / `pipeUIMessageStream` pattern stays (frontend contract), but the `execute` body is ~50 lines. Error handling is a single `try/catch` — `maxRetries` handles transient API errors, everything else surfaces as `data-error` UI event.

`experimental_repairToolCall` from `@atlas/agent-sdk` carries forward for malformed tool call JSON repair.

### Chat History & Storage

Same `ChatStorage` infrastructure with a **filename convention change** for workspace scoping.

**Naming convention:**
- Workspace chats: `{workspaceId}_{chatId}.json`
- Global chats: `{chatId}.json` (unchanged)

This enables `listChatsByWorkspace(workspaceId)` via glob pattern (`{workspaceId}_*.json`) without deserializing every file. No migration needed — existing global chat files keep their current naming. New workspace chats use the new convention.

`ChatStorage` changes:
- `createChat` writes to `{workspaceId}_{chatId}.json` when `workspaceId` is not `"friday-conversation"`
- `getChat` checks both naming conventions (workspace-prefixed first, then bare chatId)
- `listChatsByWorkspace(workspaceId)` globs `{workspaceId}_*.json`
- `listChats` (global) globs files without underscore prefix (or filters out workspace-prefixed files)

Workspace chat history is isolated: workspace A cannot see workspace B's chats. Global chat cannot see workspace chats and vice versa.

### Frontend Integration

**Existing PR #2186** adds the workspace chat route at `/spaces/[spaceId]/chat/[[chatId]]` with workspace-scoped breadcrumbs. This PR reuses the existing `ChatSession` component and handles both new chat (generated ID) and existing chat (loads messages + artifacts).

The remaining frontend work for workspace direct chat:

- **Transport URL switch:** `ChatSession` needs to route to `/api/workspaces/${workspaceId}/chat` instead of `/api/chat` when in workspace context. This may already be handled by PR #2186 or require a small addition.
- **Chat history in sidebar:** Workspace chats should appear in the sidebar when viewing a workspace, separate from global chat history.

### Auth

Uses existing app-level auth middleware — same access rules as other workspace endpoints. No new auth design needed for MVP. Fine-grained workspace permissions (who can chat with which workspace) deferred.

### Error Handling

- **API errors (429, 529):** Handled by `maxRetries: 3` on `streamText`. After exhaustion, error surfaced as `data-error` UI event.
- **MCP server initialization failures:** Degrade gracefully, surface unavailable tools in error response
- **MCP server crashes mid-session:** Return tool error to workspace-chat agent, allow retry
- **Missing credentials (OAuth not connected):** `connect_service` tool prompts user, `do_task` planner validates credentials before execution
- **User cancellation:** `AbortSignal` propagated from HTTP request through signal pipeline to agent execution
- **Workspace not found:** 404 at the route level before signal dispatch

### Interaction with Session Streaming

The session streaming feature (PR in progress) adds live progress visibility for workspace jobs. Workspace direct chat interacts cleanly:

- Job tool invocations (`executeJobDirectly`) produce sessions that emit events
- When session streaming lands, these events can be forwarded to the chat SSE stream for live progress
- The `onStreamEvent` callback pattern from `processSignalForJob` is preserved within `executeJobDirectly`
- `do_task` executions also produce sessions — same streaming integration applies

For MVP, job tools block until completion. Session streaming provides the future path to live progress during execution.

## Testing Decisions

Tests should verify external behavior, not implementation details. Focus on the isolation boundary.

**Required coverage:**

- **Workspace chat signal routing:** Auto-injected `chat` signal dispatches to workspace-chat agent. Signal arrives through `triggerWorkspaceSignal`, not a custom path.
- **Reserved signal name:** Workspace defining its own `chat` signal produces a load-time error.
- **Tool scoping:** Workspace chat agent cannot access platform management tools. `connect_service` is available for OAuth flows.
- **do_task workspace preference:** Workspace agents appear with priority annotation in planner prompt. All bundled agents and MCP servers remain visible.
- **Job-to-tool transformation:** Various `inputs` schemas produce correct tool definitions. Jobs without inputs get generic `{ prompt }` parameter.
- **Job invocation:** `executeJobDirectly` called with validated inputs wrapped as payload, results returned to agent
- **Chat history isolation:** Workspace A chats not visible via workspace B's endpoint. Global chat list excludes workspace chats. Filename convention enforces separation.
- **Chat filename convention:** Workspace chats stored as `{workspaceId}_{chatId}.json`. `getChat` resolves both conventions. `listChatsByWorkspace` uses glob.
- **Retry behavior:** `maxRetries: 3` retries transient errors. Exhausted retries surface as `data-error` UI event.
- **Error handling:** MCP failures degrade gracefully, missing workspace returns 404, abort signal cancels execution

**Prior art:** Existing tests in `packages/system/agents/conversation/` for the global conversation agent. Route tests in `apps/atlasd/routes/` for endpoint patterns.

## Out of Scope

| Item | Notes |
|------|-------|
| Slack channel routing | Deferred. Signal infrastructure supports it — needs workspace signal claiming + conflict resolution strategy. |
| `@workspace` from global chat | Future escape hatch to temporarily scope global conversation to a workspace. |
| Fine-grained permissions | Who can chat with which workspace? Deferred beyond existing app auth. |
| Memory integration | Chat should share workspace memory (CoALA) when built. |
| Resources | Deferred to resources PR (#1552). `read_resource` tool added when that lands. |
| Custom workspace system prompts | YAGNI. Friday's tone stays consistent across workspaces. |
| Rate limiting | Same limits as global chat for MVP. |
| `call_agent` tool | Dropped. `do_task` handles agent invocation with planning benefits. |
| `do_task` fast path | Single-step plans still go through full FSM generation. Optimizing later — pressure testing the FSM engine is more valuable now. |
| Multi-provider fallback | Can be added later when single-provider retry proves insufficient. |
| Shared prompt fragment | Core identity copypasta for now. Extract shared fragment when both agents stabilize. |
| Chat startup latency optimization | Full signal pipeline per message accepted for MVP. Measure before optimizing. |
| ai-retry integration | Requires AI SDK v6 (project on v5). Revisit when SDK is upgraded. |

## Implementation Tasks

### Phase 1: Schema + Agent Foundation

1. **Add `inputs` to `JobSpecificationSchema`** — `packages/config/src/jobs.ts`
   - Optional `inputs` field (JSON Schema object)
   - Validation via existing `convertJsonSchemaToZod` pattern

2. **Create `workspace-chat.agent.ts`** — `packages/system/agents/workspace-chat/`
   - `createAgent` with `maxRetries: 3` on `streamText`
   - Fetch workspace config from daemon API at handler start (`GET /api/workspaces/:workspaceId`)
   - Scoped system prompt (core identity + workspace context)
   - Scoped tool assembly (workspace do_task wrapper, job tools, load_skill, connect_service)
   - `experimental_repairToolCall` for JSON repair
   - `createUIMessageStream` / `pipeUIMessageStream` for streaming + persistence

3. **Add `workspaceContext` option to `createDoTaskTool`** — `do-task/index.ts`
   - Optional `workspaceContext` parameter with workspace agents and MCP server configs
   - When provided, `generatePlan` prompt includes workspace agents with preference annotation
   - Workspace MCP servers added to available pool alongside system servers
   - No filtering — augmentation only

4. **Build workspace do_task wrapper** — `packages/system/agents/workspace-chat/tools/do-task.ts`
   - Thin wrapper that enriches planning context with workspace config
   - Delegates to standard `createDoTaskTool` with `workspaceContext`

5. **Build job-as-tool generator** — `packages/system/agents/workspace-chat/tools/job-tools.ts`
   - Takes workspace jobs + `inputs` schemas → tool definitions
   - Invocation via `WorkspaceRuntime.executeJobDirectly(jobName, { payload: inputs })`
   - Blocks until completion, returns session result

### Phase 2: Signal Integration

6. **Auto-inject `chat` signal + job into workspace runtime** — `src/core/workspace-runtime.ts`
   - Inject at load time, before job initialization
   - `chat` signal with `provider: system`
   - `handle-chat` job with `execution.agents: [workspace-chat]`
   - **Error if workspace defines its own `chat` signal** — reserved name

7. **Register `workspace-chat` as a system agent** — `packages/core/src/agent-loader/adapters/system-adapter.ts`
   - Import and register in `registerSystemAgents()` alongside `conversationAgent`
   - Available via agent server for FSM execution

### Phase 3: Route + Chat Storage

8. **Update `ChatStorage` filename convention** — `packages/core/src/chat/storage.ts`
   - Workspace chats: `{workspaceId}_{chatId}.json`
   - Global chats: `{chatId}.json` (unchanged, no migration)
   - `createChat` routes to correct filename based on workspaceId
   - `getChat` resolves both conventions
   - Add `listChatsByWorkspace(workspaceId)` using glob on `{workspaceId}_*.json`
   - `listChats` (global) excludes workspace-prefixed files

9. **Create workspace chat route** — `apps/atlasd/routes/workspaces/chat.ts`
   - `POST /api/workspaces/:workspaceId/chat` — persist user message, call `runtime.triggerSignalWithSession("chat", payload, chatId, onStreamEvent)`, SSE response
   - `GET /api/workspaces/:workspaceId/chat` — list chats via `listChatsByWorkspace`
   - `GET /api/workspaces/:workspaceId/chat/:chatId` — get chat
   - `GET /api/workspaces/:workspaceId/chat/:chatId/stream` — resume SSE via `StreamRegistry`
   - Uses existing app-level auth middleware

### Phase 4: Frontend

10. **Integrate with PR #2186** — workspace chat route at `/spaces/[spaceId]/chat/[[chatId]]`
    - Verify transport URL switches to workspace chat API
    - Add workspace chat history to sidebar navigation

## Further Notes

- The `friday-conversation` system workspace continues operating exactly as-is. This design is purely additive.
- `executeJobDirectly` already exists on `WorkspaceRuntime` — takes `(jobName, { payload?, streamId? })`.
- When resources PR (#1552) merges, add `read_resource` tool to workspace chat tool set and inject resource summaries into the scoped system prompt.
- The `do_task` workspace context mechanism benefits global chat too — it can be used for future `@workspace` mentions that temporarily scope the global conversation.
- The workspace-chat agent pattern (flat handler, scoped tools) is intended as a template for eventually simplifying the global conversation agent.
- The streaming call chain (`triggerSignalWithSession` → `processSignalForJob` → FSM engine → orchestrator → MCP notification → callback) is identical to the conversation agent's path. No new streaming infrastructure needed.
