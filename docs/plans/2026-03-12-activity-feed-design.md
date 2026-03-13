## Problem Statement

Users have no centralized way to understand what Friday has been doing on their
behalf. Sessions exist but are workspace-scoped and technical. When a user
returns to the product after being away, they need a simple, time-ordered feed
that tells them what happened — which sessions ran, which resources changed, and
whether things succeeded or failed — without digging into individual workspaces.

## Solution

A new **Activity** data model and feed that captures notable events (completed
sessions, resource modifications) as human-friendly, time-ordered items. Each
item has an AI-generated or templated title, links to the source entity, and
tracks per-user read status for unread badge counts and notification dots.

## User Stories

1. As a user returning to the product, I want to see a chronological feed of
   what happened while I was away, so that I can quickly catch up
2. As a user, I want each activity item to link to the relevant session or
   resource, so that I can drill into details
3. As a user, I want to see an unread badge count on the sidebar Activity item,
   so that I know there are new things to review
4. As a user, I want visiting the Activity page to mark all visible items as
   read, so that the badge count resets
5. As a user, I want clicking an individual activity row to dismiss its
   notification dot, so that I can track what I've already reviewed
6. As a user, I want to filter activity by type (session/resource), workspace,
   and date range, so that I can focus on what matters
7. As a user, I want activity items for my own direct actions (uploading a file,
   replacing a resource) to appear in the feed but not trigger unread
   notifications, so that I'm not spammed by my own actions
8. As a user, I want session activity to only appear once the session is
   finished (completed or failed), so that the feed isn't cluttered with
   in-progress work
9. As a user, I want activity titles to be concise and human-friendly, so that I
   can scan the feed quickly without reading technical details
10. As a user, I want agent-driven activity to show descriptive titles based on
    what actually happened (not just "session completed"), so that the feed is
    informative
11. As a user, I want my own actions to show my name/identity in the title, so
    that in a future multi-user context other users understand who did what
12. As a user, I want new activity that arrives while I'm on the Activity page to
    remain unread, so that I don't miss items that came in after I loaded the page

## Implementation Decisions

### Data Model

**Activity table (SQLite):**

| Field         | Type                          | Notes                              |
|---------------|-------------------------------|------------------------------------|
| `id`          | string (ULID)                 | PK, sortable by creation time      |
| `type`        | `"session"` \| `"resource"`   | What happened                      |
| `source`      | `"agent"` \| `"user"`         | Who initiated it                   |
| `referenceId` | string                        | sessionId or resourceId            |
| `workspaceId` | string                        | Required                           |
| `jobId`       | string \| null                | For filtering/display              |
| `userId`      | string \| null                | Set for user actions, null for agent |
| `title`       | string                        | AI-generated or template           |
| `createdAt`   | ISO timestamp                 |                                    |

**activity_read_status table:**

| Field        | Type                          | Notes                |
|--------------|-------------------------------|----------------------|
| `userId`     | string                        | Composite PK         |
| `activityId` | string                        | Composite PK         |
| `status`     | `"viewed"` \| `"dismissed"`   | No row = unread      |

Index on `(userId)` for badge count queries.

No row in `activity_read_status` means "unread" for that user. Rows are only
inserted when status changes to `viewed` or `dismissed`. This avoids fan-out
writes on activity creation and scales naturally to multi-tenant.

For user-initiated activity (`source: "user"`), a `viewed` read status row is
inserted in the same transaction as the activity row, so the actor never sees
their own action as unread.

### Package Structure

New package: `packages/activity/`

- `mod.ts` — barrel export
- `schemas.ts` — Zod schemas (Activity, ActivityReadStatus, create/filter inputs)
- `storage.ts` — `ActivityStorageAdapter` interface
- `local-adapter.ts` — SQLite implementation
- `title-generator.ts` — AI title generation (agent) + templates (user)

### Storage Adapter Interface

```
ActivityStorageAdapter:
  create(input)               → Activity (insert + optional read status)
  list(userId, filters?)      → Activity[] with read status (joined)
  getUnreadCount(userId)      → number
  updateReadStatus(userId, activityIds, status)  → void (by IDs)
  markViewedBefore(userId, before: timestamp)    → void (by cursor)
```

### API Routes

Mounted at `/api/activity` in `apps/atlasd/routes/activity.ts`:

| Method | Path                    | Purpose                                    |
|--------|-------------------------|--------------------------------------------|
| GET    | `/api/activity`         | List activities (filter: type, workspaceId, date range) |
| GET    | `/api/activity/unread-count` | Sidebar badge count                   |
| POST   | `/api/activity/mark`    | Update read status                         |

