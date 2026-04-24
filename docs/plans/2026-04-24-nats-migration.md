# NATS Migration Plan

**Date:** 2026-04-24
**Scope:** Replace FSM code execution (Deno workers) + daemon coordination with NATS; rewrite Python agent SDK from WASM to NATS subprocess model.

---

## Phase Status

| Phase | Description | Status |
|---|---|---|
| 1 | NATS Server Management | ✅ Complete |
| 2 | Python Agent SDK Rewrite | ✅ Complete |
| 3 | Process Agent Executor | ✅ Complete |
| 4 | Remove FSM Code Actions | ✅ Complete |
| 5 | Session Events via NATS JetStream | ✅ Complete |
| 6 | Signal Routing via NATS | ✅ Complete |
| 7 | TypeScript Agent SDK | ✅ Complete |
| 8 | Agent Registration Protocol | ✅ Complete |

---

## Problem Statement

Three separate concerns are fused in the current design:

1. **Sandboxed code execution** — `type: code` FSM actions run in Deno worker pool. Fixed and working, but creates a parallel execution model alongside agents.
2. **Capability proxying** — Python WASM agents call LLM/HTTP/tools via WIT bindings injected via `globalThis.__fridayCapabilities`. Build step (componentize-py → jco) required. No async concurrency.
3. **Coordination** — Signal routing, session events, and session state are in-process (in-memory maps, SSE callbacks, CronManager). Single-daemon only.

NATS decouples all three:
- Agent subprocesses (Python, TypeScript) connect to NATS as clients; capabilities are NATS request/reply subjects.
- Session events fan out over NATS instead of in-memory callbacks.
- Signal routing flows through NATS subjects; workspace runtimes subscribe.

The daemon manages a `nats-server` subprocess — zero external infrastructure for dev.

---

## What We're Replacing vs. Keeping

### Removed
| Component | File | Why |
|---|---|---|
| `WorkerExecutor` | `packages/fsm-engine/worker-executor.ts` | Replaced by NATS code-executor service |
| `function-executor.worker.ts` | `packages/fsm-engine/function-executor.worker.ts` | Worker script no longer needed |
| `CodeAction` FSM type | `packages/fsm-engine/types.ts` | `type: code` removed from workspace.yml |
| `CodeAgentExecutor` (WASM) | `packages/workspace/src/code-agent-executor.ts` | Replaced by `ProcessAgentExecutor` |
| WIT interface | `packages/sdk-python/wit/agent.wit` | Replaced by NATS subjects |
| `_bridge.py` (WIT shim) | `packages/sdk-python/friday_agent_sdk/_bridge.py` | Replaced by NATS entry point |
| WASM build step | `deno task agent build` / componentize-py / jco | No longer needed |
| `packages/sdk-python/` | in-repo Python SDK (WASM model) | Deleted — SDK lives at `~/tempest/agent-sdk` |
| `SessionStreamRegistry` (in-memory) | `apps/atlasd/src/session-stream-registry.ts` | Replaced by NATS JetStream |
| `writing-friday-agents` skill | `.claude/skills/writing-friday-agents/` | Rewritten for NATS model (Phase 2) |

### Kept (unchanged)
| Component | Notes |
|---|---|
| FSM state machine logic | `type: agent`, `type: llm`, `type: emit` actions unchanged |
| `AgentOrchestrator` (MCP) | System/atlas agents still use MCP |
| HTTP API surface | All external endpoints unchanged |
| `workspace.yml` schema | Except `type: code` removed |
| Session persistence/history | Disk adapter unchanged |
| `CronManager` | NATS has no native scheduler — kept as-is, fire path changed to `nc.publish` |
| `friday_agent_sdk` public API | `@agent`, `ctx.llm`, `ctx.http`, `ctx.tools`, `ctx.stream` — identical |

---

## NATS Subject Design

All subjects are scoped to prevent cross-session access.

```
# Agent registration (one-shot — see Phase 8)
agents.validate.{validateId}        → publish (agent → daemon), registration handshake

# Agent capability back-channel (scoped per session)
caps.{sessionId}.llm.generate       → request/reply
caps.{sessionId}.http.fetch         → request/reply
caps.{sessionId}.tools.call         → request/reply
caps.{sessionId}.tools.list         → request/reply

# Agent execution (request/reply)
agents.{sessionId}.execute          → request/reply (daemon → agent)

# Session lifecycle events (JetStream durable)
sessions.{sessionId}.events         → publish (daemon OR agent → subscribers)

# Signal routing
signals.{workspaceId}.{signalId}    → publish (HTTP handler → runtime)

# Session control
sessions.{sessionId}.cancel         → publish (HTTP → runtime)

# Code executor (removed in Phase 4)
# exec.run                          → removed with WorkerExecutor
```

---

## NATS Protocol Reference

Holistic view of what the daemon facilitates over NATS. Organized by who initiates each message and what the daemon is responsible for at that step.

### Daemon as Publisher

| Subject | When | Payload |
|---|---|---|
| `agents.{sessionId}.execute` | Agent invocation start | `{ prompt: string, context: SerializedAgentContext }` |
| `signals.{workspaceId}.{signalId}` | HTTP trigger or cron fire | `{ payload, sessionId, streamId, userId }` |
| `sessions.{sessionId}.cancel` | `DELETE /api/sessions/:id` | `{}` |

### Daemon as Subscriber (wildcard)

