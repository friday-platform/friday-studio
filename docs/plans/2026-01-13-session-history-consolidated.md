# Session History: Consolidated Design & Implementation Status

**Date:** 2026-01-13 **Status:** Implementation Complete **PR:**
`fix-session-history-view` **Epic:** fix-session-history-view-hah

---

## Overview

This document consolidates three incremental design documents into a single
source of truth for the session history feature. It reflects the actual
implementation state as of PR completion.

**What this feature delivers:**

1. **FSM event capture and persistence** - All FSM execution events persisted
   for post-hoc debugging
2. **Step-oriented UI** - User-friendly view of multi-step agent executions
3. **Task session visibility** - `do_task` executions appear in session history
   with parent links
4. **Session CLI for agents** - Machine-parseable session data for AI agent
   debugging

---

## Problem Statement

PR #826 replaced the orchestration engine with FSM-based execution. This broke
session history because:

1. FSM events (`data-fsm-state-transition`, `data-fsm-action-execution`) only
   streamed to active connections - never persisted
2. Raw FSM events exposed internal plumbing users don't care about ("ACTION
   STARTED: code (prepare_ai_startup_news_researcher_request)")
3. `do_task` executions from conversation agents were invisible - no history, no
   debugging
4. No machine-readable interface for AI agents to debug other AI agents

**User expectation:**

```
Step 1: research (succeeded) - 11.9s
Step 2: email_digest_formatter (failed) - 5.8s
  Error: Cannot complete the task because...
```

---

## Architecture

### Data Flow

```
┌─────────────────┐    ┌───────────────────┐    ┌─────────────────────┐
│   FSMEngine     │───>│ WorkspaceRuntime  │───>│ SessionHistory      │
│                 │    │ (or fsm-executor) │    │ Storage             │
└─────────────────┘    └───────────────────┘    └─────────────────────┘
        │                       │                        │
        │ onEvent callback      │ collectedFsmEvents[]   │
        │  - transitions        │ mapFsmEventToSession() │
        │  - actions            │                        │
        │  - tool calls         ▼                        ▼
        │  - tool results       ┌───────────────────────────────────┐
        └──────────────────────>│ Session Events:                   │
                                │  - fsm-transition                 │
                                │  - fsm-action                     │
                                │  - agent-tool-call                │
                                │  - agent-tool-result              │
                                │  - session-finish (with output)   │
                                └───────────────────────────────────┘
```

```
┌─────────────────────┐    ┌────────────────────┐    ┌─────────────────┐
│ SessionHistory      │───>│ buildSessionDigest │───>│ Consumers       │
│ Storage             │    │                    │    │                 │
└─────────────────────┘    └────────────────────┘    │ - Web UI        │
        │                           │                │ - CLI           │
        │ loadSessionTimeline()     │                │ - API           │
        │                           ▼                └─────────────────┘
        │                  ┌─────────────────┐
        │                  │ SessionDigest   │
        │                  │  - input        │
        └─────────────────>│  - output       │
                           │  - steps[]      │
                           │  - errors[]     │
                           └─────────────────┘
```

---

## Implementation Status

### Feature 1: FSM Event Capture and Persistence

| Component                         | Status | Location                                        |
| --------------------------------- | ------ | ----------------------------------------------- |
| FSM engine emits action events    | Done   | `packages/fsm-engine/fsm-engine.ts`             |
| FSM engine emits tool events      | Done   | `emitToolEvents()` method                       |
| FSM engine emits `inputSnapshot`  | Done   | `findRequestDocument()` for task context        |
| FSM engine emits failed status    | Done   | Catch block in action execution                 |
| Workspace runtime captures events | Done   | `src/core/workspace-runtime.ts:642-650`         |
| Event mapper                      | Done   | `packages/core/src/session/fsm-event-mapper.ts` |
| Batch persistence                 | Done   | `persistSessionToHistory()`                     |

**Events captured:**

- `data-fsm-state-transition` - State machine path
- `data-fsm-action-execution` - Step execution with `inputSnapshot.task`
- `data-fsm-tool-call` - Tool invocations with args
- `data-fsm-tool-result` - Tool results/errors

### Feature 2: Step-Oriented UI

| Component               | Status | Location                                                               |
| ----------------------- | ------ | ---------------------------------------------------------------------- |
| StepGroup type          | Done   | `apps/web-client/src/lib/utils/session-timeline.ts`                    |
| groupEventsIntoSteps()  | Done   | Same file                                                              |
| buildToolCallsByAgent() | Done   | Same file                                                              |
| StepCard.svelte         | Done   | `apps/web-client/src/lib/components/session-timeline/step-card.svelte` |
| Multi-mode rendering    | Done   | `timeline-main.svelte`                                                 |
| Session detail pages    | Done   | Both `/sessions/[id]` and `/spaces/[id]/sessions/[id]`                 |

