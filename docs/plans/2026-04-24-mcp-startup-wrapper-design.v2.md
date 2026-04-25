<!-- v2 - 2026-04-24 - Generated via /improving-plans from docs/plans/2026-04-24-mcp-startup-wrapper-design.md -->

# MCP HTTP Auto-Spawn Startup Wrapper

## Problem Statement

Friday's MCP runtime supports two mutually exclusive transport modes: `stdio` (auto-spawns, no bearer tokens) and `http` (bearer tokens, no auto-spawn). Google Workspace MCP servers need both: they run as HTTP endpoints (`streamable-http`) that require OAuth bearer tokens, but we want Friday to auto-start them instead of requiring manual process management.

## Solution

Add a `startup` configuration field to `MCPServerConfigSchema` that specifies a command to spawn before connecting to an HTTP transport. Friday checks if the URL is reachable; if not, it spawns the command, polls for readiness, then proceeds with the normal HTTP connection. On dispose, all spawned child processes created by *this* `createMCPTools` invocation are SIGTERM'd.

## User Stories

1. As a Friday user, I want to add a Google Workspace MCP server to my workspace without manually starting processes, so that I don't need to remember port numbers or shell commands.
2. As a Friday engineer, I want the MCP config schema to support auto-spawn metadata, so that registry entries can encode both the connection URL and the command to start the server.
3. As a Friday engineer, I want bearer tokens to stay in HTTP headers only and never leak to child process environments, so that OAuth tokens aren't accidentally exposed to spawned server logs.
4. As a Friday user, I want clear, typed errors when an MCP server fails to start (command not found, port in use, timeout), so that I can diagnose configuration issues programmatically.
5. As a Friday engineer, I want spawned child processes cleaned up when the agent session ends, so that I don't accumulate orphaned workspace-mcp processes.
6. As a Friday engineer, I want startup and transport configuration to be orthogonal, so that we can add auto-spawn to any HTTP MCP server without changing the transport schema.
7. As a Friday user, I want workspace-mcp servers for Calendar, Gmail, Drive, Docs, and Sheets to all auto-start on their respective ports, so that I can use Google Workspace tools immediately after OAuth authorization.
8. As a Friday engineer, I want environment variables passed to the child process to support `${HOME}` and `${ATLAS_HOME}` interpolation, so that registry entries can reference portable paths.
9. As a Friday engineer, I want the poll URL to default to the transport URL so that most configurations don't need to specify it twice.
10. As a Friday engineer, I want a configurable ready timeout (default 30s) so that slow-starting servers don't block indefinitely.
11. As a Friday engineer, I want concurrent agents that need the same MCP server to gracefully fall back to an already-running instance rather than crashing with port-in-use errors.

## Implementation Decisions

### Modules Modified

