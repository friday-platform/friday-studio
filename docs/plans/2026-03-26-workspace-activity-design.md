## Problem Statement

Users have a global activity feed but no way to see activity scoped to a single
workspace. When working within a workspace, they want to see what happened
*there* — which sessions ran, which resources changed — without navigating to
the global feed and mentally filtering.

## Solution

Add workspace-level activity alongside the existing global feed:

1. Show the **6 most recent activity items** on the workspace overview page (main
   column, below Jobs), with an unread count badge above the workspace title
   linking to the full feed
2. Add a workspace **activity sub-page** at `/spaces/[spaceId]/activity` with
   full infinite-scroll feed (same UX as the global activity page, filtered to
   one workspace)
3. Add an "Activity" **sub-nav link** in the sidebar under each workspace
   (alongside "Conversations")

The global `/activity` page and its sidebar link remain unchanged.

## User Stories

1. As a user, I want to see the 6 most recent activity items on my workspace
   overview page, so I can catch up at a glance without leaving the page
2. As a user, I want an unread count badge above the workspace title that links
   to the full workspace activity feed, so I know there's new activity
3. As a user, I want a "View all" link on the workspace activity section that
   takes me to the full workspace activity feed
4. As a user, I want a full activity feed at `/spaces/[spaceId]/activity` showing
   all activity for that workspace with infinite scroll
5. As a user, I want visiting the workspace activity page to mark that
   workspace's items as viewed, so the unread count resets
6. As a user, I want seeing the workspace overview page (with the 6-item
   preview) to NOT mark items as viewed, so the badge persists until I
   explicitly visit the full activity page
7. As a user, I want clicking an individual activity row (on either the overview
   or the full page) to dismiss its blue dot — and that dismissal applies
   globally (also visible on the global activity page)
