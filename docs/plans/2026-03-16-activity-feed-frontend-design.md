## Problem Statement

Users have no centralized way to see what Friday has been doing. The existing
`/sessions` page only shows raw session data. Users returning after being away
need a simple, time-ordered feed of activity — sessions that ran, resources that
changed — with unread indicators so they know what's new.

Additionally, existing sessions predate the activity backend and have no
corresponding activity rows, so switching the listing to pull from the activity
API would show an empty feed for users with prior history.

**Backend context:** The activity backend is already implemented (see
`docs/plans/2026-03-12-activity-feed-design.md`). It provides three API
endpoints (`GET /api/activity`, `GET /api/activity/unread-count`,
`POST /api/activity/mark`), a data model with per-user read status tracking, and
hook points that create activity rows when sessions complete and resources are
published. This plan covers the frontend and the backfill migration.

## Solution

Replace the `/sessions` listing page with a new `/activity` feed that pulls from
the activity API. Show a sidebar badge with unread count. Backfill existing
sessions into the activity table as a one-time daemon startup migration.

## User Stories

1. As a user, I want to see a chronological feed at `/activity` showing what
   Friday has done, so I can catch up quickly
2. As a user, I want each activity row to show the title, relative time, and
   workspace name with its color dot, so I can scan the feed at a glance
3. As a user, I want a blue dot on unread activity items, so I know what's new
4. As a user, I want the blue dot to only appear on recent items (sessions < 3
   days, resources < 7 days) that I haven't dismissed, so old items don't
   clutter the feed with dots
5. As a user, I want clicking a session activity row to navigate to
   `/sessions/[sessionId]`, so I can see the full session detail
6. As a user, I want clicking a resource activity row to navigate to the library
   item page, so I can see the resource
7. As a user, I want a badge count on the sidebar "Activity" link showing how
   many unread items exist, so I know there's new activity without visiting the
   page
8. As a user, I want to see in-progress sessions in the activity feed with a
   "running" title, so I know something is happening right now
8a. As a user, I want the sidebar badge count to poll every 60 seconds, so it
    stays reasonably current without manual refresh
9. As a user, I want visiting the `/activity` page to automatically mark all
   current items as viewed, so the badge count resets
10. As a user, I want the sidebar badge to refresh immediately after items are
    marked as viewed, so it shows 0 right away
11. As a user, I want clicking an individual activity row to mark it as
    dismissed, so the blue dot disappears on that row
12. As a user, I want my existing sessions to appear in the activity feed even
    though they predate the activity system, so I don't lose history
13. As a user, I want the backfill to happen automatically on daemon startup
    without any manual action, so it just works
14. As a user, I want the empty state to say something helpful when there's no
    activity yet
15. As a user, I want the feed to load more items as I scroll down, so I can
    browse my full history
16. As a user, I want `/sessions` to redirect to `/activity`, so old
    bookmarks still work
17. As a user, I want `{{user_id}}` in activity titles to show as "You" for my
    own actions, so titles read naturally

## Implementation Decisions

### Route Structure

- New route: `/activity` — the activity feed listing page
- Keep: `/sessions/+page.ts` — redirect to `/activity`
- Keep: `/sessions/[sessionId]` — session detail page (unchanged)
- Keep: `/library/[artifactId]` — library item page (unchanged)
- Remove: `/sessions/+page.svelte` (the listing UI only)
- Update sidebar link from `ctx.routes.sessions.list` to the new activity route
- Update `app-context.svelte.ts` routes to add `activity.list`

### Activity Listing Page (`/activity`)

Feed-style layout matching the design mockup:

- Header: "Activity" title + "Catch up on whats happened recently" subtitle
- Table using TanStack Table + the existing `<Table.Root>` component, same
  pattern as the current sessions listing page
- Rows are clickable links: session type → `/sessions/[referenceId]`, resource
  type → `/library/[referenceId]`
- Infinite scroll pagination (see Pagination section below)
- Empty state when no activity items exist

### Table Structure

Use `createTable` / `createColumnHelper` from `@tanstack/svelte-table` with the
existing `<Table.Root>` component. The table has `hideHeader` (no column
headers), `rowSize="large"`, and `rowPath` for click-to-navigate.

Three columns:

1. **Activity column** (`columnHelper.display`, `id: "activity"`)
   - Custom `ActivityColumn` component rendered via `renderComponent()`
   - Contains: workspace `<Dot color={workspaceColor}>`, title text, and a
     metadata line with relative time + dot separator + workspace name
   - `{{user_id}}` in titles replaced with "You" at render time
   - `meta: { minWidth: "0" }` (flex to fill available space)

2. **Unread dot column** (`columnHelper.display`, `id: "unread"`)
   - Custom `UnreadDotColumn` component
   - Renders a blue filled dot when the item qualifies as unread:
     - `readStatus` is not `"dismissed"` (`"viewed"` still shows the dot —
       viewed only affects the sidebar badge, not the row indicator)
     - AND within freshness window: sessions < 3 days, resources < 7 days
   - `meta: { shrink: true, align: "center" }`

3. **Time column** (`columnHelper.accessor("createdAt")`)
   - Reuse existing `TimeColumn` from `$lib/modules/sessions/table-columns`
   - `meta: { align: "center", faded: true, shrink: true, size: "small" }`

`rowPath` resolves to `/sessions/[referenceId]` for session type,
`/library/[referenceId]` for resource type. `getRowId` uses the activity `id`.

### Workspace Lookup

