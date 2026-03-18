# Fix: ATLAS-WEB-CLIENT-A8

## Issue
`TypeError: Cannot read properties of undefined (reading 'name')` on `/settings` route

**Sentry:** https://tempest-labs-inc.sentry.io/issues/ATLAS-WEB-CLIENT-A8
**Severity:** Low (1 user, 5 events)
**Status:** Unresolved on `main`

## Root Cause

**File:** `applications/frame/src/lib/app-context.svelte.ts` (lines 249–252)

The unsafe non-null assertion `edge.node.team!` in `selectUserSessionContext()` masks a
nullable reference. When a `team_user` record references a deleted or RLS-hidden team,
the `.map()` produces `null`/`undefined` entries, and the subsequent `.sort()` crashes
accessing `.name` on `undefined`.

This function powers `getAppContext()`, which is called on every page — including `/settings`.

```typescript
// Before (buggy)
.map((edge) => edge.node.team!)          // unsafe ! — can still be null at runtime
.sort((a, b) => a.name.localeCompare(b.name))  // crashes when team is null
```

## Fix

```diff
-.map((edge) => edge.node.team!)
+.map((edge) => edge.node.team)
+.filter((team) => team != null)
 .sort((a, b) => a.name.localeCompare(b.name)) ?? [],
```

- Removed unsafe `!` non-null assertion
- Added `.filter((team) => team != null)` before `.sort()` to exclude null/undefined teams
- TypeScript narrows the type correctly after the filter; `.sort()` callback types remain valid

## Blast Radius

Minimal. One-line data-processing change inside `selectUserSessionContext()`. The filter
silently drops null team entries that previously crashed the app. No behavioral change for
users whose team memberships are all valid.
