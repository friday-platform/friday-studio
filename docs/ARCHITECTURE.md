# Atlas Architecture

This document describes the high-level architecture of Atlas. Use it to orient
yourself in the codebase and understand how components connect.

See also: CLAUDE.md for commands and conventions.

## Bird's Eye View

Atlas is an AI agent orchestration platform. Workspaces define agents and jobs;
signals trigger job execution; agents run with MCP tool access.

```
┌─────────────────────────────────────────────────────────────────┐
│                         Daemon (atlasd)                         │
│  HTTP API · SSE Streaming · Workspace Lifecycle · Cron Manager  │
└─────────────────────────────────────────────────────────────────┘
                              │
                    ┌─────────┴─────────┐
                    ▼                   ▼
           ┌──────────────┐    ┌──────────────┐
           │  Workspace   │    │  Workspace   │  (lazy-loaded on signal)
           │   Runtime    │    │   Runtime    │
           └──────────────┘    └──────────────┘
                    │
        ┌───────────┴───────────┐
        ▼                       ▼
┌───────────────┐      ┌───────────────┐
│    Session    │      │    Session    │  (1 signal = 1 session)
│  Supervisor   │      │  Supervisor   │
└───────────────┘      └───────────────┘
        │
        ▼
┌───────────────────────────────────────┐
│           Agent Orchestrator          │
│   (routes to LLM or bundled agents)   │
└───────────────────────────────────────┘
        │
   ┌────┴────┐
   ▼         ▼
┌──────┐  ┌──────────────┐
│ LLM  │  │   Bundled    │
│Agent │  │ Agent (MCP)  │
└──────┘  └──────────────┘
             │
             ▼
      ┌───────────────┐
      │  MCP Servers  │
      └───────────────┘
```

## Data Flow

1. Signal arrives (HTTP request, cron tick, file change)
2. Daemon routes to workspace runtime, creating it if needed (lazy)
3. Runtime spawns a session supervisor for this signal
4. Supervisor extracts execution plan from job definition in workspace.yml
5. Supervisor executes agents in phases (sequential or parallel per plan)
6. For each agent, orchestrator routes to either:
   - In-memory LLM agent (config-defined in workspace.yml)
   - Bundled/system agent (served via MCP from agent server)
7. Agents invoke LLM with MCP tools available
8. Hallucination detector validates LLM agent output (confidence scoring)
9. SSE events emitted throughout; session completes

## Code Map

### apps/atlasd - The Daemon

Entry point for all Atlas operations. Owns HTTP API, workspace lifecycle, and
resource pools.

Key files:
- `src/atlas-daemon.ts` - AtlasDaemon class, initialization sequence, shutdown
- `src/factory.ts` - Hono app setup, route mounting, middleware
- `src/routes/` - HTTP handlers organized by resource

Responsibilities:
- HTTP REST API on configurable port (default 8080)
- SSE client management with heartbeats and cleanup
- Workspace runtime creation/destruction with idle timeouts
- Shared resource pools (MCP servers, library storage, embedding provider)
- Signal registrars for cron and file-watch triggers

Invariant: Workspace runtimes are lazy. Created on first signal, destroyed after
idle timeout (default 5 min). Max 10 concurrent workspaces with LRU eviction.

### StreamRegistry (Stream Resumption)

StreamRegistry enables chat stream resumption after page refresh or navigation. It's a daemon-level service that buffers events for active chat streams.

**Key Behavior:**
- Events buffered in memory (max 1000 per stream)
- Client reconnect replays buffered events + continues live
- Finished streams kept 5 min (for late reconnect)
- Stale streams cleaned after 30 min
- NOT persisted across daemon restarts

**Endpoints:**
- `POST /api/chat` - Creates stream, buffers all events
- `GET /api/chat/:chatId/stream` - Reconnect (200 with SSE or 204 if inactive)
- `DELETE /api/chat/:chatId/stream` - Mark finished (cosmetic stop)

**Client Pattern:**
- Chat instances are page-local (not shared via context)
- `chat.resumeStream()` called on mount for existing chats
- URL updates via replaceState after first message
- Stop is cosmetic - agent continues server-side

**Location:** `apps/atlasd/src/stream-registry.ts`

### src/core - Workspace Runtime & Session Supervision

XState 5 state machine managing workspace lifecycle and session spawning.

Key files:
- `workspace-runtime-machine.ts` - State machine definition, signal processing
- `workspace-runtime.ts` - Public API wrapper around the machine
- `session.ts` - Session wrapper, lifecycle callbacks
- `actors/session-supervisor-actor.ts` - Execution planning, agent orchestration,
  hallucination detection, validation retry logic

States: uninitialized → initializing → initializingStreams → ready → shuttingDown → terminated

The ready state processes PROCESS_SIGNAL events by spawning child actors.
Each signal creates exactly one session. Sessions own their execution promise.

Session Supervisor responsibilities:
- Extracts execution plan from job definition (workspace.yml)
- Executes agents in sequential or parallel phases
- Runs hallucination detection on LLM agent outputs
- Retries once on validation failure, terminates on repeated failure
- Emits SSE events (session-start, agent-start, agent-finish, session-finish)

Invariant: Sessions are never reused. Signal arrives, session created, session
completes or fails, session discarded.

### packages/core - Agent Orchestration & Execution

Agent orchestrator, LLM providers, MCP server pool, agent server.

Key files:
- `src/orchestrator/agent-orchestrator.ts` - Routes execution to agent types
- `src/mcp-server-pool.ts` - Connection pooling with reference counting
- `src/agent-server/` - MCP server hosting bundled agents
- `src/llm/` - Provider abstractions (Anthropic, Google, OpenAI)
- `src/streaming/` - Callback, HTTP, MCP stream emitters

