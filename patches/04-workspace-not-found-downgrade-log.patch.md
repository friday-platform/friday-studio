# Patch: ATLAS-5VB/5VC — Downgrade WorkspaceNotFoundError, Filter from Sentry

## Sentry Issues
| ID | Title | Events |
|----|-------|--------|
| ATLAS-5VB | WorkspaceNotFoundError: nonexistent_slug | 1 |
| ATLAS-5VC | WorkspaceNotFoundError: nonexistent_slug | 3 |

Links:
- https://tempestteam.sentry.io/issues/ATLAS-5VB/
- https://tempestteam.sentry.io/issues/ATLAS-5VC/

## Root Cause
`getOrCreateWorkspaceRuntime()` in `atlas-daemon.ts:878-887` logs at
`logger.error` level when both ID and name lookups fail for a workspace.
The slug `nonexistent_slug` indicates a stale reference or test scenario.
Route handlers already return HTTP 404 correctly — the log level is wrong.

## Fix

### File: `packages/atlas-daemon/src/atlas-daemon.ts` (~line 878)

```typescript
// Before:
logger.error(`Workspace not found: ${slug}`, { slug });
throw new WorkspaceNotFoundError(slug);

// After:
logger.warn(`Workspace not found (expected for stale/test refs): ${slug}`, { slug });
throw new WorkspaceNotFoundError(slug);
```

### File: `packages/atlas-daemon/src/sentry.ts` (or Sentry init)

Add `WorkspaceNotFoundError` to the `beforeSend` filter:

```typescript
Sentry.init({
  beforeSend(event, hint) {
    const err = hint?.originalException;
    if (err instanceof UserConfigurationError) return null;
    if (err instanceof MissingEnvironmentError) return null;
    if (err instanceof WorkspaceNotFoundError) return null; // ← add this
    return event;
  },
});
```

### Optionally: add context tag for observability

If you still want to track workspace-not-found frequency without Sentry
noise, log a structured metric:

```typescript
logger.warn('workspace.not_found', { slug, requestId: ctx.requestId });
// or use a metrics counter: metrics.increment('workspace.not_found', { slug })
```

## Testing
1. Send a request with an unknown workspace slug.
2. Verify HTTP 404 is returned (no change).
3. Verify the log line is at `WARN` level, not `ERROR`.
4. Verify Sentry receives no event for this error.
