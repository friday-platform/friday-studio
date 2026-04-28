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
- **Working on the web client**: `tools/agent-playground/` is a SvelteKit 2 app
  (package `@atlas/agent-playground`). Routes are file-based under `src/routes/`.
- **Working on Go services**: Go binaries live under `tools/` (e.g.
  `tools/webhook-tunnel/`, `tools/pty-server/`, `tools/friday-launcher/`).
  There is a single root `go.mod`.

## Directory Overview

```
apps/
  atlas-cli/           CLI — HTTP client to daemon
  atlasd/              Daemon — HTTP API, workspace lifecycle
  ledger/              Workspace-scoped versioned resource storage (SQLite, port 3200)
  link/                Credential management and OAuth orchestration
  studio-installer/    Tauri-based desktop installer

packages/                                       (TypeScript, all @atlas/*)
  config            YAML config loading + Zod schemas
  core              Core types, agent registry, orchestration, agent server
  fsm-engine        FSM execution engine (YAML → state machines)
  mcp               Ephemeral MCP client (no pooling)
  mcp-server        Platform MCP server exposing workspace operations
  signals           Signal types, providers (HTTP, file-watch), registry
  cron              Cron signal manager
  fs-watch          File-system watcher backing fs-watch signals
  document-store    FSM working memory (typed JSON documents per session)
  workspace         Workspace runtime, lifecycle management, registry
  workspace-builder Tooling for assembling workspaces
  bundled-agents    First-party system agents shipped with the daemon
  agent-sdk         SDK for building agents (leaf, no @atlas/* deps)
  sdk-ts            Public TypeScript SDK
  client            Type-safe Hono RPC client for the daemon API
  llm               LLM provider abstraction
  logger            Structured logging + telemetry
  storage           Persistence layer
  adapters-md       Markdown adapter
  adapters-memory   In-memory adapter
  schemas           Shared Zod schemas
  skills            Skill loading / scoping
  resources         Resource primitives
  memory            Agent memory primitives
  document-store, hallucination, system, ui, activity,
  analytics, sentry, openapi-client, bundle, utils

tools/
  agent-playground/    SvelteKit 2 web client (active UI)
  webhook-tunnel/      Go — Cloudflare-tunneled webhook ingestion → daemon HTTP signal
  pty-server/          Go — WebSocket bridge for PTY spawning
  friday-launcher/     Go — desktop tray launcher (win/mac/linux)
  evals/               Eval runner (TypeScript)
  test-agents/         Test-only agent fixtures
```

The `apps/` directory contains long-running deployable services. The
`packages/` directory contains internal TypeScript packages used across apps.
The `tools/` directory contains developer tooling, the web client, and Go
helpers that are not full daemon services.

## The Pipeline

This section walks through the system as a signal travels through it, from
ingestion to response.

### Signals

A signal is an external event that triggers agent execution. Friday supports
several signal providers:

- **HTTP** — REST endpoints defined in `workspace.yml`. The daemon registers
  routes on startup. (`packages/signals/src/providers/http-signal.ts`)
- **Cron** — Scheduled triggers managed by `CronManager` in `packages/cron/`.
- **File system** — `FileWatchSignalProvider` in
  `packages/signals/src/providers/fs-watch-signal.ts`, backed by
  `packages/fs-watch/`.
- **External webhooks** — Forwarded into the daemon over HTTP by
  `tools/webhook-tunnel/` (Cloudflare-tunneled), which POSTs to
  `/hook/{provider}/{workspaceId}/{signalId}`. Slack/Discord arrive this way;
  there is no separate `signal-gateway` service.

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
  demand. Owns the per-workspace idle-timeout (default 5 minutes, see
  `idleTimeoutMs` in `apps/atlasd/src/atlas-daemon.ts`).
- **CronManager** — Registers and fires cron-based signals.
- **StreamRegistry** — Tracks active SSE connections for real-time updates
  (`apps/atlasd/src/stream-registry.ts`).
- **AgentRegistry** — `CoreAgentRegistry` discovers bundled system agents and
  workspace-defined agents.

MCP connections are **not pooled** — `@atlas/mcp` (`packages/mcp/`) creates an
ephemeral client per use and disposes it. There is no global pool.

Signal routing: HTTP request hits the daemon's signal route
(`apps/atlasd/routes/signals/`) → daemon calls
`triggerWorkspaceSignal(workspaceId, signalId, payload)` → workspace manager
finds or creates a runtime.

**Architecture Invariant**: The daemon itself is stateless. Workspace state lives
in storage adapters (see Cross-Cutting Concerns). The daemon can restart without
losing workspace definitions — it re-discovers them from storage on boot.

### Workspace Runtime

The workspace runtime (`packages/workspace/src/runtime.ts`) is the execution
environment for a single workspace. It manages:

- **FSM engines** — One per workflow defined in the workspace.
- **Active sessions** — Concurrent signal executions, each isolated.
- **Session lifecycle** — Pending → executing → completed/failed.
- **SSE event emission** — Forwards FSM events to connected clients.

When a signal arrives, the runtime creates a new session and hands it to the
appropriate FSM engine.

**Architecture Invariant**: Workspace runtimes are created lazily on first signal
and destroyed after an idle timeout (default 5 minutes with no active sessions).
The timeout is enforced by the daemon's `WorkspaceManager`, not the runtime
itself — the runtime just exposes idle state. This means the system's memory
footprint scales with active workspaces, not registered workspaces.

### FSM Engine

The FSM engine (`packages/fsm-engine/`) is where business logic lives. Workflows
are finite state machines defined in YAML, not code.

A `.fsm.yaml` file declares:

- **States** — Named states with entry actions and event handlers.
- **Transitions** — Events that move between states, with optional guard
  conditions.
- **Actions** — Work performed on entry or transition.
- **Document types** — Typed JSON schemas for data passed between states.

Action types (see the discriminated union in `packages/fsm-engine/schema.ts`):

- `agent` — Dispatch an agent via the orchestrator.
- `emit` — Fire an event to trigger a transition.
- `llm` — Direct LLM call. Still supported alongside `agent`.

Document I/O is implicit, not a distinct action type: `agent` and `llm` actions
read inputs via `inputFrom` and write outputs via `outputTo` against the
session's document store. There is no separate `code` or `document` action
type today; reusable logic is registered via the `functions` and `tools` maps
on the FSM definition.

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
    → AtlasAgentsMCPServer (StreamableHTTP, packages/core/src/agent-server/)
      → Agent executes with tool access
        → SSE stream back to orchestrator
```

**Wrapped Agents (in-process)**: Lightweight LLM agents defined directly in
`workspace.yml`. These bypass MCP overhead — the orchestrator makes a direct LLM
call with tool schemas injected. Good for simple agents that don't need
isolation. Routing between the two paths happens inside `AgentOrchestrator`
based on how the agent is registered.

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

`@atlas/mcp` (`packages/mcp/`) is the MCP client layer. It is deliberately
**ephemeral** — `createMCPTools()` opens a connection, returns the tools plus a
dispose callback, and the caller is responsible for cleanup. There is no
pooling, sharing, or ref counting; each call site owns its own connection
lifecycle.

Tool access is configured per-workspace in `workspace.yml` under `tools.mcp`.
Each MCP server declaration specifies transport (stdio, SSE, or StreamableHTTP),
allowed tools, and environment.

Friday also exposes its own platform capabilities as MCP servers:

- **Platform MCP server** (`packages/mcp-server/`) — Workspace operations
  (create conversations, list sessions) available as tools.
- **Atlas agents MCP server** (`packages/core/src/agent-server/`,
  `AtlasAgentsMCPServer`) — Bundled agents available as callable tools, with
  per-session isolation.

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

A `friday.yml` exists for platform-wide settings but is rarely used in practice.
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
- **Remote / production** — Cortex or PostgreSQL, accessed through the same
  adapter interface.

You can see this pattern in `apps/link/src/providers/storage/` — an `adapter.ts`
interface with `local-adapter.ts` and `cortex-adapter.ts` implementations. This
pattern is being made consistent across all services.

Workspace-scoped resource storage (versioned, draft/publish, JSONB over SQLite)
is its own service: `apps/ledger/`, an HTTP service on port 3200.

Current storage concerns:

- **Workspace registry** — Metadata about known workspaces (path, status,
  timestamps).
- **Session history** — Timeline events for completed sessions.
- **Library / artifacts** — Files produced by agent execution, organized by date.
- **Resources** — Workspace-scoped versioned data, served by `ledger`.

**Architecture Invariant**: Storage adapters are the boundary between business
logic and persistence. No service directly reads or writes to a specific
backend — it goes through the adapter interface.

### Deno API → Node API Migration

The runtime stays Deno (`deno task start` boots the daemon, the workspace is
defined in `deno.json`). What's migrating is **the APIs the code calls**:
away from the `Deno.*` namespace, toward Node-compatible equivalents that
also work under non-Deno runtimes.

- **What's changed**: Dependencies go in `package.json`, not `deno.json`. Use
  `process.env` from `node:process`, not `Deno.env`. Static imports only.
- **What's stable**: The package structure, the pipeline architecture, the
  YAML-based config, and the MCP integration pattern are all runtime-agnostic.
- **What to watch for**: Deno-specific APIs (`Deno.KV`, `Deno.env`,
  `Deno.readFile`) are being replaced with Node-compatible equivalents. When
  working in a module, prefer Node/standard APIs over Deno APIs.

The migration doesn't affect the architecture — it's an API surface cleanup,
not a runtime swap.

### Deployment

Friday deploys primarily as a **web application**. The daemon (`atlasd`) runs
as a service, the web client (`tools/agent-playground/`) serves the UI, `link`
handles credentials, `ledger` serves workspace resources, and the Go binaries
under `tools/` handle webhook ingestion and desktop integration.

- **Local development**: The daemon runs on `localhost:8080` with file-based
  storage. No K8s required.

## Go Services

Friday's Go binaries handle concerns that benefit from Go's deployment model
(single binary, low memory, strong concurrency). They live under `tools/`,
not `apps/`, and share a single root `go.mod`:

- **webhook-tunnel** (`tools/webhook-tunnel/`) — External signal ingestion.
  Cloudflare-tunneled HTTP endpoint that forwards `/hook/{provider}/{workspaceId}/{signalId}`
  POSTs into the daemon as HTTP signals. This is how Slack, Discord, and other
  third-party events reach Friday.
- **pty-server** (`tools/pty-server/`) — WebSocket bridge for spawning PTYs,
  used by terminal-style agent surfaces.
- **friday-launcher** (`tools/friday-launcher/`) — Desktop tray launcher
  (Windows/macOS/Linux) that supervises a local daemon.

Naming history: earlier docs referenced `gist` (file service) and
`signal-gateway` (external event router) as separate Go services. Neither
exists today — `webhook-tunnel` covers external ingestion, and artifact
storage is handled by the TypeScript side plus `ledger`.

**Architecture Invariant**: Go services communicate with the daemon over HTTP.
They don't import TypeScript packages or share code with the TS side — the HTTP
API is the boundary.
