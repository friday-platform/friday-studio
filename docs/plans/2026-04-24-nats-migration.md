# NATS Migration Plan

**Date:** 2026-04-24
**Scope:** Replace FSM code execution (Deno workers) + daemon coordination with NATS; rewrite Python agent SDK from WASM to NATS subprocess model.

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
# Agent capability back-channel (scoped per session)
caps.{sessionId}.llm.generate       → request/reply
caps.{sessionId}.http.fetch         → request/reply
caps.{sessionId}.tools.call         → request/reply
caps.{sessionId}.tools.list         → request/reply

# Agent execution result
agents.{sessionId}.result           → publish (agent → daemon)

# Session lifecycle events (JetStream durable)
sessions.{sessionId}.events         → publish (daemon OR agent → subscribers)

# Signal routing
signals.{workspaceId}.{signalId}    → publish (HTTP handler → runtime)

# Session control
sessions.{sessionId}.cancel         → publish (HTTP → runtime)

# Code executor (replaces WorkerExecutor — see Phase 4)
exec.run                            → request/reply (daemon → executor service)
```

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

## Phase 2: Python Agent SDK Rewrite

**Goal:** `friday_agent_sdk` becomes a NATS client. No WASM, no build step. Public API identical.

**Files changed (all in `packages/sdk-python/friday_agent_sdk/`):**

### `_bridge.py` → NATS entry point

The WIT bridge becomes a NATS subscriber that:
1. Connects to NATS (`NATS_URL` env var, default `nats://localhost:4222`)
2. Subscribes to `agents.{sessionId}.execute` (session ID from `ATLAS_SESSION_ID` env var)
3. Calls handler, returns result

```python
# friday_agent_sdk/_bridge.py
import asyncio, json, os
from nats.aio.client import Client as NATS

async def _run():
    nc = await NATS().connect(os.environ.get("NATS_URL", "nats://localhost:4222"))
    session_id = os.environ["ATLAS_SESSION_ID"]

    async def on_execute(msg):
        payload = json.loads(msg.data)
        prompt = payload["prompt"]
        context_raw = payload["context"]

        ctx = build_context(context_raw, nc, session_id)
        reg = get_registered_agent()

        try:
            result = await _call_handler(reg.handler, prompt, ctx)
            response = _serialize_result(result)
        except Exception as e:
            response = {"tag": "err", "val": str(e)}

        await msg.respond(json.dumps(response).encode())
        await nc.drain()

    sub = await nc.subscribe(f"agents.{session_id}.execute")
    # single-shot: handle one message then exit (spawn-per-call)
    msg = await sub.next_msg(timeout=30)
    await on_execute(msg)

def run():
    asyncio.run(_run())
```

### `_context.py` → NATS capability calls

Capability stubs replace WIT calls with NATS request/reply:

```python
# friday_agent_sdk/_context.py
def build_context(raw: dict, nc, session_id: str) -> AgentContext:
    async def llm_generate(request_json: str) -> str:
        resp = await nc.request(
            f"caps.{session_id}.llm.generate",
            request_json.encode(),
            timeout=120,
        )
        return resp.data.decode()

    async def http_fetch(request_json: str) -> str:
        resp = await nc.request(
            f"caps.{session_id}.http.fetch",
            request_json.encode(),
            timeout=60,
        )
        return resp.data.decode()

    async def stream_emit(chunk: dict) -> None:
        # Agent publishes directly to session events — no daemon roundtrip
        await nc.publish(
            f"sessions.{session_id}.events",
            json.dumps(chunk).encode(),
        )

    # ... tools similarly
    return AgentContext(
        env=raw.get("env", {}),
        config=raw.get("config", {}),
        session=...,
        llm=Llm(llm_generate, ...),
        http=Http(http_fetch),
        tools=Tools(...),
        stream=StreamEmitter(stream_emit),
    )
```

**Sync handler compatibility:**
Existing handlers are `def execute(prompt, ctx)` (sync). Since the NATS loop is asyncio, wrap sync handlers:
```python
async def _call_handler(handler, prompt, ctx):
    if asyncio.iscoroutinefunction(handler):
        return await handler(prompt, ctx)
    return await asyncio.to_thread(handler, prompt, ctx)
```

**Existing agent.py changes needed:** One line added at the bottom:
```python
if __name__ == "__main__":
    from friday_agent_sdk import run
    run()
```

**Remove:**
- `wit/agent.wit`
- All `try: from wit_world.imports import ...` blocks
- `pyproject.toml` build dependencies: `componentize-py`, `wasmtime`
- `componentize-py` call in `deno task agent build`

**Update skill: `.claude/skills/writing-friday-agents/`**
This skill is the canonical guide for writing Python agents. It currently documents the WASM build flow (`deno task agent build`, `agent.js`, WIT bindings). Rewrite in full for the NATS model:
- Entry point is `agent.py`, no build step
- `if __name__ == "__main__": from friday_agent_sdk import run; run()` replaces the WASM export
- `ctx.llm`, `ctx.http`, `ctx.tools`, `ctx.stream` API unchanged — just works async-natively now
- Remove all references to `componentize-py`, `wasmtime`, `agent.js`, `source:` WASM path in `workspace.yml`
- Update `workspace.yml` agent registration example: `source: ./agents/my-agent/agent.py`
- Update references in `SKILL.md`, `references/capabilities.md`, `references/sandbox-constraints.md`, `references/structured-output.md`

**Tests:** All existing tests in `packages/sdk-python/tests/` should pass unchanged — they test the public API and mock the capability layer. Update `conftest.py` to mock NATS instead of WIT.

---

## Phase 3: Process Agent Executor (Daemon Side)

**Goal:** Replace `CodeAgentExecutor` (WASM dynamic import) with `ProcessAgentExecutor` (subprocess + NATS capabilities).

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

## Sequencing & Dependencies

```
Phase 1 (NATS infra)
  └─ Phase 2 (Python SDK) ── can test independently with nats-server running
  └─ Phase 3 (Process executor) ── depends on Phase 1 + 2
       └─ Phase 4 (Remove code actions) ── depends on Phase 3 + workspace audit
  └─ Phase 5 (Session events) ── depends on Phase 1; parallel with 2/3
  └─ Phase 6 (Signal routing) ── depends on Phase 1 + 5
       └─ Phase 7 (TS SDK) ── depends on Phase 1 + 3 (protocol established)
```

Phases 2, 5, 6 can proceed in parallel once Phase 1 is done. Phase 4 is gated on workspace audit + Phase 3 completion.

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

- **Phase 8: Subprocess pool** — N warm Python processes on `agents.pool.execute` queue group; restores startup latency without breaking statelessness. Gate on performance data from Phase 3 rollout.
- NATS-based auth/AuthN (use NATS accounts/nkeys for agent identity)
- NATS cluster / multi-region
- Moving agent registry to NATS KV store
- Full multi-daemon horizontal scaling (Phase 6 enables it, but load balancing and workspace affinity are separate work)
- Execution sandboxing — deferred to a purpose-built environment (e.g. minimal.dev); not something we build in-house