- **`packages/agent-sdk/src/types.ts`** — Add `MCPStartupConfigSchema` and include `startup` as an optional field in `MCPServerConfigSchema`. Re-export through `packages/config/src/mcp.ts`.
- **`packages/mcp/src/create-mcp-tools.ts`** — Add spawn + poll + cleanup logic to `connectHttp`. Track spawned `ChildProcess` instances in a per-invocation `Set` (passed into `connectHttp`, returned in `ConnectedServer.child`) for disposal. Add `MCPStartupError`.
- **`packages/core/src/mcp-registry/registry-consolidated.ts`** — Add `startup` config to all 5 Google Workspace entries, replacing the manual launch instructions in `constraints`. Move `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, and other launch env vars into `startup.env`.

### Schema Changes

- `MCPStartupConfigSchema` fields:
  - `type` (literal `"command"`)
  - `command` (string)
  - `args` (optional string array)
  - `env` (optional `Record<string, EnvValueSchema>` — supports both plain strings and Link credential refs, resolved before spawn)
  - `ready_url` (optional string URL, defaults to transport URL)
  - `ready_timeout_ms` (optional positive int, default 30000)
  - `ready_interval_ms` (optional positive int, default 500)
- `MCPServerConfigSchema` gains `startup: MCPStartupConfigSchema.optional()`.

### API Contracts

- `connectHttp` behavior: if `config.startup` is present and the transport URL is not reachable (no 2xx response), spawn the command with merged env (`process.env` + `resolvedStartupEnv` with placeholder interpolation), then poll `ready_url` with `GET` requests until 2xx or timeout.
- `EADDRINUSE` fallback: if spawn fails with `EADDRINUSE`, re-check reachability on `ready_url`. If now reachable, use the existing server. Otherwise throw `MCPStartupError(kind: 'spawn')`.
- `dispose()` behavior: iterate all `ConnectedServer.child` processes for this invocation, send `SIGTERM`, wait 2s, send `SIGKILL` if still alive.
- Env separation: `config.env` is resolved via `resolveEnvValues` → `resolvedEnv` → used for HTTP auth headers **only**. `startup.env` is resolved via `resolveEnvValues` → `resolvedStartupEnv` → merged with `process.env` and passed to the child process **only**. No overlap.

### Error Types

```ts
export class MCPStartupError extends Error {
  constructor(
    public readonly kind: 'spawn' | 'timeout' | 'connect',
    public readonly serverId: string,
    public readonly command?: string,
    cause?: unknown,
  ) { ... }
}
```

- `kind: 'spawn'` — child_process failed to start (ENOENT, EADDRINUSE, etc.)
- `kind: 'timeout'` — `ready_url` did not respond with 2xx within `ready_timeout_ms`
- `kind: 'connect'` — spawn and poll succeeded, but the subsequent MCP HTTP connection failed

### Module Boundaries

**MCPStartupConfigSchema**
- **Interface:** Zod schema defining the shape of startup configuration.
- **Hides:** Default values, type constraints, and field descriptions.
- **Trust contract:** Parsed config is guaranteed to have all defaults applied and all fields typed correctly.

**connectHttp (augmented)**
- **Interface:** Same external signature — accepts `MCPServerConfig`, returns `Promise<ConnectedServer>`.
- **Hides:** Whether the server was already running, whether it was spawned, how polling works, child process tracking, env merging, interpolation, and the `EADDRINUSE` fallback.
- **Trust contract:** On success, the HTTP transport is connected and ready. On failure, throws `MCPStartupError` with a discriminable `kind`. No child processes leak on any failure path.

**Google Workspace registry entries**
- **Interface:** Same `MCPServerMetadata` shape with `configTemplate.startup` populated.
- **Hides:** The exact command, env vars, and port numbers needed to start each service.
- **Trust contract:** If the user has authorized the Link provider, Friday can auto-start and connect to the workspace-mcp instance without manual intervention.

## Data Isolation

Not applicable. No database tables touched.

## Testing Decisions

- **Unit test: `connectHttp` spawn path** — mock `child_process.spawn`, mock `fetch` for polling. Assert: spawn called with correct command/env, poll fires at interval, success path returns connected server, timeout path throws `MCPStartupError(kind: 'timeout')`.
- **Unit test: `connectHttp` skip path** — mock `fetch` to return 200 immediately. Assert: no spawn when URL already reachable.
- **Unit test: `connectHttp` EADDRINUSE fallback** — mock `fetch` to return 404 initially, mock `spawn` to emit `EADDRINUSE`, then mock `fetch` to return 200 on retry. Assert: no second spawn, server reused.
- **Unit test: env separation** — assert that `resolvedEnv` (containing bearer token) is never passed to `spawn` env, and `resolvedStartupEnv` (containing client ID/secret) is never used for HTTP headers.
- **Unit test: `startup.env` with Link refs** — mock `resolveEnvValues` to resolve a Link ref in `startup.env`. Assert: resolved value passed to child, not to HTTP headers.
- **Unit test: dispose cleanup** — mock `ChildProcess.kill`. Assert: `SIGTERM` called on all tracked children from this invocation only, `SIGKILL` called after grace period if needed. Verify children from a second `createMCPTools` call are not touched.
- **Unit test: error type enrichment** — assert that `MCPStartupError` carries `kind`, `serverId`, and `command` for all failure paths.
- **Integration test: Google Calendar entry** — validate that `registry-consolidated.ts` entry parses against `MCPServerMetadataSchema` and contains all required `startup` fields with `env` using plain strings (public OAuth client ID/secret).

Prior art: `packages/mcp/src/create-mcp-tools.ts` already has retry logic for stdio and HTTP. The spawn+poll pattern is similar to stdio's "verify subprocess responding" loop. Tests for `credential-resolver.ts` show how to mock `fetch` for Link resolution.

## Out of Scope

- Auto-restart of crashed servers after initial successful connection (handled by existing retry logic).
- Startup for `stdio` transport (not needed, stdio already auto-spawns).
- Cross-platform process manager integration (systemd, LaunchAgent).
- Shared server instances between concurrent agents (each agent spawns its own, but the `EADDRINUSE` fallback mitigates the collision).
- Health check endpoints other than HTTP GET/HEAD (no gRPC, no custom protocols).

## Further Notes

The `${HOME}` / `${ATLAS_HOME}` interpolation in `startup.env` reuses the existing `interpolateArg` helper from the stdio path, applied to each resolved env value before passing to `spawn`. This keeps path resolution consistent between stdio and HTTP+startup transports.

Google Workspace entries will use `ready_url: "http://localhost:<port>/mcp"` explicitly, even though it defaults to the transport URL, for clarity in the registry file.

The `startup` field is additive and optional. Existing HTTP entries without `startup` continue to work unchanged.

The `EADDRINUSE` fallback is a pragmatic v1 mitigation. A future iteration could introduce a workspace-level MCP process manager that shares instances across agents, but that requires session lifecycle coordination outside the scope of this plan.