The mark endpoint accepts two shapes:

- **By IDs:** `{ activityIds: string[], status: "viewed" | "dismissed" }` — for
  clicking individual rows
- **By timestamp:** `{ before: ISO timestamp, status: "viewed" }` — for marking
  all as read when visiting the page (no need to send all IDs)

No public create endpoint — activity is only created internally by hooks.

### Hook Points

**1. Session completion** — `packages/workspace/src/runtime.ts`

In the finally block of `processSignalForJob()`, after `sessionStream.finalize()`
completes. The session view and summary are already built at this point. Only
fires for terminal statuses (`completed` or `failed`).

Creates activity with:
- `type: "session"`, `source: "agent"`
- `referenceId: sessionId`
- `workspaceId`, `jobId` from session context
- `userId: null`
- Title: LLM-generated from session output and status

```typescript
// In runtime.ts processSignalForJob() finally block, after sessionStream.finalize():

await sessionStream.finalize(summaryV2).catch((err) => {
  logger.warn("Failed to finalize session stream", { sessionId, error: String(err) });
});

// --- Activity creation hook ---
if (view.status === "completed" || view.status === "failed") {
  try {
    const title = await generateActivityTitle({ type: "session", view, jobName: job.name });
    await activityStorage.create({
      type: "session",
      source: "agent",
      referenceId: sessionId,
      workspaceId: this.workspace.id,
      jobId: job.name,
      userId: null,
      title,
    });
  } catch (err) {
    logger.warn("Failed to create session activity", { sessionId, error: String(err) });
  }
}
```

**2. Resource auto-publish** — `packages/resources/src/publish-hook.ts`

Currently `publishAllDirty()` returns only a count. To create per-resource
activity items, this needs to be extended to return metadata about each
published resource. Two options:

- **Option A:** Change `publishAllDirty` to return
  `Array<{ resourceId, slug, name, workspaceId }>` instead of `number` — clean
  but touches the adapter interface.
- **Option B:** Call `listResources()` before and after to diff — avoids
  interface change but adds a query.

Recommended: **Option A** — the adapter already knows which resources it
published, so returning their metadata is minimal overhead.

The hook also needs `jobId` context, which is not currently available in
`publishDirtyDrafts()`. The function signature will need to accept an optional
context object.

```typescript
// Updated publish-hook.ts signature:
export async function publishDirtyDrafts(
  adapter: ResourceStorageAdapter,
  workspaceId: string,
  context?: { jobId?: string; activityStorage?: ActivityStorageAdapter },
): Promise<void> {
  try {
    const published = await adapter.publishAllDirty(workspaceId);
    if (published.length > 0) {
      logger.debug("Auto-published dirty drafts", { workspaceId, count: published.length });

      // --- Activity creation hook ---
      if (context?.activityStorage) {
        for (const resource of published) {
          try {
            const title = await generateActivityTitle({
              type: "resource",
              resourceName: resource.name,
              resourceSlug: resource.slug,
            });
            await context.activityStorage.create({
              type: "resource",
              source: "agent",
              referenceId: resource.resourceId,
              workspaceId,
              jobId: context.jobId ?? null,
              userId: null,
              title,
            });
          } catch (err) {
            logger.warn("Failed to create resource activity", {
              resourceId: resource.resourceId,
              error: String(err),
            });
          }
        }
      }
    }
  } catch (error) {
    logger.warn("Auto-publish failed for workspace", {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
```

**3. User resource actions** — `apps/atlasd/routes/workspaces/resources.ts`

In the upload, replace, delete, and link route handlers. Each handler creates
activity after the ledger operation succeeds, with an auto-inserted `viewed`
read status row.

```typescript
// Upload handler — after ledger.provision() returns metadata:
const metadata = await ledger.provision(workspaceId, { userId, slug, name, ... }, rows);

await activityStorage.create({
  type: "resource",
  source: "user",
  referenceId: metadata.id,
  workspaceId,
  jobId: null,
  userId,
  title: `{{user_id}} uploaded ${name}`,
});

return c.json({ resource: metadata }, 201);
```

```typescript
// Link handler — after ledger.provision() succeeds:
await ledger.provision(workspaceId, { userId, slug, name, ... }, { provider, ref: url, ... });

await activityStorage.create({
  type: "resource",
  source: "user",
  referenceId: slug, // provision doesn't return id for link, use slug
  workspaceId,
  jobId: null,
  userId,
  title: `{{user_id}} linked ${name}`,
});

return c.json({ slug, name, provider, ref: url }, 201);
```

