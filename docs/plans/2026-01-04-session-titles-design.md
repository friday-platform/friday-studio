<!-- v2 - 2026-01-04 - Generated via design-review swarm from docs/plans/2026-01-04-session-titles-design.md -->

# Session Titles Design

**Date:** 2026-01-04 **Status:** Draft

Generate human-readable titles for persisted session history using the small
LLM, so the web UI shows descriptive names instead of UUIDs.

## Non-Goals (Explicit)

- Manual title editing
- Title regeneration
- Batch backfill of existing sessions
- Titles for in-progress (active/partial) sessions
- Changing how session history events are recorded

## Overview

Sessions in the web UI currently display `sessionId` (UUID), even though history
records include richer data like `jobSpecificationId`, `signal`, and `summary`.
This design adds a dedicated `title` field to session history metadata,
generated asynchronously after session completion.

**Data Flow:**

```
Session completes in WorkspaceRuntime.processSignalForJob()
    ↓
WorkspaceRuntime.persistSessionToHistory() creates session JSON file
    ↓
Fire-and-forget: generateSessionTitle() called (does not block)
    ↓
SessionHistoryStorage.updateSessionTitle() writes title to stored metadata
    ↓
Web client displays title (fallback to sessionId)
```

**Key Decisions:**

- Fire-and-forget: Title generation never blocks or fails session completion
- Fallback: If LLM fails, generate deterministic title from jobName/signalId
- Timing: Title generation starts AFTER session file exists (avoids ENOENT race)

## Title Generation

New file: `packages/llm/src/session-title.ts`

```typescript
import { smallLLM } from "./small.ts";

export interface GenerateSessionTitleInput {
  signal: {
    type: string;
    id: string;
    data?: Record<string, unknown>;
  };
  output: unknown;
  status: "completed" | "failed";
  jobName?: string;
}

/**
 * Generate a human-readable title for a session.
 * Falls back to deterministic title if LLM fails or returns garbage.
 */
export async function generateSessionTitle(
  input: GenerateSessionTitleInput,
): Promise<string> {
  try {
    const system =
      `Generate a short title (max 60 chars) for an AI agent session.
Use noun-phrase style like email subjects: "Daily Startup News Digest", "Stripe Webhook Processing".
${
        input.status === "failed"
          ? "Prefix with 'Failed:', e.g. 'Failed: Email Report Generation'"
          : ""
      }
Return ONLY the title, no quotes or explanation.`;

    const signalDataStr = input.signal.data
      ? JSON.stringify(input.signal.data, null, 2).slice(0, 300)
      : "{}";

    const outputStr = input.output
      ? JSON.stringify(input.output, null, 2).slice(0, 500)
      : "{}";

    const prompt = `Signal: ${input.signal.id}
${input.jobName ? `Job: ${input.jobName}\n` : ""}Data: ${signalDataStr}
Output: ${outputStr}`;

    const title = await smallLLM({
      system,
      prompt,
      maxOutputTokens: 30,
    });

    const cleaned = title.trim().slice(0, 60);

    // Sanity check - if LLM returns garbage, use fallback
    if (cleaned.length >= 3) return cleaned;

    return generateFallbackTitle(input);
  } catch {
    // LLM failed - use deterministic fallback
    return generateFallbackTitle(input);
  }
}

function generateFallbackTitle(input: GenerateSessionTitleInput): string {
  const prefix = input.status === "failed" ? "Failed: " : "";
  const base = input.jobName || input.signal.id;
  const humanized = base
    .replace(/[-_]/g, " ")
    .replace(/^\w/, (c) => c.toUpperCase());
  return `${prefix}${humanized}`.slice(0, 60);
}
```

**Notes:**

- Truncates signal/output aggressively (300/500 chars) to minimize tokens
- Hard caps at 60 chars as safety net
- Failed sessions get "Failed: ..." prefix via prompt
- `maxOutputTokens: 30` keeps responses terse
- Fallback humanizes signal ID: `"daily-report"` → `"Daily report"`

## Schema Changes

**`packages/core/src/session/history-storage.ts`**