| Subject | Subscriber pattern | Daemon action |
|---|---|---|
| `agents.validate.*` | `agents.validate.*` | Receive agent metadata on registration; write metadata.json |
| `caps.*.llm.generate` | `caps.*.llm.generate` | Extract sessionId from subject[1]; route to session's LLM config |
| `caps.*.http.fetch` | `caps.*.http.fetch` | Extract sessionId; forward outbound HTTP; return response |
| `caps.*.tools.call` | `caps.*.tools.call` | Extract sessionId; forward to session's MCP tool call handler |
| `caps.*.tools.list` | `caps.*.tools.list` | Extract sessionId; return tools available to this session |
| `sessions.*.events` | `sessions.*.events` (JetStream) | Persist to session history; fan out to SSE subscribers |
| `signals.{workspaceId}.*` | Per-workspace pattern | Route to matching workspace runtime |

### Protocol Flows

#### Registration (Phase 8)

```
CLI / HTTP                Daemon                   Agent subprocess
  │                         │                           │
  ├─ POST /agents/register ─►                           │
  │                         ├─ gen validateId           │
  │                         ├─ spawn <entrypoint>       │
  │                         │   ATLAS_VALIDATE_ID=id    │
  │                         │   NATS_URL=...            │
  │                         │                           ├─ detect ATLAS_VALIDATE_ID
  │                         │                           ├─ connect NATS
  │                         │                           ├─ publish agents.validate.{id}
  │   ◄── 201 { agentId } ──┤   ◄── metadata ──────────┤
  │                         ├─ SHA256(entrypoint file)  ├─ exit
  │                         ├─ write metadata.json      │
  │                         ├─ reload registry          │
```

**Open question:** validate response vs agent metadata format — whether the SDK publishes the full `@agent(...)` decorator payload or a minimal `{ id, version, entrypoint }` subset. TBD when implementing Phase 8.

#### Invocation

```
WorkspaceRuntime          Daemon                   Agent subprocess
  │                         │                           │
  ├─ ProcessAgentExecutor   │                           │
  │   .execute(...)         │                           │
  │                         ├─ capRegistry.register(sid, ctx)
  │                         ├─ infer cmd from entrypoint extension
  │                         ├─ spawn <cmd> <entrypoint>
  │                         │   NATS_URL, ATLAS_SESSION_ID=sid
  │                         │                           ├─ connect NATS
  │                         │                           ├─ subscribe agents.{sid}.execute
  │                         ├─ nc.request agents.{sid}.execute ──►
  │                         │   { prompt, context }     │
  │                         │                           ├─ call handler(prompt, ctx)
  │   [capability calls interleaved — see below]        │
  │                         │   ◄── { tag, val } ───────┤
  │                         ├─ capRegistry.unregister(sid)
  │   ◄── AgentResult ──────┤
  │                         ├─ kill process
```

#### Capability: LLM

Agent calls `ctx.llm.generate(...)` → SDK sends NATS request to `caps.{sid}.llm.generate`.

Daemon's wildcard subscriber (`CapabilityHandlerRegistry`):
1. Extract `sid = subject.split(".")[1]`
2. Lookup session context from registry
3. Call LLM via `agentLlmConfig` (model, temperature, etc. from metadata.json `llm` field or workspace default)
4. Serialize response to JSON; reply

**Error:** `{ "error": "message" }` in reply payload → SDK raises `LlmError`.

Current limitation: streaming LLM responses are not supported — the entire generation is buffered and returned in one reply. Streaming would require a different subject pattern (e.g. `caps.{sid}.llm.stream.*`) and is deferred.

#### Capability: HTTP

Agent calls `ctx.http.fetch(url, options)` → NATS request to `caps.{sid}.http.fetch`.

Daemon makes outbound HTTP call, serializes `{ status, headers, body }` as reply. Enforces allowlist if configured (TBD — currently unrestricted).

#### Capability: Tools (MCP)

Agent calls `ctx.tools.list()` → `caps.{sid}.tools.list` → daemon returns MCP tools available to this session.

Agent calls `ctx.tools.call(name, args)` → `caps.{sid}.tools.call` → daemon routes to session's MCP client.

MCP server config comes from `metadata.json` `mcp` field (agent-declared servers) merged with workspace-level MCP config.

#### Skills Access

Agent declares `use_workspace_skills: true` in `@agent(...)` decorator.

At invocation, before spawning the subprocess, daemon:
1. Reads workspace's assigned skill IDs from config
2. Fetches skill content from local skill store (`~/.atlas/skills/`)
3. Serializes as `context.skills: Record<string, string>` (skill name → markdown content)

Skills are injected **once at invocation time** — no NATS round-trip per skill. Agent accesses via `ctx.skills`. This is a pull-on-entry model.

**Open question:** exact serialization path for skill content (full SKILL.md content? frontmatter stripped?). TBD in Phase 8 implementation.

#### Session Events (Stream)

Agents publish text/tool-call deltas directly to `sessions.{sid}.events` (no daemon round-trip):

```python
await nc.publish(f"sessions.{session_id}.events", json.dumps({
    "type": "data-text-delta", "data": {"text": "..."}
}).encode())
```

Daemon JetStream subscriber receives, persists, and fans out to SSE connections. Same subject used for daemon-published lifecycle events (`step:start`, `step:complete`, etc.).

### SDK Location

