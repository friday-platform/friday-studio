# Simplify MCP Connections

Shipped on `simplify-mcp-stuff` branch, March 2026.

Replaced the MCP connection pooling system (GlobalMCPServerPool, MCPManager,
ref counting, health checks, reconnection logic) with ephemeral per-execution
clients via a single `createMCPTools()` function in `@atlas/mcp`. Reduced
~3800 lines across 6+ modules to ~800 lines in one deep package.

## What Changed

### New: `@atlas/mcp` package — `createMCPTools()`

Single function that hides transport creation (stdio/HTTP), retry on initial
connection (3 attempts, linear backoff), credential resolution via
`@atlas/core/mcp-registry/credential-resolver`, per-server allow/deny tool
filtering, partial failure handling (warn + skip failed servers), and client
lifecycle (dispose kills all clients/subprocesses).

```typescript
interface MCPToolsResult {
  tools: Record<string, Tool>;
  dispose: () => Promise<void>;
}
```

Stdio servers get a verification call (`client.tools()`) after transport
creation since `createMCPClient` can succeed before the subprocess is ready.
HTTP transport init includes a handshake, so connection success is sufficient.

### Wired call sites

- **Agent path** (`agent-context/index.ts`): `mergeServerConfigs()` →
  `createMCPTools()` → `{ tools, dispose }`. Release callback calls
  `await dispose()` on XState `executing` state exit (covers completed, failed,
  AND cancelled transitions — fixing a pre-existing cleanup leak on cancel).

- **FSM path** (`fsm-engine.ts`): inline `createMCPTools()` call with
  atlas-platform injection + allowlist filtering. `dispose()` in `finally`
  block after `generateText`. `MCPToolProvider` interface and
  `GlobalMCPToolProvider` class deleted entirely.

- **do-task path** (`apps/atlasd/services/do-task/`): `GlobalMCPServerPool`
  instances replaced with `createMCPTools()` calls. Already had ephemeral
  semantics.

- **workspace-simulator** (`tools/workspace-simulator/`): `MCPManager` usage
  replaced with single `createMCPTools()` + `dispose()`.

### Deleted

- `GlobalMCPServerPool` class (ref counting, SHA-256 config hashing, deferred
  cleanup timers)
- `GlobalMCPToolProvider` class and `MCPToolProvider` interface
- `MCPManager` class (~750 lines) and `MCPServerRegistry` class (~523 lines)
- `packages/platform-tools` (zero dependents, dead code)
- `clarification.ts` + tests (dead code — real `formatClarifications` lives in
  workspace-builder)
- `withMCPSpan()` and `withLLMToolSpan()` telemetry helpers (only called from
  deleted code)
- `MCPClientWrapper` type, `verifyConnection()`, `connectHttpWithRetry()`
- Duplicate `MCPServerConfigSchema` in `packages/mcp` (agent-sdk definition
  survives)
- `mcpServerPool` param threaded through 5+ constructors

### Unchanged

- `packages/mcp-server` (platform MCP server — serves tools, doesn't acquire
  them)
- Static server catalog (`registry-consolidated.ts` in core)
- Registry schemas, credential resolver, storage adapters (all stay in core)
- Atlas-platform auto-injection behavior in both execution paths
- Custom MCP server support (workspace.yml and dynamic registry)

## Key Decisions

**Ephemeral over pooled.** Subprocess startup cost accepted as tradeoff for
eliminating shared state, ref counting, and leak-prone lifecycle management.
Unblocks isolated agent runtimes where agents can't share a pool.

**`@atlas/mcp` is client-only.** Static catalog, schemas, credential resolver
stay in `packages/core/src/mcp-registry/`. They serve 15+ consumers beyond MCP
connections. Clean dependency direction: `@atlas/mcp` → `@atlas/core`.

**No MCPToolProvider abstraction.** FSM engine calls `createMCPTools()` directly
instead of going through an interface. One implementation doesn't need an
abstraction layer.

**Telemetry intentionally dropped.** MCPManager's OpenTelemetry spans
(`withMCPSpan()`) weren't surfaced in any dashboard. Structured logging can be
added to `createMCPTools` if operationally needed.

**Per-action MCP lifecycle in FSM path.** Clients created and destroyed per
FSM action, not per job. Matches the isolation direction.

## Error Handling

Credential errors (`LinkCredentialNotFoundError`, `LinkCredentialExpiredError`)
re-throw immediately with user-facing messages. All other connection failures
are caught per-server — failed servers are warned and skipped, agent runs with
whatever tools connected successfully. Tool name collisions between servers
produce a warning log.

Dispose failures during cleanup after credential errors are caught to prevent
masking the original error.

## Out of Scope

- Platform MCP server changes (`packages/mcp-server`)
- HTTP-only MCP transport migration (stdio still supported)
- Agent runtime isolation (this unblocks it but doesn't implement it)
- Moving catalog/schemas/credential-resolver out of core

## Test Coverage

`createMCPTools` unit tests cover: happy path (multi-server connect + dispose),
partial failure, credential error propagation with cleanup, retry behavior,
stdio verification, tool filtering (allow/deny), dispose idempotency, and tool
name collision warnings.

Integration tests at each call site (agent-context, FSM engine, do-task)
verify the wiring — mocking `createMCPTools` at the module level.