```typescript
// Replace handler — after ledger.replaceVersion() succeeds:
await ledger.replaceVersion(workspaceId, slug, rows, schema);

await activityStorage.create({
  type: "resource",
  source: "user",
  referenceId: existing.metadata.id,
  workspaceId,
  jobId: null,
  userId,
  title: `{{user_id}} replaced ${existing.metadata.name}`,
});

const refreshed = await ledger.getResource(workspaceId, slug);
return c.json({ resource: refreshed?.metadata ?? null });
```

```typescript
// Delete handler — after ledger.deleteResource() succeeds:
await ledger.deleteResource(workspaceId, slug);

await activityStorage.create({
  type: "resource",
  source: "user",
  referenceId: existing.metadata.id,
  workspaceId,
  jobId: null,
  userId,
  title: `{{user_id}} deleted ${existing.metadata.name}`,
});

return c.json({ success: true });
```

Activity creation failures in all hooks are caught and logged — they must never
block the primary operation.

### Title Generation Strategy

Titles are generated in `packages/activity/src/title-generator.ts`. Uses
`smallLLM` from `@atlas/llm` (Groq-routed fast model, ~250 token cap) for
agent-driven titles. Follows the same pattern as `packages/llm/src/session-title.ts`
— never throws, falls back to a deterministic string on failure.

**Agent-driven session titles (`source: "agent"`, `type: "session"`):**

```typescript
import { smallLLM } from "@atlas/llm";

interface GenerateSessionActivityTitleInput {
  status: "completed" | "failed";
  jobName: string;
  agentNames: string[];
  stepOutputs: unknown[];
  error?: string;
  /** @internal Test-only: override LLM function */
  _llm?: typeof smallLLM;
}

async function generateSessionActivityTitle(
  input: GenerateSessionActivityTitleInput,
): Promise<string> {
  const llm = input._llm ?? smallLLM;
  try {
    const result = await llm({
      system: `You generate concise activity feed titles (under 80 chars) for completed agent sessions.
Focus on WHAT the agent accomplished or what went wrong, not process details.
Return ONLY the title text, no quotes, no explanation.
Do NOT include status words like "completed" or "failed" — the UI shows status separately.`,
      prompt: buildSessionPrompt(input),
      maxOutputTokens: 100,
    });
    const title = result.trim();
    return title.length >= 3 ? title : sessionFallbackTitle(input);
  } catch {
    return sessionFallbackTitle(input);
  }
}
```

Prompt input includes: job name, agent names, truncated step outputs (last
300 chars), and error message if failed. Prompts are intentionally rough — will
be iterated on with real data.

Fallback: `"<JobName> session <completed|failed>"` using the same kebab-to-
sentence-case conversion as `session-title.ts`.

**Agent-driven resource titles (`source: "agent"`, `type: "resource"`):**

```typescript
interface GenerateResourceActivityTitleInput {
  resourceName: string;
  resourceSlug: string;
  resourceType: "document" | "artifact_ref" | "external_ref";
  /** @internal Test-only: override LLM function */
  _llm?: typeof smallLLM;
}

async function generateResourceActivityTitle(
  input: GenerateResourceActivityTitleInput,
): Promise<string> {
  const llm = input._llm ?? smallLLM;
  try {
    const result = await llm({
      system: `You generate concise activity feed titles (under 80 chars) for resource updates.
Describe what changed in human terms. Return ONLY the title text, no quotes.`,
      prompt: `Resource "${input.resourceName}" (${input.resourceType}) was updated with a new version.`,
      maxOutputTokens: 100,
    });
    const title = result.trim();
    return title.length >= 3 ? title : `${input.resourceName} was updated`;
  } catch {
    return `${input.resourceName} was updated`;
  }
}
```

Fallback: `"<resource name> was updated"`.

**User-driven activity (`source: "user"`):** Static template, no LLM call.

```typescript
function generateUserActivityTitle(action: string, resourceName: string): string {
  return `{{user_id}} ${action} ${resourceName}`;
}
```

Actions: `uploaded`, `replaced`, `deleted`, `linked`

The `{{user_id}}` placeholder is resolved at render time by the client — "You"
for the current user, display name for others (future multi-tenant).

**Test seam:** All generator functions accept an optional `_llm` parameter to
inject a mock LLM in tests, following the pattern established in
`session-title.ts`.

