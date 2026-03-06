# Review: simplify-mcp-stuff (Pass 2)

**Date:** 2026-03-04
**Branch:** simplify-mcp-stuff
**Verdict:** Clean

## Summary

Replaces ~3400 lines of MCP connection pooling (GlobalMCPServerPool, MCPManager,
MCPServerRegistry, MCPToolProvider) with a single 240-line `createMCPTools()`
function. All four call sites wired correctly with proper lifecycle management.
Architecture is sound, tests are solid (19 unit + integration tests), and the
deletion-to-addition ratio (-3624/+1566) speaks for itself. Previous review
findings (`mergeServerConfigs` precedence gap) were addressed.

## Critical

None.

## Important

### Unused `@opentelemetry/api` dependency in `@atlas/mcp`

**Location:** `packages/mcp/package.json:13`
**Problem:** `@opentelemetry/api` is listed as a runtime dependency but never
imported in any package source file. Leftover from deleted `withMCPSpan` /
`withLLMToolSpan` telemetry code.
**Recommendation:** Remove from dependencies.

### `vitest` and `zod` listed as runtime dependencies

**Location:** `packages/mcp/package.json:14-16`
**Problem:** Neither is imported in production source (`create-mcp-tools.ts`).
Only used in test files. Inaccurate metadata — not a runtime issue in Deno
workspace but misleading.
**Recommendation:** Move to `devDependencies` or remove (Deno resolves
transitively for tests).

### Tool name collision warning path untested

**Location:** `packages/mcp/src/create-mcp-tools.ts:59-65`
**Problem:** When two servers expose a tool with the same name, the code warns
and silently overwrites (last-server-wins via `Object.assign`). No test exercises
this branch. Commit `d4a57535a` added the warning code but no test.
**Recommendation:** Add a test with two servers returning overlapping tool names.
Assert: (1) warning logged with correct metadata, (2) second server's tool wins,
(3) first server's tool is gone.

### `error.serverName` already-set branch untested

**Location:** `packages/mcp/src/create-mcp-tools.ts:84-98`
**Problem:** When a credential error already has `serverName` set, the code
correctly re-throws without double-enrichment. Both enrichment tests construct
errors without `serverName`, so this branch has zero coverage.
**Recommendation:** Add a test where `resolveEnvValues` rejects with a
`LinkCredentialNotFoundError` that already has `serverName` set. Assert the
thrown error is the original reference.

### Combined allow + deny filter untested

**Location:** `packages/mcp/src/create-mcp-tools.ts:233-237`
**Problem:** `filterTools` supports both `allow` and `deny` simultaneously, but
tests exercise them independently. The compound behavior (allow first, then deny
further filters) is untested.
**Recommendation:** Add a test with `tools: { allow: ["a", "b"], deny: ["b"] }`.
Assert only `a` survives.

## Tests

Tests are **solid** overall. 19 unit tests on `createMCPTools` cover happy path,
partial failure, credential propagation with cleanup, retry, stdio verification,
tool filtering, dispose idempotency, HTTP auth, and error resilience. Integration
tests at each call site verify wiring. Mock boundaries are correct (external
SDKs, transports, credential resolution). Mock ratios healthy (~60% real code,
40% setup).

Minor gaps (not blocking):
- `buildAuthHeaders` `process.env` fallback untested (trivial `??` coalescing)
- HTTP retry not directly tested (stdio retry tests prove the integration)

Deleted tests (`clarification.test.ts`, `mcp-server-pool.test.ts`,
`manager.test.ts`) map 1:1 to deleted implementations — no coverage regression.

## Needs Decision

1. **CANCEL during `preparing` can orphan MCP connections.** The `preparing`
   state handles CANCEL (line 353 of `agent-execution-machine.ts`) by
   transitioning to `ready`. If `buildAgentContext` (which calls
   `createMCPTools`) is mid-flight, XState cancels the invoke but the promise
   continues. When it resolves, `assignPreparedContext` never runs, so
   `releaseMCPTools` is never stored and MCP clients leak. Pre-existing issue,
   not introduced by this PR. Options: (a) remove the dead CANCEL handler (no
   caller sends CANCEL during preparing), or (b) add abort propagation to
   `buildAgentContext`.

2. **`client_config.timeout` silently dropped.** The old code respected
   per-server timeout configuration. `createMCPTools` ignores it. Users relying
   on per-server timeout tuning should know this was simplified away.
