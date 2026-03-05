# Review: feat/workspace-chat

**Date:** 2026-03-04 **Branch:** feat/workspace-chat **Verdict:** Needs Work

## Summary

New standalone workspace-chat agent (514 lines), 7 HTTP endpoints (298 lines),
auto-injected chat signal, job-as-tool transformation, workspace-scoped chat
storage. Architecture is sound — clean separation between route, agent, storage,
and runtime layers, faithful to the plan. Critical issues resolved. Remaining:
one design decision (job tool blocking) and test coverage gaps.

## Critical

None remaining.

## Important

### ~~1. System prompt references tools that aren't registered~~ RESOLVED

Added `display_artifact` and `artifacts_get` to workspace-chat agent tool surface via `artifact-tools.ts`.

### ~~2. `classifySessionError` drops credential error classification~~ RESOLVED

Restored `hasUnusableCredentialCause → SKIPPED` check. Was accidental removal, not intentional.

### ~~3. `Deno.rename` introduced — violates node:\* builtins rule~~ RESOLVED

Restored `node:fs/promises` `rename`. Main already had the fix.

### ~~4. Job tools are fire-and-forget — plan says blocking~~ RESOLVED

Intentional MVP tradeoff. Fire-and-forget is the desired behavior for now.

### ~~5. Non-null assertions in ChatStorage~~ RESOLVED

Replaced `workspaceId!` with `&&` truthiness narrowing.

### ~~6. `buildAgentPrompt` signature change + resource removal~~ RESOLVED

Restored `buildAgentPrompt` 7-param signature (resourceAdapter, workspaceId,
artifactStorage), resource guidance block, `publishDirtyDrafts` calls in
runtime.ts, and daemon Ledger client wiring (`resourceStorage` property,
`createLedgerClient()` init, `getLedgerAdapter()` on AppContext).

### ~~7. Dead code in session-details.svelte~~ RESOLVED

Removed ~46 lines: commented-out tags, unused CSS, unused status prop.

## Tests

**Verdict: Weak** — Tests exist and protect real behavior where they cover, but
critical paths are untested.

### What's tested (solid)

- **Chat signal injection** — reserved name collision, auto-injection,
  `atlas-conversation` skip (3 tests)
- **Job-tool creation** — trigger signal inclusion, triggerless skip,
  `handle-chat` exclusion, schema fallback/passthrough (5 tests)
- **Chat storage** — subdirectory storage, cross-workspace isolation,
  per-workspace listing, global list exclusion
- **Stream registry** — simplification after `flush()` removal

### What's NOT tested (gaps)

| Gap                                                                       | Severity  | Lines uncovered |
| ------------------------------------------------------------------------- | --------- | --------------- |
| Workspace-chat route handlers (7 endpoints)                               | Critical  | 298             |
| Workspace-chat agent (handler, prompt assembly, title gen, tool assembly) | Critical  | 514             |
| Job-tool `execute()` path (HTTP call, error handling, result shaping)     | Important | ~25             |
| `createWorkspaceDoTask` wrapper (workspace context extraction)            | Important | 48              |
| `deleteChat` and `updateChatTitle` error paths                            | Important | ~30             |
| Chat isolation with same chatId in different workspaces                   | Important | —               |
| Signal-to-job wiring verification (runtime-chat-injection)                | Important | —               |

### Test quality notes

- `session-stream-registry.test.ts` removed flush-related tests without
  documenting that eviction now drops pending writes
- `storage.test.ts` uses `setTimeout(50)` for mtime ordering — fragile on fast
  filesystems

## Needs Decision

1. ~~**Job tool blocking vs fire-and-forget**~~ RESOLVED — fire-and-forget is
   intentional for MVP.

2. ~~**Resource/ledger removal scope**~~ RESOLVED — credential classification
   restored; resource guidance and Ledger wiring restored to match main.

## Previously Resolved

Items from earlier review passes, kept for audit trail:

- ~~`listChats` underscore filter breaks global sidebar~~ — switched to
  subdirectory approach
- ~~`setSystemPromptContext` missing `workspaceId`~~ — added third argument
- ~~Zero test coverage for job-tools generator~~ — 5 tests added
- ~~Chat signal reservation untested~~ — 3 tests added
- ~~ChatStorage workspace-scoped functions untested~~ — tests added
- ~~Chat file naming convention~~ — switched to subdirectories
- ~~Dead `message: ""` in signal payload~~ — removed from all locations
- ~~`as` assertion in chat stream callbacks~~ — addressed in commit 3e4046131