The activity column needs workspace color and name. Fetch workspaces once via
the existing `listSpaces()` query and build a `Map<workspaceId, { name, color }>`
lookup. Pass this into the column components via `renderComponent()` props.

### Sidebar Badge

- Fetch unread count from `GET /api/activity/unread-count` via TanStack Query
  with `refetchInterval: 60_000` (polls every 60 seconds)
- Display as a count badge next to the "Activity" sidebar link (e.g. "35")
- After landing on `/activity` and marking all as viewed, invalidate/refetch the
  unread count query so the badge updates to 0 immediately

### Mark-as-Read Behavior

1. **Page load:** When `/activity` mounts, fire
   `POST /api/activity/mark { before: <now>, status: "viewed" }`. After
   success, invalidate the sidebar unread count query so the badge refreshes.
2. **Row click:** When clicking an activity row, fire
   `POST /api/activity/mark { activityIds: [id], status: "dismissed" }` before
   navigating to the detail page. This removes the blue dot on that row.

The distinction: `viewed` means "the user has seen the activity page" (clears
the sidebar badge). `dismissed` means "the user clicked into this specific item"
(clears the blue dot on the row).

### Pagination

Use `createInfiniteQuery` from TanStack Query with the `ScrollListener`
component, following the same pattern as the conversations list in the sidebar.

- Initial fetch: `GET /api/activity?limit=50`
- Load more on scroll: `GET /api/activity?limit=50&offset=<count>`
- `getNextPageParam` uses the `hasMore` flag from the API response
- `ScrollListener` wraps the feed list and triggers `fetchNextPage()` when the
  user scrolls near the bottom

### Data Fetching

- New query function in `src/lib/queries/activity.ts`:
  - `listActivity(offset)` — calls `GET /api/activity`, returns activity items
    with `hasMore` flag
  - `getUnreadCount()` — calls `GET /api/activity/unread-count`
  - `markActivity(payload)` — calls `POST /api/activity/mark`
- Page uses `createInfiniteQuery` with `listActivity` as the query function
- Workspaces fetched once (existing `listSpaces()` query) for the color/name
  lookup map
- Sidebar: `getUnreadCount()` polled every 60 seconds via `refetchInterval`

### `{{user_id}}` Title Resolution

Activity titles from user-initiated actions contain `{{user_id}}` as a
placeholder (e.g. `"{{user_id}} uploaded Monthly Report"`). At render time,
replace `{{user_id}}` with `"You"` for the current user. In a future
multi-tenant context this would resolve to the acting user's display name, but
for now all activity belongs to the current user.

### Backfill Migration

One-time daemon startup migration to populate activity rows for existing
sessions.

**When:** Runs at daemon startup, before the server starts accepting requests.

**Flag:** Store a `backfill_sessions_v1` row in a `migrations` table in the
activity SQLite database. Check this flag on startup — if present, skip entirely.
This is a backwards-compatibility migration for existing customers — it should
never run more than once.

```sql
CREATE TABLE IF NOT EXISTS migrations (
  name TEXT PRIMARY KEY,
  completed_at TEXT NOT NULL
);
```

**Process:**
1. Check if `backfill_sessions_v1` exists in `migrations` table → if yes, skip
2. List sessions via `SessionHistoryAdapter.listByWorkspace()` (no workspace
   filter — list all). Do NOT scan the filesystem directly.
3. For each session with `status: "completed"` or `status: "failed"`:
   - Check if an activity row with `reference_id = sessionId` already exists →
     skip if so
   - Generate title: use `aiSummary.summary` if available, otherwise fallback to
     `"{jobName} session {status}"` (sentence-cased)
   - Insert activity row with `type: "session"`, `source: "agent"`,
     `createdAt` from session's `startedAt` or `completedAt`
4. Insert `backfill_sessions_v1` into `migrations` table
5. Log count of backfilled items

**No LLM calls** — titles are derived from existing session metadata only.

### No Filters in V1

The design shows Type/Space/Date filter dropdowns but these are out of scope for
this phase. The API already supports filter params so adding them later is
straightforward.

## Testing Decisions

Tests should verify external behavior, not implementation details.

### Activity listing page

- Renders activity items from API response
- Empty state shown when no items
- Blue dot logic: shown for non-dismissed items within freshness window, hidden
  otherwise (viewed items still show the dot)
- `{{user_id}}` in titles renders as "You"
- Row click navigates to correct detail page based on type
- Page load triggers mark-all-viewed API call

### Sidebar badge

- Displays count from unread-count API
- Updates after mark-all-viewed completes

### Backfill migration

- Lists sessions via adapter and creates activity rows
- Uses `aiSummary.summary` for title when available, fallback template otherwise
- Skips sessions that already have activity rows
- Sets migration flag so it never runs twice
- Skips active/pending sessions (only backfills terminal statuses)

Prior art for frontend tests: existing session page tests if any, otherwise
follow patterns in `apps/web-client/src/lib/` test files.

Prior art for backfill tests: `packages/activity/src/local-adapter.test.ts`
pattern — real SQLite in temp dir.

## Out of Scope

- Filters (Type, Space, Date dropdowns)
- Real-time updates (SSE/WebSocket) for new activity
- Resource activity backfill (only sessions are backfilled)
- Session detail page changes

## Further Notes

- The blue dot freshness windows (3 days for sessions, 7 days for resources) are
  frontend constants — easy to tune without backend changes.
- The backfill migration flag pattern (`migrations` table) can be reused for
  future one-time migrations.
- The existing `/sessions` route components (detail page, agent-block-card,
  formatted-data, etc.) are untouched — only the listing page is replaced.
