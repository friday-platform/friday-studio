## Problem Statement

The activity sidebar badge polls `GET /api/activity/unread-count` every 60
seconds via TanStack Query's `refetchInterval`. This means users wait up to a
minute to see new activity, and the document title never reflects unread count.
We need real-time push so the badge and title update instantly when activity is
created or read status changes.

## Solution

Replace the 60-second polling with an SSE stream backed by an in-memory
`ActivityNotifier` inside the daemon. Every activity mutation (create, delete,
mark) fires the notifier, which pushes the fresh unread count to all connected
browser tabs instantly. The browser holds a single `EventSource` connection per
page load, shared between the sidebar badge and the document title.

## User Stories

1. As a user, I want the sidebar activity badge to update instantly when a
   session completes or a resource is published, so I know something happened
   without waiting or refreshing
2. As a user, I want the browser tab title to show `Friday (N)` when there are
   unread activity items, so I can see new activity even when the tab is in the
   background
3. As a user, I want the badge and title to reset to 0 instantly when I visit
   the activity page, so I get immediate feedback that my items are marked read
4. As a user, I want the SSE connection to reconnect automatically if it drops,
   so I don't lose real-time updates after network blips
5. As a user, I want the title to show just "Friday" when there are no unread
   items

## Implementation Decisions

### Notifier built into ActivityStorage

The `ActivityNotifier` class (simple broadcast emitter — `subscribe(cb)` returns
an unsubscribe function, `notify()` calls all callbacks) lives directly in
`packages/activity/src/storage.ts` alongside the `ActivityStorage` singleton.
The notification logic is baked into the proxy methods that already exist:

```typescript
// storage.ts
const notifier = new ActivityNotifier();

export const ActivityStorage: ActivityStorageAdapter = {
  create: async (input) => {
    const r = await getStorage().create(input);
    notifier.notify();
    return r;
  },
  updateReadStatus: async (...args) => {
    await getStorage().updateReadStatus(...args);
    notifier.notify();
  },
  markViewedBefore: async (...args) => {
    await getStorage().markViewedBefore(...args);
    notifier.notify();
  },
  // pass-through (no notification needed)
  deleteByReferenceId: (id) => getStorage().deleteByReferenceId(id),
  list: (userId, filters) => getStorage().list(userId, filters),
  getUnreadCount: (userId) => getStorage().getUnreadCount(userId),
};

export { notifier as activityNotifier };
```

Only mutations that affect unread count trigger `notify()`. `deleteByReferenceId`
is not wrapped — it only deletes "running" activity items and is always followed
by a `create()` which triggers the notification. `list` and `getUnreadCount` are
reads.

No decorator, no wrapping in `atlas-daemon.ts`, no changes to `runtime.ts` or
`publish-hook.ts`. The notifier is an implementation detail of `ActivityStorage`
— callers don't know it exists. The SSE endpoint imports `activityNotifier`
directly from the package to subscribe.

The SSE handler always re-queries `getUnreadCount()` from SQLite on each
notification — it never increments or decrements a counter. A dedup check
ensures events are only sent when the count actually changes.

This works because atlasd is a single process — all activity mutations (session
hooks, resource routes, publish hooks, mark endpoint) happen in the same process
that serves the SSE connections. No need for Postgres LISTEN/NOTIFY or any
external pub/sub since activity is SQLite-backed.

### SSE Endpoint: `GET /api/activity/stream`

Added to `apps/atlasd/routes/activity.ts`. Follows the same `ReadableStream` +
`c.body(stream, 200, headers)` pattern as the chat stream resume endpoint in
`apps/atlasd/routes/chat.ts`.

Behavior:
- Authenticates via `requireUser()`
- Queries `getUnreadCount(userId)` immediately, sends as first event
- Subscribes to notifier — on each notification, re-queries count, sends only
  if the count changed (dedup avoids redundant frames)
- Sends SSE keepalive comment (`: keepalive\n\n`) every 30 seconds to prevent
  proxy/browser timeouts
- Cleans up (unsubscribe, clear interval, close controller) on
  `c.req.raw.signal` abort

Event format: `data: {"count": N}\n\n`

