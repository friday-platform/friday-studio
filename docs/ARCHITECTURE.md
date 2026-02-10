# Architecture

This document describes the high-level architecture of Friday. It's a map, not
a manual — if you want to understand where things are and why they're shaped the
way they are, read this first. For how to work with the code, see
[`CLAUDE.md`](../CLAUDE.md).

Maintained for both human contributors and AI agents learning the codebase.
Updated a few times per year — details change, but the pipeline doesn't.

## Bird's Eye View

Friday is an AI agent orchestration platform. You give it a workspace definition
(agents, signals, workflows) and it runs autonomous agents in response to
triggers.

The mental model is a pipeline:

```
Signal (HTTP, cron, Slack, …)
  → Daemon routes to workspace
    → Workspace spawns session
      → FSM engine executes workflow
        → Agents run with MCP tool access
          → Results stream back via SSE
```

The core abstraction is the **workspace**. A workspace is a `workspace.yml` that
declares what agents exist, what signals they respond to, and what tools they can
access. The daemon manages workspace lifecycles — creating runtimes on demand
when signals arrive, destroying them after idle timeout.

Everything is lazy. No workspace runtime exists until a signal needs it. No MCP
connection opens until an agent needs a tool. This keeps the daemon lightweight
even with many registered workspaces.

## Entry Points

Where to start reading depends on what you're doing:

- **Understanding the daemon**: Start at `AtlasDaemon` in
  `apps/atlasd/src/atlas-daemon.ts`. This is the process entry point — it boots
  the HTTP server, workspace manager, and signal registrars.
- **Understanding workflows**: Read `packages/fsm-engine/fsm-engine.ts`. FSM
  definitions are YAML files (`.fsm.yaml`) that declare states, transitions, and
  actions.
- **Understanding agent execution**:
  `packages/core/src/orchestrator/agent-orchestrator.ts` is where agents get
  dispatched — either via MCP (distributed) or as wrapped LLM calls (in-process).
- **Understanding config**: `packages/config/src/workspace.ts` has the Zod
  schemas for `workspace.yml`. This is the contract.
- **Working on the web client**: `apps/web-client/` is a SvelteKit 2 app. Routes
  are file-based under `src/routes/`.
- **Working on Go services**: Each lives in its own `apps/` subdirectory with
  standard Go project layout.

## Directory Overview

```
apps/
  atlasd/              Daemon — HTTP API, workspace lifecycle
  web-client/          Svelte web UI (primary deployment target)
  bounce/              Auth service (Go)
  gist/                File service (Go)
  atlas-operator/      K8s operator for multi-tenant deployment (Go)
  signal-gateway/      External signal ingestion — Slack, Discord (Go)
  gateway/             API gateway (Go)
  cortex/              Storage backend service (Go)
  atlas-auth-ui/       Auth flow UI (Svelte)

packages/
  @atlas/config        YAML config loading + Zod schemas
  @atlas/core          Core types, agent registry, orchestration
  @atlas/fsm-engine    FSM execution engine (YAML → state machines)
  @atlas/mcp           MCP client management
  @atlas/signals       Signal types and routing
  @atlas/storage       Persistence layer
  @atlas/workspace     Workspace lifecycle management
  @atlas/agent-sdk     SDK for building agents
  @atlas/llm           LLM provider abstraction
  @atlas/logger        Structured logging
  …and ~18 more

src/                   atlasd daemon internals (not a separate app)
  core/                Workspace runtime, FSM events, agent helpers
  cli/                 CLI commands (prompt, chat, daemon, workspace)
  services/            Daemon background services
```

The `apps/` directory contains deployable services. The `packages/` directory
contains internal TypeScript packages used across apps. `src/` is special — it
contains the daemon's internal implementation, colocated at the repo root because
`atlasd` is the primary application.

## The Pipeline

This section walks through the system as a signal travels through it, from
ingestion to response.

### Signals

A signal is an external event that triggers agent execution. Friday supports
several signal providers:

- **HTTP** — REST endpoints defined in `workspace.yml`. The daemon registers
  routes on startup.
- **Cron** — Scheduled triggers managed by `CronManager`.
- **File system** — Watches managed by `FsWatchSignalRegistrar`.
- **Slack / Discord** — External events routed through the `signal-gateway` Go
  service.
- **System** — Internal platform signals (health checks, lifecycle events).

Signal definitions live in `packages/signals/`. Each provider implements a
standard interface for registration and teardown.

**Architecture Invariant**: Signals are the only way to trigger agent execution.
There is no "run agent directly" path — everything flows through the signal →
workspace → session pipeline. This ensures consistent logging, streaming, and
lifecycle management.

### Daemon Routing

When a signal arrives, the daemon resolves which workspace should handle it and
ensures a runtime exists.

The daemon (`AtlasDaemon` in `apps/atlasd/`) bootstraps these components on
startup:

- **Hono HTTP server** — Routes for signals, chat, workspace management
  (default port 8080).
- **WorkspaceManager** — Registry of known workspaces, creates runtimes on
  demand.
- **GlobalMCPServerPool** — Shared MCP server connections, pooled across
  workspaces.
- **CronManager** — Registers and fires cron-based signals.
- **StreamRegistry** — Tracks active SSE connections for real-time updates.
- **AgentRegistry** — Discovers bundled system agents and workspace-defined
  agents.

Signal routing: HTTP request hits the daemon's signal route
(`apps/atlasd/routes/signals/`) → daemon calls
`triggerWorkspaceSignal(workspaceId, signalId, payload)` → workspace manager
finds or creates a runtime.

**Architecture Invariant**: The daemon itself is stateless. Workspace state lives
in storage adapters (see Cross-Cutting Concerns). The daemon can restart without
losing workspace definitions — it re-discovers them from storage on boot.

### Workspace Runtime

The workspace runtime (`src/core/workspace-runtime.ts`) is the execution
environment for a single workspace. It manages:

- **FSM engines** — One per workflow defined in the workspace.
- **Active sessions** — Concurrent signal executions, each isolated.
- **Session lifecycle** — Pending → executing → completed/failed.
- **SSE event emission** — Forwards FSM events to connected clients.

When a signal arrives, the runtime creates a new session and hands it to the
appropriate FSM engine.

**Architecture Invariant**: Workspace runtimes are created lazily on first signal
and destroyed after an idle timeout (default 5 minutes with no active sessions).
This means the system's memory footprint scales with active workspaces, not
registered workspaces.

### FSM Engine

The FSM engine (`packages/fsm-engine/`) is where business logic lives. Workflows
are finite state machines defined in YAML, not code.

A `.fsm.yaml` file declares:

- **States** — Named states with entry actions and event handlers.
- **Transitions** — Events that move between states, with optional guard
  conditions.
- **Actions** — Work performed on entry or transition.
- **Document types** — Typed JSON schemas for data passed between states.

Action types:

- `agent` — Dispatch an agent via the orchestrator.
- `code` — Execute a TypeScript function.
- `emit` — Fire an event to trigger a transition.
- `document` — Read/write the session's document store.
- `llm` — Direct LLM call (deprecated — use `agent`).

The document store is the FSM's working memory. Each session gets an isolated
store where states can write typed JSON documents. Downstream states read these
documents — this is how data flows through a workflow without passing it as
function arguments.

**Architecture Invariant**: FSM definitions are declarative. The YAML is parsed
and validated by Zod schemas (`packages/fsm-engine/schema.ts`) at load time.
If a workflow definition is invalid, it fails fast before any execution begins.

**Boundary**: The FSM engine knows nothing about HTTP, SSE, or the daemon. It
receives events and produces actions. The workspace runtime is the adapter
between the daemon's HTTP world and the FSM's event-driven world.

### Agent Orchestrator

The agent orchestrator (`packages/core/src/orchestrator/agent-orchestrator.ts`)
dispatches agent execution. There are two paths:

**MCP Agents (distributed)**: The orchestrator calls an MCP server that hosts
the agent. The agent runs in an isolated session with its own MCP transport.
Results stream back via SSE. This is the standard path for complex agents that
need tool access.

```
FSM action (type: agent)
  → AgentOrchestrator
    → atlas-agents MCP server (StreamableHTTP)
      → Agent executes with tool access
        → SSE stream back to orchestrator
```

**Wrapped Agents (in-process)**: Lightweight LLM agents defined directly in
`workspace.yml`. These bypass MCP overhead — the orchestrator makes a direct LLM
call with tool schemas injected. Good for simple agents that don't need
isolation.

```
FSM action (type: agent)
  → AgentOrchestrator
    → Direct LLM call with MCP tool schemas
      → Synchronous result
```

The agent registry (`packages/core/src/agent-loader/`) discovers agents from
two sources: bundled system agents (in `packages/bundled-agents/`) and
workspace-level agents (from `workspace.yml`).

**Boundary**: The orchestrator is the boundary between "what to execute" (FSM)
and "how to execute" (LLM providers, MCP servers). Nothing above this layer
knows about specific LLM providers or MCP transport details.

### MCP Tools

Agents access external capabilities through the Model Context Protocol. MCP is
Friday's standard integration pattern — file systems, APIs, databases, and
custom tools all surface as MCP servers.

The `GlobalMCPServerPool` (`packages/core/src/mcp-server-pool.ts`) manages
shared MCP server connections across workspaces:

- Lazy initialization — connections open when first requested.
- Connection pooling — multiple agents can share a server.
- Lifecycle management — cleanup on workspace teardown.

Tool access is configured per-workspace in `workspace.yml` under `tools.mcp`.
Each MCP server declaration specifies transport (stdio, SSE, or StreamableHTTP),
allowed tools, and environment.

Friday also exposes its own platform capabilities as MCP servers:

- **Platform MCP server** (`packages/mcp-server/`) — Workspace operations
  (create conversations, list sessions) available as tools.
- **Atlas agents MCP server** (`packages/core/src/agent-server/`) — Bundled
  agents available as callable tools, with per-session isolation.

**Architecture Invariant**: MCP is the only way agents access external tools.
There is no "call this API directly" escape hatch. This ensures tool access is
auditable, configurable per-workspace, and consistently sandboxed.

### SSE Response

Results flow back to clients via Server-Sent Events. The `StreamRegistry`
(`apps/atlasd/`) tracks active SSE connections, and the workspace runtime
forwards events as they occur:

- FSM state transitions
- Agent execution progress
- Tool call results
- Final outputs

The web client connects via SSE and renders updates in real-time. The CLI polls
for completion. Both consume the same event stream — the transport differs, but
the data is identical.

## Cross-Cutting Concerns

### Configuration

`workspace.yml` is the primary configuration surface. It's where workspaces
declare their agents, signals, tools, and workflow behavior. The Zod schemas in
`packages/config/src/workspace.ts` define the contract — if it parses, it's
valid.

An `atlas.yml` exists for platform-wide settings but is rarely used in practice.
When both files exist, they merge with workspace values taking precedence
(`MergedConfig`).

**Architecture Invariant**: All external configuration is validated through Zod
schemas at load time. The system trusts types internally — validation happens at
the boundary, not throughout.

### Storage Adapters

Storage follows an adapter pattern. The interface is consistent; the backend
varies by environment:

- **Local development** — Flat files on disk. Simple, inspectable, no
  dependencies.
- **Remote / production** — Cortex (Go service) or PostgreSQL, accessed through
  the same adapter interface.

You can see this pattern in `apps/link/src/providers/storage/` — an `adapter.ts`
interface with `local-adapter.ts` and `cortex-adapter.ts` implementations. This
pattern is being made consistent across all services.

Current storage concerns:

- **Workspace registry** — Metadata about known workspaces (path, status,
  timestamps).
- **Session history** — Timeline events for completed sessions.
- **Library / artifacts** — Files produced by agent execution, organized by date.

**Architecture Invariant**: Storage adapters are the boundary between business
logic and persistence. No service directly reads or writes to a specific
backend — it goes through the adapter interface.

### Deno → Bun Migration

Friday is gradually migrating from Deno to Bun as its TypeScript runtime. The
migration is incremental:

- **What's changed**: Dependencies go in `package.json`, not `deno.json`. Use
  `process.env` from `node:process`, not `Deno.env`. Static imports only.
- **What's stable**: The package structure, the pipeline architecture, the
  YAML-based config, and the MCP integration pattern are all runtime-agnostic.
- **What to watch for**: Deno-specific APIs (`Deno.KV`, `Deno.env`,
  `Deno.readFile`) are being replaced with Node-compatible equivalents. When
  working in a module, prefer Node/standard APIs over Deno APIs.

The migration doesn't affect the architecture — it's a runtime swap, not a
redesign.

### Deployment

Friday deploys primarily as a **web application**. The daemon (`atlasd`) runs as
a service, the web client (`web-client`) serves the UI, and Go services handle
auth, storage, and signal ingestion.

- **Multi-tenant**: The `atlas-operator` (Go, K8s operator) watches for user
  additions and creates per-user ArgoCD Applications. Each user gets an isolated
  deployment.
- **Local development**: The daemon runs on `localhost:8080` with file-based
  storage. No K8s required.
- **Tauri / native builds**: A desktop app exists via Tauri integration in the
  web client. This is legacy and not the primary deployment target.

## Go Services

Friday's Go services handle concerns that benefit from Go's deployment model
(single binary, low memory, strong concurrency):

- **bounce** (`apps/bounce/`) — Authentication service. OAuth provider
  integration (Google, GitHub), JWT token generation and validation, user session
  management.
- **gist** (`apps/gist/`) — File service. Upload/download, presigned URL
  generation for S3/GCS, artifact storage.
- **atlas-operator** (`apps/atlas-operator/`) — Kubernetes operator. Watches
  PostgreSQL for user changes, creates/destroys ArgoCD Applications per user.
  Supports multi-organization tenancy.
- **signal-gateway** (`apps/signal-gateway/`) — External signal ingestion.
  Receives events from Slack, Discord, and other platforms, routes them to the
  appropriate workspace via the daemon API.
- **gateway** (`apps/gateway/`) — API gateway. Request routing and middleware.
- **cortex** (`apps/cortex/`) — Storage backend service. Provides the remote
  storage adapter that production deployments use instead of local flat files.

These services share common Go packages under `pkg/` for TLS, metrics,
analytics, and profiling.

**Architecture Invariant**: Go services communicate with the daemon over HTTP.
They don't import TypeScript packages or share code with the TS side — the HTTP
API is the boundary.