### Add title field to StoredSessionSchema (~line 356)

```typescript
const StoredSessionSchema = z.object({
  // ... existing fields
  title: z.string().optional(), // NEW
});
```

Note: `SessionHistoryMetadata` derives from `StoredSession` via
`Omit<StoredSession, "events">`, so `title` automatically propagates.

### Add title to SessionHistoryListItem (~line 380)

```typescript
export interface SessionHistoryListItem {
  sessionId: string;
  workspaceId: string;
  status: ReasoningResultStatusType;
  createdAt: string;
  updatedAt: string;
  summary?: string;
  title?: string; // NEW
}
```

### Add updateSessionTitle function (~line 593)

```typescript
export async function updateSessionTitle(
  sessionId: string,
  title: string,
): Promise<Result<void, string>> {
  try {
    await ensureSessionDir();
    const sessionFile = getSessionFile(sessionId);

    using file = await Deno.open(sessionFile, { read: true, write: true });
    await file.lock(true);

    const session = await readAndValidateSession(sessionFile);
    session.title = title;
    // Note: NOT updating updatedAt to avoid mtime-based list reordering

    await writeFile(sessionFile, JSON.stringify(session, null, 2), "utf-8");
    return success(undefined);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return fail("Session not found");
    }
    return fail(stringifyError(error));
  }
}
```

### Update listSessions mapping (~line 650)

```typescript
sessions.push({
  sessionId: session.sessionId,
  workspaceId: session.workspaceId,
  status: session.status,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
  summary: session.summary,
  title: session.title, // NEW
});
```

### Export updateSessionTitle (~line 748)

```typescript
export const SessionHistoryStorage = {
  createSessionRecord,
  appendSessionEvent,
  markSessionComplete,
  getSessionMetadata,
  listSessions,
  loadSessionTimeline,
  updateSessionTitle, // NEW
  toAgentSnapshot,
  toToolCallEvent,
  toToolResultEvent,
};
```

## WorkspaceRuntime Integration

**`src/core/workspace-runtime.ts`**

Hook into `persistSessionToHistory()` AFTER `createSessionRecord()` succeeds
(~line 1348).

This timing is critical: the session JSON file must exist before we try to
update it with a title.

```typescript
// Inside persistSessionToHistory(), after createResult succeeds (~line 1348)
if (!createResult.ok) {
  logger.error("Failed to create session record", { ... });
  return;
}

// Fire-and-forget title generation - don't block persistence
this.generateAndStoreTitle(sessionResult.id, {
  signal: {
    type: signal.type,
    id: signal.id,
    data: signal.data,
  },
  output: sessionResult.artifacts,
  status: sessionResult.status === "completed" ? "completed" : "failed",
  jobName: job.name,
}).catch((err) => {
  logger.warn("Failed to generate session title", {
    sessionId: sessionResult.id,
    error: err,
  });
});

// Continue with existing session-start event, etc.
```

Add private method to WorkspaceRuntime class:

```typescript
private async generateAndStoreTitle(
  sessionId: string,
  input: GenerateSessionTitleInput
): Promise<void> {
  const title = await generateSessionTitle(input);
  const result = await SessionHistoryStorage.updateSessionTitle(sessionId, title);
  if (!result.ok) {
    logger.warn("Failed to store session title", { sessionId, error: result.error });
  }
}
```

Add import at top of file:

```typescript
import {
  generateSessionTitle,
  type GenerateSessionTitleInput,
} from "@atlas/llm";
```

## API Response

**`apps/atlasd/routes/sessions/history.ts`**

No changes needed. The `listSessions` endpoint already spreads
`SessionHistoryListItem` fields, so `title` will automatically be included when
present:

```typescript
const sessions = result.data.sessions.map((s) => ({
  ...s, // includes title when present
  workspaceName: workspaceNames.get(s.workspaceId),
}));
```

The `loadSessionTimeline` endpoint returns full session metadata which includes
`title`.

## Web Client Changes

### List Views (DetailsColumn)

**`apps/web-client/src/lib/modules/sessions/table-columns/details-column.svelte`**