**UI features:**

- Collapsible step cards with melt-ui
- Auto-expand failed steps
- Status icons (check/close/progress)
- Duration display (ms/s/m formatting)
- Task description from `inputSnapshot`
- Error display with red styling
- Expandable tool calls with args and results

### Feature 3: Task Session Visibility

| Component                  | Status | Location                                               |
| -------------------------- | ------ | ------------------------------------------------------ |
| Schema fields              | Done   | `packages/core/src/session/history-storage.ts:433-436` |
| Task session persistence   | Done   | `fsm-executor-direct.ts:persistTaskSession()`          |
| Parent chat title fetch    | Done   | Via `ChatStorage.getChat()`                            |
| Session output persistence | Done   | In `session-finish` event and `markSessionComplete()`  |
| Parent link in UI          | Done   | `details-column.svelte:29-37`                          |

**Schema additions:**

```typescript
interface SessionHistoryMetadata {
  // ... existing fields
  parentStreamId?: string; // chatId for navigation to /chat/{id}
  parentTitle?: string; // Denormalized from ChatStorage
  sessionType?: "conversation" | "task";
}
```

### Feature 4: Session CLI for Agents

| Component                    | Status | Location                                            |
| ---------------------------- | ------ | --------------------------------------------------- |
| buildSessionDigest()         | Done   | `packages/core/src/session/build-session-digest.ts` |
| Session history API          | Done   | `apps/atlasd/routes/sessions/history.ts`            |
| `atlas session history`      | Done   | `src/cli/commands/session/history.tsx`              |
| `atlas session inspect <id>` | Done   | `src/cli/commands/session/inspect.tsx`              |
| Integration tests            | Done   | `src/cli/commands/session/session-commands.test.ts` |

**CLI commands:**

```bash
# List recent sessions (NDJSON)
atlas session history             # Default 25 sessions
atlas session history --limit 10  # Limit results
atlas session history --type task # Filter by sessionType

# View specific session (full digest)
atlas session inspect <id>        # JSON with input, output, steps, tool calls
```

**Digest output format:**

```json
{
  "id": "session-uuid",
  "status": "completed",
  "type": "task",
  "durationMs": 17720,
  "input": {
    "task": "Research AI startup funding...",
    "signalPayload": { ... }
  },
  "output": { ... },
  "steps": [
    {
      "step": 1,
      "state": "step_0",
      "agent": "researcher",
      "status": "completed",
      "durationMs": 11900,
      "task": "Research latest AI startup funding...",
      "toolCalls": [
        { "tool": "web_search", "args": {...}, "result": "..." }
      ]
    }
  ],
  "errors": []
}
```

---

## Files Changed (Complete List)

### Core Infrastructure

| File                                                | Change                                                                                                         |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `packages/fsm-engine/fsm-engine.ts`                 | `getActionId()`, failed event emission, `findRequestDocument()`, `inputSnapshot`, `emitToolEvents()`           |
| `packages/fsm-engine/types.ts`                      | `inputSnapshot` field, tool event types                                                                        |
| `packages/agent-sdk/src/messages.ts`                | `inputSnapshot` in Zod schema for streaming validation                                                         |
| `packages/core/src/session/history-storage.ts`      | `fsm-transition`, `fsm-action` types, `parentStreamId`, `parentTitle`, `sessionType`, output in session-finish |
| `packages/core/src/session/fsm-event-mapper.ts`     | New - extracted mapper function                                                                                |
| `packages/core/src/session/build-session-digest.ts` | New - digest builder for API/CLI                                                                               |

### Backend

| File                                                                       | Change                                                                                                      |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `src/core/workspace-runtime.ts`                                            | Event capture (including tool events), `mapFsmEventToSessionEvent()`, batch persistence, output persistence |
| `packages/system/agents/conversation/tools/do-task/fsm-executor-direct.ts` | Task session persistence with parent metadata, output storage                                               |
| `apps/atlasd/routes/sessions/history.ts`                                   | Return digest format from API                                                                               |

### CLI

| File                                   | Change                     |
| -------------------------------------- | -------------------------- |
| `src/cli/commands/session.ts`          | Parent command structure   |
| `src/cli/commands/session/history.tsx` | New - NDJSON list output   |
| `src/cli/commands/session/inspect.tsx` | New - digest detail output |

### Frontend