8. As a user, I want the workspace activity page to show the same columns and
   styling as the existing global activity page (minus the workspace name in the
   metadata line, since it's redundant)
9. As a user, I want the "Activity" sub-nav link to appear under each workspace
   in the sidebar (alongside "Conversations") when the workspace is expanded
10. As a user, I want `{{user_id}}` in activity titles to show as "You"

## Implementation Decisions

### Read status is global

Activity read status (`viewed` / `dismissed`) is per-activity-item, not
per-view. Once an item is marked as viewed or dismissed, that status applies
everywhere — the workspace overview, the workspace activity page, and the global
activity page all see the same state. There is no workspace-scoped read
tracking.

- **Viewing the workspace activity page** calls `markViewedBefore(before,
  workspaceId)` — marks that workspace's items as `viewed`
- **Viewing the workspace overview page** does NOT mark anything
- **Clicking an activity row** marks that item as `dismissed` — applies globally

### Backend Changes

#### Add workspace scoping to `markViewedBefore` and `getUnreadCount`

Both methods need an optional `workspaceId` parameter. The storage adapter plan
(`docs/plans/2026-03-18-activity-storage-adapter.md`) introduces three adapter
implementations and two route files, so changes propagate across all of them.

**Interface** (`packages/activity/src/storage.ts`):

```typescript
// markViewedBefore: add optional workspaceId
markViewedBefore(userId: string, before: string, workspaceId?: string): Promise<void>;

// getUnreadCount: add optional workspaceId
getUnreadCount(userId: string, workspaceId?: string): Promise<number>;
```

**Implementations — all three adapters:**

| Adapter | File | Change |
|---------|------|--------|
| `LocalActivityAdapter` | `packages/activity/src/local-adapter.ts` | Add optional `AND a.workspace_id = ?` to both queries |
| `ActivityPostgresAdapter` | `apps/ledger/src/activity-postgres-adapter.ts` | Same — optional workspace filter in SQL |
| `ActivityLedgerClient` | `packages/activity/src/ledger-client.ts` | Pass `workspaceId` as query/body param to Ledger HTTP routes |

**Routes — both daemon and Ledger:**

| Route file | Change |
|------------|--------|
| `apps/atlasd/routes/activity.ts` | Extend `MarkByTimestampSchema` and unread-count route |
| `apps/ledger/src/activity-routes.ts` | Same changes — mirror of daemon routes |

**Schema changes:**

```typescript
// MarkByTimestampSchema — add optional workspaceId
const MarkByTimestampSchema = z.object({
  before: z.string().datetime(),
  status: z.literal("viewed"),
  workspaceId: z.string().optional(),
});

// Unread count route — accept optional workspaceId query param
.get("/unread-count", zValidator("query", z.object({
  workspaceId: z.string().optional(),
})), async (c) => {
  const { workspaceId } = c.req.valid("query");
  const count = await adapter.getUnreadCount(auth.userId, workspaceId);
  return c.json({ count });
})
```

Omitting `workspaceId` in both cases preserves current behavior.

These are the only backend changes needed. The existing `GET /api/activity`
endpoint already supports `?workspaceId=X` filtering, and the existing
`POST /api/activity/mark` with `activityIds` works for row dismissals.

### Frontend Changes

#### 1. Workspace overview page — Activity in main column

Two changes to `routes/(app)/spaces/[spaceId]/+page.svelte`:

**Remove sidebar "Recent Activity":** Delete the `Page.Sidebar` section titled
"Recent Activity" (lines 224-258) that renders 3 recent sessions. Remove the
`listWorkspaceSessions` import, the `sessionsQuery`, and the `recentSessions`
derived value — they become unused.

**Add "Activity" section in `Page.Content`**, below the Jobs grid. This reuses
existing components — no new CSS needed:

- `Table.Root` from `$lib/components/table` — same table component used on the
  global activity page, with `hideHeader`, `rowSize="large"`, `rowPath`, and
  `onRowClick`
- `ActivityColumn` from `$lib/modules/activity/activity-column.svelte` — renders
  title (with `{{user_id}}` → "You"), relative time, and workspace dot. For the
  workspace overview, pass `workspaceName` as `undefined` to omit the redundant
  workspace name from the metadata line
- `UnreadDotColumn` from `$lib/modules/activity/unread-dot-column.svelte` —
  renders blue dot based on read status and freshness window

The table setup mirrors the global activity page
(`routes/(app)/activity/+page.svelte`) — same `createColumnHelper`,
`createTable`, `getCoreRowModel`, `renderComponent` pattern, just with a smaller
dataset.

**Data fetching:**
- Fetch via `listWorkspaceActivity(workspaceId, { limit: 6 })` from
  `$lib/queries/activity.ts` (new function, see section 3)
- Poll with `refetchInterval: 10_000` (matches existing jobs query)
- No mark-as-viewed on page load — viewing the overview does NOT mark items
- Clicking a row fires `markActivity({ activityIds: [id], status: "dismissed" })`

**Unread count badge:** Above the workspace title (in the header area), show a
badge with text like "1 update" / "3 updates" (pluralized), fetched from
`GET /api/activity/unread-count?workspaceId=X`. Badge links to
`/spaces/[spaceId]/activity`. Hidden when count is 0.

**Section header:** "Activity" heading with a "View all" link to
`/spaces/[spaceId]/activity`.

**Files changed:**
- `routes/(app)/spaces/[spaceId]/+page.svelte` — remove sidebar sessions,
  add main column activity section

**Files reused (no changes):**
- `$lib/modules/activity/activity-column.svelte`
- `$lib/modules/activity/unread-dot-column.svelte`
- `$lib/components/table/` (`Table.Root`)
- `$lib/queries/activity.ts` (new function added here, see section 3)

#### 2. Workspace activity sub-page (`/spaces/[spaceId]/activity`)

New SvelteKit route: `routes/(app)/spaces/[spaceId]/activity/+page.svelte`

Reuses the same infinite scroll + TanStack Table pattern as the existing global
activity page, but:

- Passes `workspaceId` filter to every `listActivity` call
- Omits workspace name/dot from the `ActivityColumn` metadata line (redundant
  when viewing a single workspace)
- On mount, fires
  `markActivity({ before: new Date().toISOString(), status: "viewed", workspaceId })`
  to mark only this workspace's items as viewed
- After mark completes, invalidate the workspace activity query so the overview
  badge updates

No `+page.ts` needed — the page accesses `workspaceId` from the parent layout
data (already available via `+layout.ts`).

#### 3. Activity query — workspace-filtered variant

Add to `src/lib/queries/activity.ts`:

```typescript
export async function listWorkspaceActivity(
  workspaceId: string,
  options?: { limit?: number; offset?: number },
): Promise<{ activities: ActivityWithReadStatus[]; hasMore: boolean }> {
  const query: Record<string, string> = { workspaceId };
  if (options?.limit) query.limit = String(options.limit);
  if (options?.offset) query.offset = String(options.offset);

  const res = await parseResult(client.activity.index.$get({ query }));
  if (!res.ok) throw new Error(`Failed to load activity: ${JSON.stringify(res.error)}`);
  return res.data;
}
```

Extend `markActivity` payload type to accept optional `workspaceId` on the
timestamp variant:

```typescript
export async function markActivity(
  payload:
    | { activityIds: string[]; status: "viewed" | "dismissed" }
    | { before: string; status: "viewed"; workspaceId?: string },
): Promise<void> { ... }
```

#### 4. Sidebar changes

**Add:** "Activity" sub-nav link under each active workspace (alongside
"Conversations"):

```svelte
{#if active}
  <ul class="sub-nav">
    <li>
      <a
        href={ctx.routes.spaces.item(space.id, "chat")}
        class:active={getActivePage(["chat/[[chatId]]"])}
      >
        Conversations
      </a>
    </li>
    <li>
      <a
        href={ctx.routes.spaces.item(space.id, "activity")}
        class:active={getActivePage(["activity"])}
      >
        Activity
      </a>
    </li>
  </ul>
{/if}
```

The global "Activity" link in the sidebar main-links remains unchanged.

### Module Boundaries

**Activity queries** (`queries/activity.ts`):
- **Interface:** `listActivity(offset?)`, `listWorkspaceActivity(id, opts?)`,
  `markActivity(payload)`
- **Hides:** HTTP client details, error shape parsing, query param serialization
- **Trust contract:** Returns parsed activity data or throws; mark calls are
  fire-and-forget from the caller's perspective

### No new routes config needed

The existing `spaces.item(spaceId, "activity")` route helper already produces
the correct `/spaces/[spaceId]/activity` path via the `view` parameter support
in `app-context.svelte.ts`.

## Testing Decisions

Tests should verify external behavior, not implementation details.

### Backend — adapter tests (local + Postgres)

- `markViewedBefore` with `workspaceId` only marks that workspace's items
- `markViewedBefore` without `workspaceId` marks all items (no regression)
- `getUnreadCount` with `workspaceId` returns workspace-scoped count
- `getUnreadCount` without `workspaceId` returns global count (no regression)

Prior art: `packages/activity/src/local-adapter.test.ts`

### Backend — route tests (daemon + Ledger)

- `POST /api/activity/mark` with `{ before, status, workspaceId }` calls
  `markViewedBefore` with workspace filter
- `GET /api/activity/unread-count?workspaceId=X` returns workspace-scoped count

Prior art: `apps/atlasd/routes/activity.test.ts`,
`apps/ledger/src/activity-routes.ts`

### Frontend — workspace activity preview

- Renders up to 6 activity items from API response
- Unread count badge shows correct count from unread-count endpoint
- Badge hidden when count is 0
- Empty state shown when no activity
- Click navigates to correct detail page based on type
- Does NOT fire mark-as-viewed on mount

### Frontend — workspace activity page

- Renders full activity feed filtered to workspace
- Fires mark-as-viewed with `workspaceId` on mount
- Infinite scroll pagination works
- Omits workspace name from metadata line

## Out of Scope

- Filters (Type, Date dropdowns) on workspace activity page
- Changes to the global `/activity` page or its sidebar link
- Changes to the SSE activity stream
- Notification preferences per workspace
- Real-time row insertion on the activity pages (existing polling is sufficient)

## Further Notes

- The `markViewedBefore` workspace filter is backwards-compatible — omitting
  `workspaceId` preserves current behavior.
- The workspace overview activity section is intentionally lightweight (no
  TanStack Table) — it's a preview, not a full listing. The full page uses the
  table.
- The unread count badge uses a dedicated endpoint for an exact count, separate
  from the 6-item preview fetch.