The Python agent SDK lives at `~/tempest/agent-sdk` (external repo, separate release cadence). This plan covers only the **daemon-side protocol contract**. SDK implementation details (how `_bridge.py` connects NATS, how `_context.py` calls caps subjects) are external to this repo.

Protocol contract = the subjects the daemon subscribes to, the payload shapes it accepts, and the response shapes it produces. Any conformant NATS client in any language can implement the SDK side.

---

## Protocol Design Reference

This section documents the full protocol model, workspace.yml interaction, platform tools, and skills — derived from design sessions after the initial phases shipped.

### The Five Channels

Every agent execution uses exactly five NATS subjects:

```
agents.{sessionId}.execute       ← daemon → agent  (request/reply)
                                    "here's your prompt + context, go"

caps.{sessionId}.llm.generate    ← agent → daemon  (request/reply)
caps.{sessionId}.http.fetch      ← agent → daemon  (request/reply)
caps.{sessionId}.tools.call      ← agent → daemon  (request/reply)
caps.{sessionId}.tools.list      ← agent → daemon  (request/reply)

sessions.{sessionId}.events      ← agent → daemon  (publish, no reply)
                                    "here's a streaming text delta"
```

### Execute Payload Shape

```json
{
  "prompt": "summarize this document...",
  "context": {
    "session": {
      "id": "sess_abc",
      "workspace_id": "grilled_xylem",
      "user_id": "user_123",
      "datetime": "2026-04-24T..."
    },
    "env":    { "SOME_API_KEY": "..." },
    "config": { "workDir": "/tmp/...", "agentSpecificField": "..." },
    "skills": [
      { "name": "summarizer", "description": "...", "instructions": "..." }
    ],
    "llm_config": { "model": "claude-sonnet-4-6", "temperature": 0.3 },
    "output_schema": { ... }
  }
}
```

`context.skills` is only present when `useWorkspaceSkills: true` in `metadata.json` and the workspace has skills configured. Each entry contains the full instruction text — agents do not read from disk.

### Capability Proxying

The `CapabilityHandlerRegistry` holds four long-lived wildcard NATS subscribers registered at daemon startup. When `ProcessAgentExecutor.execute()` runs, it calls `capabilityRegistry.register(sessionId, ctx)` to bind that session's LLM config, MCP tool functions, and stream emitter.

When an agent calls `ctx.llm.generate(...)`, that becomes a NATS request to `caps.{sid}.llm.generate`. The daemon's wildcard subscriber:
1. Extracts `sid` from `subject.split(".")[1]`
2. Looks up the registered session context
3. Calls the real LLM via the session's `agentLlmConfig` (from `metadata.json`)
4. Serializes the full response as one reply (no streaming)

HTTP and tools follow the same pattern. The agent **never talks to any provider directly** — all I/O is proxied.

### Platform Tools (memory_save, etc.)

Platform tools (memory_save, memory_read, fs_read_file, bash, etc.) are **not proxied through NATS subjects**. They flow through a different path.

`executeCodeAgent()` always injects an `atlas-platform` MCP server:
```typescript
const mcpConfigs = {
  "atlas-platform": getAtlasPlatformServerConfig(),
  // + workspace.yml tools.mcp.servers
  // + metadata.json mcp servers (highest precedence, last-write-wins)
};
const { tools: mcpTools } = await createMCPTools(mcpConfigs, logger);
```

`getAtlasPlatformServerConfig()` returns `{ transport: { type: "http", url: "http://localhost:8080/mcp" } }` — the daemon itself. The full call chain for `ctx.tools.call("memory_save", {...})`:

```
Agent subprocess
  └─ NATS request → caps.{sid}.tools.call
        └─ CapabilityHandlerRegistry → mcpToolCall(name, args)
              └─ mcpTools["memory_save"].execute(args)
                    └─ HTTP POST → http://localhost:8080/mcp  (atlas-platform MCP server)
                          └─ daemon MCP handler → memory API → database
```