## Testing Decisions

Tests should verify external behavior, not implementation details.

### Adapter tests — `packages/activity/src/local-adapter.test.ts`

Follow the pattern in `packages/skills/src/local-adapter.test.ts`: real SQLite
database in a temp directory, created in `beforeEach`, cleaned up in
`afterEach`.

```typescript
let adapter: LocalActivityAdapter;
let dbPath: string;

beforeEach(() => {
  dbPath = join(tmpdir(), `activity-test-${Date.now()}.db`);
  adapter = new LocalActivityAdapter(dbPath);
});

afterEach(() => {
  try { rmSync(dbPath); } catch { /* ignore */ }
});
```

Test cases:
- Create activity and retrieve via list
- List with type/workspaceId/date filters
- Unread count returns correct number (no read status row = unread)
- `updateReadStatus` inserts viewed/dismissed rows, changes unread count
- `markViewedBefore` marks all items before timestamp, leaves newer items unread
- User-initiated activity with auto-viewed: unread count is 0 for that user
- Fixtures validated against production Zod schemas (never use `as` casts)

### Route tests — `apps/atlasd/routes/activity.test.ts`

Follow the pattern in `apps/atlasd/routes/workspaces/resources.test.ts`: mock
`AppContext` with a `createTestApp()` factory, mock `ActivityStorageAdapter`
with `vi.fn()` typed methods, test via `app.request()`. Parse all responses
through Zod schemas.

```typescript
function createMockActivityAdapter(
  overrides: Partial<ActivityStorageAdapter> = {},
): ActivityStorageAdapter {
  return {
    create: vi.fn<ActivityStorageAdapter["create"]>().mockResolvedValue({ id: "test" }),
    list: vi.fn<ActivityStorageAdapter["list"]>().mockResolvedValue([]),
    getUnreadCount: vi.fn<ActivityStorageAdapter["getUnreadCount"]>().mockResolvedValue(0),
    updateReadStatus: vi.fn<ActivityStorageAdapter["updateReadStatus"]>(),
    markViewedBefore: vi.fn<ActivityStorageAdapter["markViewedBefore"]>(),
    ...overrides,
  };
}

function createTestApp(overrides: Partial<ActivityStorageAdapter> = {}) {
  const activity = createMockActivityAdapter(overrides);
  const app = new Hono<AppVariables>();
  app.use("*", async (c, next) => {
    c.set("app", { ...mockContext, getActivityAdapter: () => activity });
    await next();
  });
  app.route("/", activityRoutes);
  return { app, activity };
}
```

Test cases:
- `GET /api/activity` returns list, respects query filters
- `GET /api/activity/unread-count` returns `{ count: number }`
- `POST /api/activity/mark` with `{ activityIds, status }` calls
  `updateReadStatus`
- `POST /api/activity/mark` with `{ before, status }` calls
  `markViewedBefore`
- `POST /api/activity/mark` with invalid body returns 400

### Title generator tests — `packages/activity/src/title-generator.test.ts`

Mock the LLM call (`vi.mock` the model provider). Verify:
- Session title generation passes correct context to prompt
- Resource title generation passes correct context to prompt
- User template returns `"{{user_id}} <action> <resource name>"`
- LLM failure falls back to a simple descriptive string (never throws)

### Hook tests

Not separate integration tests — covered by the route tests (user actions) and
adapter tests (create behavior). The hook wiring itself is thin glue code that
calls `activityStorage.create()` in a try/catch — testing it in isolation would
just be testing mocks.

## Out of Scope

- Active/in-progress session display (separate UI section)
- Activity page UI implementation (separate ticket, screenshot provided for
  reference)
- Sidebar badge UI component
- Client-side notification dot rendering
- Real-time activity updates (SSE/WebSocket push)
- Activity retention/cleanup policies
- Activity for non-resource, non-session events (conversations, workspace
  config changes, etc.)
- Prompt tuning for AI-generated titles

## Further Notes

- The `source` field is designed to be extensible — future values like `"cron"`,
  `"webhook"`, `"system"` can be added without schema changes.
- The read status model (no row = unread) avoids fan-out writes and is
  multi-tenant ready. When adding users to a workspace, all existing activity is
  automatically "unread" for them.
- ULID primary keys provide time-sortable IDs without a separate index on
  `createdAt` for the default sort order.
- The `{{user_id}}` template pattern in user-driven titles keeps stored data
  user-agnostic, supporting future multi-tenant name resolution at render time.