SSE headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`,
`Connection: keep-alive`.

### Frontend: EventSource singleton

New module `apps/web-client/src/lib/modules/activity/activity-stream.svelte.ts`.
Module-level `$state` (singleton per page load):

- `count` — reactive unread count
- `startActivityStream()` — idempotent, creates
  `EventSource(`${getAtlasDaemonUrl()}/api/activity/stream`)`. On message:
  parse `{"count": N}`, set `count`. EventSource auto-reconnects natively on
  error/disconnect.
- `getActivityUnreadCount()` — returns reactive `count`
- `resetActivityCount()` — sets `count = 0` for optimistic clear after marking

### Frontend: sidebar

`apps/web-client/src/lib/components/app/sidebar.svelte`:

- Remove the `createQuery` block for `["unread-count"]` and the
  `getUnreadCount` import from `$lib/queries/activity`
- Call `startActivityStream()` in `onMount`
- Replace `unreadQuery.isSuccess && unreadQuery.data > 0` with
  `getActivityUnreadCount() > 0` in the badge template
- Badge `.badge` CSS stays as-is (already defined in sidebar styles)

### Frontend: document title

`apps/web-client/src/routes/+layout.svelte`:

- Import `getActivityUnreadCount` and `startActivityStream`
- Call `startActivityStream()` in `onMount` (idempotent)
- Update `<svelte:head>`:
  ```svelte
  <svelte:head>
    {@const count = getActivityUnreadCount()}
    <title>{count > 0 ? `Friday (${count})` : 'Friday'}</title>
    ...
  </svelte:head>
  ```

No `$effect` or `document.title` manipulation needed — Svelte's `<svelte:head>`
handles reactivity natively.

### Frontend: mark-as-read cleanup

`apps/web-client/src/routes/(app)/activity/+page.svelte`:

- After `markActivity()` resolves, call `resetActivityCount()` instead of
  `queryClient.invalidateQueries({ queryKey: ["unread-count"] })`
- Remove `useQueryClient` import (no longer used in this file)

## Testing Decisions

Tests should verify external behavior, not implementation details.

### ActivityNotifier tests — `packages/activity/src/notifier.test.ts`

- `notify()` calls all subscribed callbacks
- Unsubscribe function removes the callback
- Multiple subscribers all receive notifications
- Unsubscribed callback is not called on subsequent `notify()`

### SSE endpoint tests — `apps/atlasd/routes/activity.test.ts`

Follow the existing mock adapter pattern in the activity routes file:

- `GET /api/activity/stream` returns 401 without auth
- `GET /api/activity/stream` returns SSE headers
  (`Content-Type: text/event-stream`)
- Initial event contains current unread count

### Frontend

- `activity-stream.svelte.ts`: unit test that `startActivityStream` is
  idempotent, `resetActivityCount` sets count to 0
- Sidebar badge renders count from stream (existing test patterns)

Prior art: `apps/atlasd/routes/activity.ts` test patterns for route tests,
`packages/activity/src/local-adapter.test.ts` for adapter-level tests.

## Files Touched

| File | Change |
|---|---|
| `packages/activity/src/notifier.ts` | **New** — ActivityNotifier class |
| `packages/activity/src/storage.ts` | Bake `notify()` into `ActivityStorage` proxy, export `activityNotifier` |
| `packages/activity/src/mod.ts` | Export `activityNotifier` |
| `apps/atlasd/routes/activity.ts` | Add `/stream` SSE endpoint (imports `activityNotifier`) |
| `apps/web-client/src/lib/modules/activity/activity-stream.svelte.ts` | **New** — EventSource singleton |
| `apps/web-client/src/lib/components/app/sidebar.svelte` | Replace polling query with stream |
| `apps/web-client/src/routes/+layout.svelte` | Dynamic title via `<svelte:head>` |
| `apps/web-client/src/routes/(app)/activity/+page.svelte` | Use `resetActivityCount()` instead of query invalidation |

## Out of Scope

- Per-event SSE data (pushing full activity items, not just count)
- Multi-user fan-out (notifier broadcasts to all — fine for single-user)
- Reconnection backoff tuning (EventSource native reconnect is sufficient)
- SSE for activity list page live updates (still uses TanStack Query fetch)

## Further Notes

- The notifier is intentionally simple (no user-scoping, no message payload).
  Each SSE handler re-queries its own count, which means the SQLite read is
  the source of truth and there's no stale-cache risk.
- EventSource auto-reconnects on network errors with browser-managed backoff.
  The 30-second keepalive prevents intermediate proxies from closing idle
  connections.
- The `resetActivityCount()` optimistic update means the badge clears instantly
  on mark — the SSE stream confirms within milliseconds when the mark endpoint
  also fires `notify()`.