| File                                                                             | Change                                                                                 |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `apps/web-client/src/lib/utils/session-timeline.ts`                              | `StepGroup`, `ToolCallWithResult`, `groupEventsIntoSteps()`, `buildToolCallsByAgent()` |
| `apps/web-client/src/lib/components/session-timeline/step-card.svelte`           | New component                                                                          |
| `apps/web-client/src/lib/components/session-timeline/timeline-main.svelte`       | Multi-mode rendering                                                                   |
| `apps/web-client/src/lib/modules/sessions/table-columns/details-column.svelte`   | Parent link for task sessions                                                          |
| `apps/web-client/src/routes/(app)/sessions/[sessionId]/+page.svelte`             | Use digest API                                                                         |
| `apps/web-client/src/routes/(app)/spaces/[id]/sessions/[sessionId]/+page.svelte` | Use digest API                                                                         |

### Deleted (Legacy)

| File                       | Reason                          |
| -------------------------- | ------------------------------- |
| `agent-event.svelte`       | Replaced by step-card           |
| `event-group.svelte`       | Replaced by step-card           |
| `event-item.svelte`        | Unused                          |
| `phase-event.svelte`       | Replaced by step-card           |
| `tool-call-section.svelte` | Integrated into step-card       |
| `fsm-event.svelte`         | Intermediate component, removed |

---

## Test Coverage

### Backend Tests

| Test File                                                                       | Coverage                                                                                           |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `packages/fsm-engine/tests/fsm.test.ts`                                         | `getActionId()` for all action types, failed event emission, `inputSnapshot` for agent/llm actions |
| `packages/core/src/session/history-storage.test.ts`                             | Zod schema validation for all new fields                                                           |
| `packages/core/src/session/build-session-digest.test.ts`                        | Digest building, step grouping, tool call pairing, edge cases                                      |
| `src/core/workspace-runtime-fsm-persistence.test.ts`                            | Event capture, persistence, chronological ordering                                                 |
| `packages/system/agents/conversation/tools/do-task/fsm-executor-direct.test.ts` | Task session persistence                                                                           |
| `src/cli/commands/session/session-commands.test.ts`                             | CLI integration tests                                                                              |

### Test Scenarios

- FSM events display in correct chronological order
- Error states (agent errors, failed actions, validation failures)
- Empty state handling
- Tool call pairing by `toolCallId`
- Step grouping filters `step_N` pattern, ignores internal states
- Retry safety (multiple started events for same action)
- NDJSON format validity
- Digest field completeness

---

## Backwards Compatibility

All new fields are optional with graceful fallbacks:

| Scenario                          | Behavior                                            |
| --------------------------------- | --------------------------------------------------- |
| Sessions without `inputSnapshot`  | "No task description available" in task section     |
| Sessions without `output`         | `output: undefined` in digest                       |
| Sessions without `parentStreamId` | No parent link shown                                |
| Non-`step_N` state names          | Falls back to step-oriented view with generic names |
| No agent/llm actions              | Still shows transitions and any tool calls          |

No migration required. Existing sessions render normally.

---

## Design Decisions

### Why denormalize parent title?

Store `parentTitle` at write time instead of joining at read time because:

- Simpler read path, no joins
- Parent title is stable (rarely changes)
- Task created after parent exists, title available
- Acceptable staleness tradeoff

### Why `parentStreamId` not `parentSessionId`?

Navigation needs `/chat/{chatId}`. The conversation's `sessionId` (FSM execution
ID) differs from its `chatId` (UI identifier). Since `chatId === streamId`, we
store `parentStreamId`.

### Why flat list with links vs nested hierarchy?

Flat with links because:

- Simplest implementation
- Task sessions are first-class for debugging
- Link provides context without complicating list
- Can add filtering later

### Why `atlas session history/inspect` vs `atlas session [id]`?

Original design wanted `atlas session` (list) and `atlas session <id>` (detail).
Implementation uses explicit subcommands for consistency with other CLI
patterns. Functionally equivalent, just more explicit.

---

## Known Limitations

1. **Failed task sessions not persisted** - If `fsm-executor-direct.ts` throws
   mid-execution, no session record is created. Hard failures leave no trace.
   (Intentional: fail fast behavior)

2. **No `--human` flag** - Design doc mentioned human-readable output mode for
   CLI. Not implemented. YAGNI - agents prefer JSON.

3. **Session output truncation** - While digest doesn't truncate output, very
   large outputs may hit memory limits. No explicit size cap yet.

---

## Future Enhancements (Deferred)

From original designs, explicitly deferred as YAGNI:

- Show output documents/artifacts for completed steps
- Filtering by step status in UI
- Collapsible "Show full FSM trace" for debugging
- Real-time updates for in-progress steps
- `--raw` flag for untruncated CLI output
- `--step N` flag for single step detail
- `--lineage` / parent traversal
- `--fsm-trace` with full state machine path

Add when usage patterns emerge.