Agent Orchestrator routes between two agent types:
1. LLM agents: In-memory execution, config defined in workspace.yml, validated
   by hallucination detector
2. Bundled/system agents: Served via MCP from agent server, pre-validated by
   evaluation tests (skip hallucination detection)

MCP Server Pool: Reference-counted connection pooling. Keyed by server config
combination. 5-minute cleanup timer when refCount hits zero. Registration
failures logged but don't fail the pool (continues with other servers).

Invariant: MCP failures fast-fail to agents. No reconnection logic or circuit
breakers.

### src/core/services - Hallucination Detection

Validates LLM agent outputs using source attribution rules.

Key files:
- `services/hallucination-detector.ts` - LLM-based validation with retry logic

Detection method: Sends agent output to Claude Haiku for source attribution
compliance checking. Validates that claims are properly tagged with [tool:X],
[input], [inference:input], [generated], or [undefined].

Thresholds and behavior:
- Confidence < 0.3 OR severe patterns detected → validation fails
- On first failure: single retry with validation feedback injected into prompt
- On second failure: session terminates with hallucination error
- Severe patterns: fabricated claims, tool tags without matching tool calls,
  external data claims without tool evidence

Supervision levels (from job config):
- minimal: threshold 0.3
- standard: threshold 0.5
- paranoid (detailed): threshold 0.7

### packages/config - Configuration & Validation

Zod schemas for all configuration. YAML files (atlas.yml, workspace.yml) parsed
and validated here. See `docs/COMPREHENSIVE_ATLAS_EXAMPLE.yml` for all available options.

Key files:
- `mod.ts` - Main exports
- `src/schemas/` - Zod schema definitions per entity type
- `src/config-loader.ts` - YAML loading and merging

Invariant: All external input must pass through Zod schemas. No `any`, no `as`
assertions on config data.

### packages/mcp - MCP Client

Model Context Protocol client using Vercel AI SDK.

Key files:
- `src/manager.ts` - MCPManager, server lifecycle, tool invocation
- `src/registry.ts` - Configuration resolution (platform → workspace → agent)

Supports stdio and HTTP transports. Shared server pool across workspaces.

### packages/mcp-server - Platform & Workspace MCP Servers

MCP servers that expose Atlas capabilities to external clients.

Key files:
- `src/platform-server.ts` - Daemon-wide MCP server on /mcp endpoint
- `src/workspace-server.ts` - Per-workspace MCP with security controls
- `src/tools/` - Tool implementations (fs, library, workspace ops)
- `src/resources/` - Static resources (workspace config reference)

Two servers with different scopes:
1. Platform MCP Server: Exposes workspace management, job execution, library
   operations. Mounted at /mcp on daemon.
2. Workspace MCP Server: Exposes only discoverable jobs with rate limiting.
   Security controls: capability filtering, requests/hour limits, concurrent
   session limits, job access control.

Tool naming: `atlas_*` prefix, snake_case, action-oriented (atlas_list,
atlas_workspace_create). All tools use Zod v4 input schemas.

### packages/storage - Persistence

Storage adapters for various backends.

Key files:
- `src/adapters/filesystem-config.ts` - YAML config loading

Invariant: FileWriteCoordinator prevents concurrent write corruption.

### packages/signals - Signal Providers

Signal sources and routing.

Key files:
- `src/providers/` - HTTP, cron, file-watch providers
- `src/registry.ts` - Dynamic provider registration

Note: Stream signals (k8s-events) exist in initializingStreams state but are
not fully implemented. Likely intended for accepting HTTP streams rather than
unary webhook requests.

### packages/logger - Structured Logging

Dual-format logger: JSON for files, pretty-printed for TTY.

Invariant: Use `@atlas/logger`, never `console.*`.

### apps/web-client - Svelte UI

Browser-based workspace management and session monitoring. Consumes daemon HTTP
API and SSE streams. Not architecturally central; daemon is the source of truth.

### Other Packages (Utilities)

These exist but are not architecturally significant:
- `@atlas/client` - TypeScript client for daemon API
- `@atlas/cron` - Cron expression parsing (wraps cron-parser)
- `@atlas/fs-watch` - File watching abstraction
- `@atlas/utils` - Shared utilities
- `@atlas/diagnostics` - Health checks and debugging
- `@atlas/notifications` - Alert delivery (webhooks, etc.)
- `@atlas/workspace` - Workspace type definitions

## Cross-Cutting Concerns

Actor Model: The runtime is built on actors, not threads. XState machines spawn
child actors for signal processing. SessionSupervisorActor owns execution.
Actors communicate via events and promises, not shared state.

Lazy Loading: Expensive resources load on-demand. Workspace runtimes on first
signal. MCP servers on first tool call. Embedding provider pre-warmed but
non-blocking.

Configuration Merge: Platform config (atlas.yml) merges with workspace config
(workspace.yml). Workspace overrides platform. Zod validates at every boundary.

Observability: All components emit structured logs. Trace headers propagate
through signal → session → agent. SSE streams carry agent-start, agent-result,
session-finish events.

Idle Management: Every workspace has an idle timeout. Signal triggers reset it.
On timeout, check for active sessions before destroying. Agent sessions also
have LRU eviction (max 100).

## Architectural Invariants

1. Signals are immutable. Once a signal arrives, its payload never changes.

2. Sessions are ephemeral. No session state persists beyond completion.
   Memory consolidation runs but sessions themselves are discarded.

3. LLM agents are validated. Bundled agents are not (pre-validated by evals).

4. MCP servers are pooled with reference counting. Failures fast-fail.

5. Config hot-reload destroys runtime. No incremental config updates.
   Change config → destroy runtime → recreate on next signal.

6. Execution plans come from job definitions in workspace.yml. LLM-generated
   planning exists but is not used (workspace generation handles planning).
