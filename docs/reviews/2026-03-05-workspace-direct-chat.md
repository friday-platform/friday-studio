# Review: feat/workspace-chat

**Date:** 2026-03-05
**Branch:** feat/workspace-chat
**Verdict:** Needs Work

## Summary

Adds workspace-scoped direct chat: a new `workspace-chat` agent, signal-based
invocation through the standard pipeline, workspace-scoped chat storage, and
frontend integration. The architecture is sound — standalone agent, signal
pipeline reuse, subdirectory-based storage isolation, thin `do_task` wrapper. Two
critical gaps need attention: job tools fire-and-forget instead of blocking until
completion, and the 7 new HTTP endpoints plus the 521-line agent orchestrator
have zero test coverage.

## Critical

### 1. Job tools fire-and-forget instead of blocking until completion

**Location:** `packages/system/agents/workspace-chat/tools/job-tools.ts:57-62`

The plan requires job tools to "block until `session.waitForCompletion()`" and
return session results. The implementation fires an HTTP signal trigger via
`client.workspace[":workspaceId"].signals[":signalId"].$post`, which returns
immediately with `{ sessionId, message: "Signal accepted for processing" }`.

The LLM receives "triggered successfully" and tells the user the job is done
when it's still executing. For a "add grocery item" use case, the user is told
the item was added before it actually was.

**Recommendation:** Use `WorkspaceRuntime.executeJobDirectly(jobName, { payload:
inputs })` as the plan specifies — direct call, no HTTP roundtrip, blocks until
completion.

### 2. No tests for workspace chat route handlers

**Location:** `apps/atlasd/routes/workspaces/chat.ts` (298 lines, 7 endpoints)

POST `/`, GET `/`, GET `/:chatId`, GET `/:chatId/stream`, DELETE
`/:chatId/stream`, POST `/:chatId/message`, PATCH `/:chatId/title` — all
untested. The existing config route tests demonstrate the exact pattern that
should be followed.

**Recommendation:** Add `apps/atlasd/routes/workspaces/chat.test.ts` covering
validation, 404 handling, stream lifecycle, and title updates.

### 3. Job tools tests skip the execute callback

**Location:** `packages/system/agents/workspace-chat/tools/job-tools.test.ts`

Tests validate tool generation (descriptions, schema selection, filtering) but
never invoke `execute()`. The execute callback makes HTTP calls, handles
error/success branching, and returns structured results — the behavioral core of
the feature is completely untested.

**Recommendation:** Add tests that call `tool.execute()` for both happy path and
error path.

## Important

### 4. `workspaceMCPServers` is dead code

**Location:** `packages/system/agents/conversation/tools/do-task/index.ts:246`,
`packages/system/agents/workspace-chat/tools/do-task.ts:44`

`DoTaskWorkspaceContext.workspaceMCPServers` is defined, set, but never read.
Only `workspaceAgents` is consumed. Creates the appearance of MCP server
integration that doesn't exist.

**Recommendation:** Remove the field, or add a `// TODO` if it's a planned
future addition.

### 5. `finalize()` can race with in-flight `appendEvent` writes

**Location:** `apps/atlasd/src/session-event-stream.ts:95-98`

The `flush()` mechanism was removed. `emit()` fires `appendEvent` as
fire-and-forget, and `finalize()` calls `adapter.save()` immediately. Since
`save()` receives the full in-memory `events` array, this is only a problem if
the adapter relies on `appendEvent` for partial recovery.

**Recommendation:** Document the relationship — if `save()` supersedes
`appendEvent`, the fire-and-forget `appendEvent` calls are overhead. If
`appendEvent` serves crash recovery, the flush mechanism should be preserved.

### 6. Workspace-chat agent has zero tests

**Location:** `packages/system/agents/workspace-chat/workspace-chat.agent.ts`
(521 lines)

The orchestrator handles chat history, system prompt construction, tool
assembly, LLM streaming, persistence, and title generation — all untested. The
pure functions (`formatWorkspaceSection`, `getSystemPrompt`,
`generateChatTitle`) are extractable and testable without mocking the LLM.

### 7. Runtime chat injection test misses FSM validation

**Location:** `packages/workspace/src/runtime-chat-injection.test.ts`

Test verifies `handle-chat` job exists with correct name/description but doesn't
validate the FSM definition (states, transitions, agent action). If someone
changes the FSM structure, the test still passes.

**Recommendation:** Add assertions for `chatJob.signals` and FSM state
structure.

### 8. Duplicate `describe("finalize")` block

**Location:** `apps/atlasd/src/session-event-stream.test.ts:263` and `:324`

Two `describe("finalize")` blocks. The second (added during CI fix) only tests
`adapter.save` was called once — a strict subset of the first block which
already tests save arguments, subscriber closing, and active state.

**Recommendation:** Delete the second block (lines 324-334).

## Tests

**Verdict: Weak-to-Missing**

| File | Status |
|------|--------|
| `storage.test.ts` | Solid — thorough integration tests with real FS |
| `session-stream-registry.test.ts` | Solid — appropriate for simplified impl |
| `config.test.ts` / signals / credentials | Solid — comprehensive, pre-existing |
| `job-tools.test.ts` | Weak — tests schema generation, not execution |
| `runtime-chat-injection.test.ts` | Weak — tests existence, not behavior |
| `session-event-stream.test.ts` | Weak — ordering guarantees removed, dupe block |
| `routes/workspaces/chat.ts` | Missing — zero tests for 7 endpoints |
| `workspace-chat.agent.ts` | Missing — zero tests for 521-line orchestrator |

The chat storage tests are exemplary (real FS, isolation, concurrent writes,
corrupted data). The rest need work.

## Needs Decision

1. **Job tool execution model:** Fire-and-forget (current) vs blocking
   (planned). This fundamentally changes UX — "job triggered" vs "job completed
   with results." Is fire-and-forget intentional for MVP, or an oversight?

2. **`workspaceMCPServers` field:** Keep as placeholder for future work, or
   remove as dead code? The plan says "Workspace MCP servers added to available
   pool" — is this deferred or forgotten?

3. **`appendEvent` fire-and-forget after flush removal:** Is `appendEvent` only
   for crash recovery (needs flush), or is `save()` the sole durability
   mechanism (appendEvent is overhead)?

4. **Test coverage before merge:** The route handlers and agent orchestrator are
   the highest-risk code. Is the team comfortable merging without route tests,
   or should at minimum the route handlers be tested first?