This is intentionally circular: the MCP client is ephemeral and per-session (lives in the daemon's capability registry context), while the MCP server is the daemon's permanent `/mcp` endpoint. They are structurally independent even though they run in the same process.

`workspace.yml`'s `tools.mcp.servers` entries are merged in alongside `atlas-platform`. Agent-declared `metadata.json` mcp servers take highest precedence.

### workspace.yml Interaction

#### The `agents:` block

```yaml
agents:
  my-summarizer:
    type: user
    agent: summarizer-agent       # matches id in metadata.json
    description: "Summarizes docs"
    prompt: "Focus on action items"
    env:
      OPENAI_KEY: ${{ secrets.OPENAI_KEY }}
```

`type: user` is the NATS subprocess path. The other types (`llm`, `system`, `atlas`) go through the MCP orchestrator — they never touch `ProcessAgentExecutor`.

#### Three things workspace.yml controls for user agents

**1. `prompt` — workspace-level overlay**
Extracted via `extractAgentConfigPrompt()`. Lower precedence than the FSM action's own `prompt`. Final prompt assembled as:
```
action.prompt            (highest — FSM action's task)
  + agentConfigPrompt    (workspace.yml default instructions)
  + context              (signal data + FSM documents + temporal facts)
```

Lets you specialize a generic agent per workspace without editing its code.

**2. `env` — resolved credential env vars**
`agentConfig.env` is `Record<string, string | LinkCredentialRef>`. The runtime calls `resolveEnvValues()` to expand `${{ secrets.X }}` references before passing them as the subprocess environment. If `env` is omitted, the daemon's full `process.env` passes through.

**3. Routing**
`resolveRuntimeAgentId()` converts `type: user` entries to `user:{agentId}`, routing them to `executeCodeAgent()` instead of the MCP orchestrator.

#### Two-tier config system

| Source | Controls |
|---|---|
| `metadata.json` `llm` field | LLM model/provider/temperature for `ctx.llm.generate()` |
| `metadata.json` `mcp` field | MCP servers available for `ctx.tools.*` |
| `metadata.json` `useWorkspaceSkills` | Whether workspace skills are injected |
| `workspace.yml` `prompt` | Task/instruction text prepended to the agent's prompt |
| `workspace.yml` `env` | Environment variables the subprocess receives |

The **agent author** controls the model via `@agent(llm={"model": "..."})` — not the workspace operator. `workspace.yml` has no `llm:` field on `UserAgentConfigSchema` intentionally.

### Skills Injection

#### Current model

When `metadata.json` has `useWorkspaceSkills: true`:
1. Runtime reads `workspace.yml`'s `skills:` entries (inline + global store refs)
2. Fetches global skills from `SkillStorage` (`~/.atlas/skills/`)
3. Passes skills to the subprocess via the execute payload as `context.skills` (array of `{name, description, instructions}`)

Skills are injected **once at invocation time** — pull-on-entry. No NATS round-trip per skill, no dynamic skill requests during execution.

#### claude-code agents also get filesystem materialization

For agents using the `claude-code` provider (which discovers SKILL.md files on disk), the runtime additionally writes skills to `{workDir}/.claude/skills/{name}/SKILL.md`. The `workDir` field in `context.config` points to either the FSM's cloned repo (for pipeline agents) or a temp directory. NATS subprocess agents (Python, TypeScript) receive the inline text in `context.skills` instead and should ignore `workDir`.

#### Skill shape in the payload

```json
{
  "skills": [
    {
      "name": "code-reviewer",
      "description": "Reviews code for correctness and clarity",
      "instructions": "When reviewing code, focus on..."
    }
  ]
}
```

Frontmatter is stripped — agents receive the body only. Skill name is the plain name, not the `namespace/name` storage key (an internal detail the agent doesn't need).

---

## Phase 1: NATS Server Management (Daemon)

**Goal:** Daemon spawns and manages `nats-server` as a subprocess. All other phases depend on this.

**Files to create/modify:**
- `apps/atlasd/src/nats-manager.ts` — new: lifecycle management
- `apps/atlasd/src/atlas-daemon.ts` — wire in NatsManager at startup

**Implementation:**

```typescript
// apps/atlasd/src/nats-manager.ts
export class NatsManager {
  private proc: Deno.ChildProcess | null = null;
  private nc: NatsConnection | null = null;

  async start(): Promise<NatsConnection> {
    // spawn nats-server -p 4222 --no-log
    // wait for port to open
    // connect via nats.ws or nats deno client
    // return connected NatsConnection
  }

  async stop(): Promise<void> { /* graceful shutdown */ }
  get connection(): NatsConnection { /* throws if not started */ }
}
```

**Dependencies:**
- `nats` Deno/Node client: `deno add npm:nats`
- `nats-server` binary: check via `which nats-server`, install via `deno task install-nats` wrapper (downloads release binary to `bin/`)

**Config:**
- Port: `4222` (default), configurable via `friday.yml`
- JetStream enabled (needed for Phase 3 and Phase 5)
- Embedded (no external file) — pass config via `-c <tempfile>` or CLI flags

**Daemon startup sequence:**
```
1. NatsManager.start() → spawn nats-server, await ready
2. Connect as daemon NATS client
3. Register capability handlers (Phase 3)
4. Register signal subscribers (Phase 6)
5. Continue existing boot
```

**Parity:** None — this is new infrastructure. No behavior change until Phase 2+.

---

## Phase 2: Python Agent SDK Rewrite ✅

**Goal:** `friday_agent_sdk` becomes a NATS client. No WASM, no build step. Public API identical.

**Status:** Complete. The SDK is now at `~/tempest/agent-sdk` (external repo). `packages/sdk-python/` was deleted from this repo.

**Protocol contract delivered:**
- `_bridge.py`: connects `NATS_URL`, subscribes `agents.{ATLAS_SESSION_ID}.execute`, single-shot, exits after `nc.drain()`
- `_context.py`: `caps.{sid}.llm.generate`, `caps.{sid}.http.fetch`, `caps.{sid}.tools.call/list` via NATS request/reply
- `sessions.{sid}.events` published directly by agent for stream events
- Sync and async handlers both supported via `asyncio.to_thread`

SDK internals (how `_bridge.py` works, test patterns, package structure) are now maintained in the external repo — outside the scope of this document.

---

## Phase 3: Process Agent Executor (Daemon Side) ✅

**Goal:** Replace `CodeAgentExecutor` (WASM dynamic import) with `ProcessAgentExecutor` (subprocess + NATS capabilities).

**Status:** Complete. Known limitation still pending in Phase 8: `ProcessAgentExecutor` hardcodes `python3` as the spawn command. Polyglot entrypoint inference (`.py` → `python3`, `.ts` → `deno run`, binary → direct exec) requires `entrypoint` field in `metadata.json` — see Phase 8.

**Files:**
- `packages/workspace/src/process-agent-executor.ts` — new (replaces code-agent-executor.ts)
- `packages/workspace/src/runtime.ts` — swap executor reference
- `apps/atlasd/src/capability-handlers.ts` — new: NATS capability subscribers

### Capability Handler Architecture (Wildcard Subscribers)

**Critical:** do NOT create per-session subscriptions inside `execute()`. That creates N×M subscription churn (N capability types × M concurrent sessions). Instead, daemon registers long-lived wildcard subscribers once at startup. Session context is looked up by session ID extracted from the subject.

```typescript
// apps/atlasd/src/capability-handlers.ts

interface CapabilityContext {
  streamEmitter?: CodeAgentStreamEmitter;
  mcpToolCall: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  mcpListTools: () => Promise<Array<{ name: string; description: string; inputSchema: unknown }>>;
  agentLlmConfig?: AgentLLMConfig;
  logger: Logger;
  abortSignal?: AbortSignal;
}

export class CapabilityHandlerRegistry {
  private sessions = new Map<string, CapabilityContext>();

  register(sessionId: string, ctx: CapabilityContext) {
    this.sessions.set(sessionId, ctx);
  }

  unregister(sessionId: string) {
    this.sessions.delete(sessionId);
  }

  async start(nc: NatsConnection): Promise<void> {
    // All four are wildcard — session ID is subject segment [1]
    await nc.subscribe("caps.*.llm.generate", { callback: this.handleLlm });
    await nc.subscribe("caps.*.http.fetch",   { callback: this.handleHttp });
    await nc.subscribe("caps.*.tools.call",   { callback: this.handleToolCall });
    await nc.subscribe("caps.*.tools.list",   { callback: this.handleToolList });
    // stream.emit is NOT proxied through the capability handler — agents publish
    // directly to sessions.{sessionId}.events (see Phase 2 / subject design)
  }

  private handleLlm = async (err, msg) => {
    const sessionId = msg.subject.split(".")[1];
    const ctx = this.sessions.get(sessionId);
    if (!ctx) { msg.respond(JSON.stringify({ error: "unknown session" })); return; }
    try {
      // createLlmGenerateHandler body reused, but errors serialize to JSON instead of throwing ComponentError
      const result = await callLlmGenerate(msg.string(), ctx);
      msg.respond(result);
    } catch (e) {
      msg.respond(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    }
  };
  // ... handleHttp, handleToolCall, handleToolList, handleStream similarly
}
```

**`ComponentError` reuse note:** `createLlmGenerateHandler` and `createHttpFetchHandler` throw `ComponentError` (a WIT-specific wrapper). Extract the inner logic into transport-agnostic functions; the NATS handlers catch and serialize to `{ error: "..." }` reply payload. The Python SDK raises `LlmError`/`HttpError` on a response with an `error` field.

### `ProcessAgentExecutor`

```typescript
// packages/workspace/src/process-agent-executor.ts
export class ProcessAgentExecutor {
  constructor(
    private nc: NatsConnection,
    private capabilityRegistry: CapabilityHandlerRegistry,
  ) {}

  async execute(
    agentPath: string,
    prompt: string,
    options: ProcessAgentExecutorOptions,
  ): Promise<AgentResult> {
    const sessionId = options.sessionContext.id;

    // 1. Register session context for wildcard capability handlers
    this.capabilityRegistry.register(sessionId, {
      streamEmitter: options.streamEmitter,
      mcpToolCall: options.mcpToolCall,
      mcpListTools: options.mcpListTools,
      agentLlmConfig: options.agentLlmConfig,
      logger: options.logger,
    });

    // 2. Spawn agent subprocess
    const proc = new Deno.Command("python3", {
      args: [agentPath],
      env: {
        NATS_URL: "nats://localhost:4222",
        ATLAS_SESSION_ID: sessionId,
        ...options.env,
      },
    }).spawn();

    try {
      // 3. Send execute request; agent subscribes, handles, then exits
      const response = await this.nc.request(
        `agents.${sessionId}.execute`,
        JSON.stringify({ prompt, context: serializeAgentContext(options) }),
        { timeout: options.timeoutMs ?? 180_000 },
      );

      const result = JSON.parse(new TextDecoder().decode(response.data));
      return this.toAgentResult(result, prompt);
    } finally {
      // 4. Cleanup: unregister session, kill process
      this.capabilityRegistry.unregister(sessionId);
      proc.kill();
      await proc.status;
    }
  }
}
```

**`CodeAgentExecutorOptions` → `ProcessAgentExecutorOptions`:** Identical shape. `streamEmitter`, `mcpToolCall`, `mcpListTools`, `sessionContext`, `agentLlmConfig`, `env`, `outputSchema`, `timeoutMs` all carry over unchanged. The capability handler functions (`createLlmGenerateHandler`, `createHttpFetchHandler`) are extracted to `capability-handlers.ts` and reused.

**`serializeAgentContext`:** Kept unchanged — same JSON format the Python SDK expects.

**Agent path resolution:** Currently agents are registered with a `sourceLocation` path containing `agent.js`. Post-migration: `agent.py` path (or `agent.ts`). The agent registry in `workspace.yml` gains a `runtime` field:
```yaml
agents:
  my-agent:
    source: ./agents/my-agent/agent.py   # was: sourceLocation pointing to WASM dir
```

---

## Phase 4: Remove FSM Code Actions

**Goal:** Delete `type: code` from the FSM entirely. Agents are the only executable unit.

**Files changed:**
- `packages/fsm-engine/types.ts` — remove `CodeAction`, update `Action` union
- `packages/fsm-engine/fsm-engine.ts` — remove `_guardExecutor`, `_actionExecutor`, all `case "code":` branches
- `packages/fsm-engine/worker-executor.ts` — **delete**
- `packages/fsm-engine/function-executor.worker.ts` — **delete**
- `packages/config/src/` — remove `type: code` from workspace.yml schema + validator
- All `workspace.yml` files in `workspaces/` — migrate `type: code` actions (see audit below)

### Audit Results

No workspaces use `type: code` — the two that did (`chat-unify-exec`, `fast-improvements-source`) were deleted. Phase 4 has no workspace migration work.

---

## Phase 5: Session Events via NATS JetStream

**Goal:** Replace in-memory `SessionStreamRegistry` with NATS JetStream. Session events become durable, replayable, and cross-daemon.

**Files:**
- `apps/atlasd/src/session-stream-registry.ts` — replaced by NATS stream adapter
- `apps/atlasd/src/nats-session-stream.ts` — new
- `apps/atlasd/routes/sessions/index.ts` — update SSE endpoint to subscribe via NATS
- `packages/workspace/src/runtime.ts` — replace `sessionStream.emit()` calls with NATS publish

**JetStream stream config:**
```
Stream name: SESSIONS
Subjects: sessions.*.events
Retention: WorkQueuePolicy (or LimitsPolicy with TTL 24h)
Storage: Memory (dev) / File (prod)
```

**Event publishing (runtime.ts):**
```typescript
// Before: sessionStream.emit({ type: "step:complete", ... })
// After:
await nc.publish(
  `sessions.${sessionId}.events`,
  JSON.stringify({ type: "step:complete", ... }),
);
```

**SSE endpoint (sessions/index.ts):**
```typescript
// Subscribe with sequence replay from event 0 for this session
const sub = await js.subscribe(`sessions.${sessionId}.events`, {
  config: { deliver_policy: DeliverPolicy.All },
});
for await (const msg of sub) {
  controller.enqueue(encoder.encode(`data: ${msg.string()}\n\n`));
}
```

**Improvement over current:** SSE clients can reconnect mid-session and get full replay. Currently `SessionStreamRegistry` buffers events in memory with a fixed-size ring buffer — NATS JetStream is durable and doesn't lose events on buffer overflow.

**Keep:** `SessionHistoryAdapter` (disk persistence for completed sessions) — unchanged.

---

## Phase 6: Signal Routing via NATS

**Goal:** HTTP signal endpoints publish to NATS; workspace runtimes subscribe. Enables cross-workspace signals and eventual multi-daemon.

**Files:**
- `apps/atlasd/routes/workspaces/index.ts` — publish signal to NATS instead of calling daemon directly
- `apps/atlasd/src/atlas-daemon.ts` — remove `getOrCreateWorkspaceRuntime` from signal path, add NATS subscriber per workspace
- `packages/workspace/src/runtime.ts` — `subscribeToSignals(nc)` method

**Signal publish (HTTP handler):**
```typescript
// Before: await ctx.daemon.triggerWorkspaceSignal(workspaceId, signalId, payload)
// After:
await nc.publish(
  `signals.${workspaceId}.${signalId}`,
  JSON.stringify({ payload, sessionId, streamId, userId }),
);
```

**Workspace runtime subscription:**
```typescript
// WorkspaceRuntime.subscribeToSignals(nc)
const sub = await nc.subscribe(`signals.${this.workspace.id}.*`);
for await (const msg of sub) {
  const { payload, sessionId, streamId } = JSON.parse(msg.string());
  const signalId = msg.subject.split(".")[2];
  await this.processSignalForJob(signalId, payload, sessionId, streamId);
}
```

**SSE response path:** The HTTP handler publishes to NATS and simultaneously subscribes to `sessions.${sessionId}.events` to stream back to the client. The decoupling means the HTTP connection is not in the signal execution path — the runtime processes the signal asynchronously.

**Improvement:** Cross-workspace signals become `nc.publish(`signals.${targetWorkspaceId}.${signalId}`, ...)`. No special routing needed.

**Cron signals:** `CronManager` is kept unchanged — NATS has no native scheduler, so we still need it. The only change is the fire path: instead of calling `daemon.triggerWorkspaceSignal()` directly, it publishes to `signals.${workspaceId}.${signalId}` on the NATS connection. CronManager remains the source of truth for when signals fire.

**Multi-daemon queue groups:** When multiple daemon instances subscribe to signal subjects (future horizontal scaling), use NATS queue groups to prevent fan-out:
```typescript
const sub = await nc.subscribe(`signals.${this.workspace.id}.*`, {
  queue: "signal-processors",
});
```
Each queue group ensures only one daemon instance processes each signal. Each workspace runtime registers its own queue group keyed by workspace ID — a signal for workspace A never routes to workspace B's runtime.

---

## Phase 7: TypeScript Agent SDK (New)

**Goal:** First-class TypeScript agents that speak the same NATS protocol. Runs as `deno run agent.ts` or `node agent.ts`.

**New package:** `packages/sdk-ts/` (or `@atlas/fn-agent`)

```typescript
// packages/sdk-ts/src/index.ts
export function agent(
  meta: { id: string; version: string; description?: string },
  handler: (prompt: string, ctx: AgentContext) => Promise<AgentResult> | AgentResult,
) {
  // Set metadata
  // On process start: connect to NATS, subscribe to agents.{SESSION_ID}.execute
  // Same protocol as Python SDK
}
```

The `AgentContext` TypeScript interface mirrors the Python `AgentContext` exactly. Capability calls are `await nc.request(...)` with the same subjects. Sync and async handlers both supported.

**Why this is free:** The NATS protocol is language-agnostic. Once the daemon binds capability handlers and the Python SDK speaks the protocol, TypeScript uses identical subjects with identical payloads.

---

## Phase 8: Agent Registration Protocol

**Goal:** Replace the WASM `buildAgent` pipeline in `POST /api/agents/register` with a NATS validate handshake. Record `entrypoint` + `hash` in `metadata.json`. Enable polyglot spawn.

### What's still broken

- `apps/atlasd/routes/agents/register.ts` imports `buildAgent` from `@atlas/workspace/agent-builder` — the WASM compile pipeline that no longer applies.
- `packages/workspace/src/agent-builder.ts` still exists but has no role in the subprocess model.
- `apps/atlasd/src/process-agent-executor.ts` hardcodes `python3`; can't spawn TypeScript or compiled agents.
- `packages/core/src/agent-loader/adapters/user-adapter.ts` `AgentMetadataFileSchema` has no `entrypoint` or `hash` fields.

### metadata.json schema extension

Add to `AgentMetadataFileSchema` (`packages/core/src/agent-loader/adapters/user-adapter.ts`):

```typescript
const AgentMetadataFileSchema = z.object({
  id: z.string(),
  version: z.string(),
  displayName: z.string().optional(),
  description: z.string(),
  entrypoint: z.string(),           // ← new: filename relative to agent dir (e.g. "agent.py")
  hash: z.string().optional(),      // ← new: SHA256 hex of entrypoint at registration time
  llm: AgentLLMConfigSchema.optional(),
  mcp: z.record(z.string(), MCPServerConfigSchema).optional(),
  useWorkspaceSkills: z.boolean().optional(),
});
```

Existing agents without `entrypoint` fall back to `"agent.py"` during a transition period; the field becomes required after Phase 8 lands.

### Validate handshake

The daemon uses NATS to ask the agent for its own metadata rather than parsing it via a build tool. The SDK detects `ATLAS_VALIDATE_ID` at startup and exits after publishing.

**Daemon side (`apps/atlasd/routes/agents/register.ts`):**

```typescript
// 1. Generate a validate ID
const validateId = nanoid();

// 2. Subscribe to the validate reply before spawning (avoid race)
const sub = nc.subscribe(`agents.validate.${validateId}`, { max: 1 });

// 3. Spawn agent in validate mode
const proc = spawn(inferCommand(entrypointPath), [entrypointPath], {
  env: { ATLAS_VALIDATE_ID: validateId, NATS_URL: natsUrl },
});

// 4. Await metadata with timeout
const msg = await Promise.race([
  sub[Symbol.asyncIterator]().next(),
  timeout(10_000, "validate timeout"),
]);
const metadata = AgentValidateResponseSchema.parse(JSON.parse(msg.value.string()));

// 5. Hash + write metadata.json
const hash = await sha256File(entrypointPath);
await writeMetadataJson(destDir, { ...metadata, entrypoint: entrypointFile, hash });

// 6. Reload registry
await agentRegistry.reload();
```

**SDK side (agent-sdk repo):** SDK's `run()` checks `ATLAS_VALIDATE_ID` before subscribing to execute. If present: connect NATS, publish registered agent metadata to `agents.validate.{id}`, drain, exit. No execute handler invoked.

### Polyglot spawn

`ProcessAgentExecutor.execute()` currently:
```typescript
const proc = spawn("python3", [agentPath], { ... });
```

Post-Phase 8, reads `metadata.entrypoint` extension:
```typescript
function inferCommand(entrypoint: string): string {
  if (entrypoint.endsWith(".py")) return "python3";
  if (entrypoint.endsWith(".ts")) return "deno";
  return entrypoint; // assume compiled binary, exec directly
}

// For .ts entrypoints, prepend `--allow-net --allow-env` to args
```

`agentPath` changes from `path.join(sourceLocation, "agent.py")` to `path.join(sourceLocation, metadata.entrypoint)`.

### Files to change

| File | Change |
|---|---|
| `packages/core/src/agent-loader/adapters/user-adapter.ts` | Add `entrypoint`, `hash` to `AgentMetadataFileSchema` |
| `apps/atlasd/routes/agents/register.ts` | Replace `buildAgent` with validate handshake |
| `apps/atlasd/routes/agents/register.test.ts` | Update tests for new register flow |
| `apps/atlasd/src/process-agent-executor.ts` | Polyglot command inference; read `entrypoint` from metadata |
| `packages/workspace/src/runtime.ts` | Use `metadata.entrypoint` instead of joining `"agent.py"` |
| `packages/workspace/src/agent-builder.ts` | **Delete** |
| `packages/workspace/package.json` | Remove `"./agent-builder"` export |
| `apps/atlas-cli/src/cli/commands/agent/register.ts` | Remove WASM-specific flags (`--sdk-path`, `--wit-dir`) |

### Skills injection (hook into invocation)

When `metadata.useWorkspaceSkills === true`, `ProcessAgentExecutor.execute()` fetches workspace skill content before serializing context:

```typescript
let skills: Record<string, string> = {};
if (agentMetadata.useWorkspaceSkills) {
  skills = await loadWorkspaceSkills(workspaceId);  // reads ~/.atlas/skills/ or skill registry
}
// skills injected into serializeAgentContext output as context.skills
```

**Open question:** exact serialization path (full SKILL.md vs. body-only, skill name as key vs. namespace/name). TBD.

---

## Sequencing & Dependencies

```
✅ Phase 1 (NATS infra)
  └─ ✅ Phase 2 (Python SDK — external)
  └─ ✅ Phase 3 (Process executor) — hardcoded python3, fixed in Phase 8
       └─ ✅ Phase 4 (Remove code actions)
  └─ ✅ Phase 5 (Session events)
  └─ ✅ Phase 6 (Signal routing)
       └─ ✅ Phase 7 (TS SDK)

🔲 Phase 8 (Registration protocol) ── depends on 1 + 3 (metadata.json + executor wiring)
```

Phases 1–7 are shipped. Phase 8 is unblocked — depends only on existing NATS infrastructure.

---

## Improvements Over Current Design

| Area | Before | After |
|---|---|---|
| Agent build | componentize-py → jco → agent.js (minutes) | No build step (run agent.py directly) |
| Async capability calls | Blocked (sync WIT bindings only) | Native asyncio + NATS request/reply |
| Concurrent LLM calls | Deadlock if attempted | Works: independent reply subjects |
| Session event replay | Fixed in-memory ring buffer | NATS JetStream durable replay |
| Cross-workspace signals | Impossible | `nc.publish(signals.{targetWs}.{signal})` |
| Multi-daemon | Single process only | NATS subjects are shared across daemons |
| Agent language | Python WASM only | Python, TypeScript, any NATS client |
| Observability | Logs only | NATS monitoring UI + subject tracing |
| Cron across daemons | In-process timer, single node | NATS scheduled delivery |

---

## Risks & Mitigations

**`nats-server` binary availability**
- Dev: `brew install nats-server` or auto-download via daemon init script
- Prod: add to Dockerfile
- Mitigation: daemon fails fast with clear error if `nats-server` not found

**Existing workspaces using `type: code`**
- Audit complete: no workspaces remain. `chat-unify-exec` and `fast-improvements-source` were deleted. Phase 4 can proceed without workspace migration.

**Security regression: WASM sandbox → OS subprocess**
- Current WASM execution has no filesystem or network access by design.
- `ProcessAgentExecutor` spawns a real Python process with full OS access.
- **Decision: accepted.** Friday is a local tool; this is the same model as Cursor, Claude Code, and similar. Long-term, proper sandboxing will come from an execution environment like minimal.dev — not something we build ourselves.

**Python subprocess startup latency (~200-500ms)**
- Each `ProcessAgentExecutor.execute()` call cold-starts a Python process (import nats, import agent.py, connect to NATS).
- The WASM model preloaded agent.js once per executor instance — this is a regression.
- **Known tradeoff:** spawn-per-call enforces statelessness by design; this is the goal.
- **Phase 8 (future):** subprocess pool — keep N warm Python processes subscribed to a queue group on `agents.pool.execute`; executor routes to pool instead of spawning. Restores latency parity without compromising statelessness (pool processes discard all state after each call via explicit reset).

**`nats.py` asyncio vs existing sync handlers**
- `asyncio.to_thread()` wraps sync handlers transparently
- Mitigation: test all existing agents in `agents/` with the new SDK before Phase 4

**NATS connection loss mid-execution**
- Agent subprocess loses capability back-channel
- Mitigation: NATS client auto-reconnect; capability requests retry up to 3x with backoff

**Session event ordering**
- NATS publish order matches delivery order for a single subject
- Mitigation: include sequence number in each event; JetStream guarantees delivery order

**Testing strategy: Python SDK without running NATS**
- Agent integration tests should not require a live `nats-server`.
- Approach: abstract capability calls behind a `CapabilityClient` protocol. Test fixtures provide a mock `CapabilityClient` that records calls and returns canned responses. The NATS client is the prod implementation; mocks cover unit tests.
- `conftest.py` pattern:
  ```python
  @pytest.fixture
  def mock_caps():
      return MockCapabilityClient(responses={
          "llm.generate": {"text": "mocked response"},
      })
  ```
- End-to-end SDK tests spin up `nats-server` via subprocess in a pytest session fixture and run the full bridge loop.

---

## Out of Scope (Future)

- **Subprocess pool** — N warm processes on `agents.pool.execute` queue group; restores startup latency without breaking statelessness. Gate on performance data from Phase 8 rollout.
- **Streaming LLM capability** — `caps.{sid}.llm.stream.*` subject pattern for token-by-token streaming back to the agent. Requires design work on NATS-based streaming (JetStream push or multiple replies).
- **Agent identity / capability allowlists** — per-agent NATS accounts or subject-level ACLs to prevent agents from subscribing to other sessions' caps subjects.
- NATS-based auth/AuthN (NATS accounts/nkeys for agent identity)
- NATS cluster / multi-region
- Moving agent registry to NATS KV store
- Full multi-daemon horizontal scaling (Phase 6 enables it, but load balancing and workspace affinity are separate work)
- Execution sandboxing — deferred to a purpose-built environment (e.g. minimal.dev); not something we build in-house