```svelte
<script lang="ts">
type Props = {
  job: string;
  title?: string;
  summary: string;
  workspaceName?: string
};

let { job, title, summary, workspaceName }: Props = $props();

const displayTitle = $derived(title ?? job);
</script>

<div class="component">
  <div class="header">
    <div class="group author">
      {#if workspaceName}{workspaceName} • {/if}{displayTitle}
    </div>
  </div>

  <div class="details">
    <span class="message">{summary}</span>
  </div>
</div>
```

### List Page Type Updates

**`apps/web-client/src/routes/(app)/sessions/+page.svelte`**

Update column helper type:

```typescript
const columnHelper = createColumnHelper<{
  sessionId: string;
  workspaceId: string;
  workspaceName?: string;
  status: ReasoningResultStatusType;
  createdAt: string;
  updatedAt: string;
  summary?: string;
  title?: string; // NEW
}>();
```

Update cell renderer:

```typescript
cell: (info) => {
  return renderComponent(DetailsColumn, {
    job: info.row.original.sessionId,
    title: info.row.original.title,
    summary: info.row.original.summary ?? "",
    workspaceName: info.row.original.workspaceName,
  });
},
```

Apply same changes to
`apps/web-client/src/routes/(app)/spaces/[id]/sessions/+page.svelte`.

### Detail Pages

**`apps/web-client/src/routes/(app)/sessions/[sessionId]/+page.svelte`**

```svelte
<!-- Before -->
<h1>{data.session.metadata.sessionId}</h1>

<!-- After -->
<h1>{data.session.metadata.title ?? data.session.metadata.sessionId}</h1>
```

Apply same change to
`apps/web-client/src/routes/(app)/spaces/[id]/sessions/[sessionId]/+page.svelte`.

## UI Display Logic

```
List views:
  title exists → show title
  else         → show sessionId

Detail pages:
  title exists → show title
  else         → show sessionId

Status badge is separate and unchanged (shows completed/failed/partial)
```

Note: "In Progress..." state is only meaningful for active sessions, which
aren't persisted to history. All history sessions are terminal
(completed/failed/cancelled), so no "In Progress..." logic is needed.

## Failure Modes & Edge Cases

### LLM Unavailable

- `smallLLM()` throws → caught, fallback title generated
- No retry - fire-and-forget is intentional
- Session remains fully functional, just with generated fallback title

### updateSessionTitle Fails

- Logged as warning, doesn't affect session
- Session shows sessionId in UI (graceful degradation)

### Title Generation Timing

- Async generation means users may briefly see sessionId after completion
- Subsequent page loads/refreshes show title
- Acceptable tradeoff for not blocking session completion

### Existing Sessions

- Sessions created before this feature have no `title` field
- UI falls back to `sessionId` display
- No migration or backfill (YAGNI)

### List Ordering Note

- `listSessions()` sorts by file mtime
- Title updates don't change `updatedAt`, so ordering is stable
- If mtime-based ordering becomes an issue, switch to `createdAt` sort later

## Implementation Checklist

**Files to create:**

1. `packages/llm/src/session-title.ts` - Title generation function

**Files to modify:** 2. `packages/llm/mod.ts` - Export `generateSessionTitle`
and `GenerateSessionTitleInput` 3.
`packages/core/src/session/history-storage.ts` - Add `title` field to schemas,
`updateSessionTitle()`, update `listSessions()` mapping 4.
`src/core/workspace-runtime.ts` - Import and call title generation in
`persistSessionToHistory()` 5.
`apps/web-client/src/lib/modules/sessions/table-columns/details-column.svelte` -
Add `title` prop 6. `apps/web-client/src/routes/(app)/sessions/+page.svelte` -
Update type, pass `title` to column 7.
`apps/web-client/src/routes/(app)/spaces/[id]/sessions/+page.svelte` - Update
type, pass `title` to column 8.
`apps/web-client/src/routes/(app)/sessions/[sessionId]/+page.svelte` - Display
title with fallback 9.
`apps/web-client/src/routes/(app)/spaces/[id]/sessions/[sessionId]/+page.svelte` -
Display title with fallback
