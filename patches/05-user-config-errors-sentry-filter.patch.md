# Patch: ATLAS-5VD/5VA/5V7 — User Config Errors Sentry Filter

## Sentry Issues
| ID | Title | Events |
|----|-------|--------|
| ATLAS-5VD | MissingEnvironmentError | 1 |
| ATLAS-5VA | YAML SyntaxError at line 235 | 1 |
| ATLAS-5V7 | DetailedError: 404 Not Found | 1 |

Links:
- https://tempestteam.sentry.io/issues/ATLAS-5VD/
- https://tempestteam.sentry.io/issues/ATLAS-5VA/
- https://tempestteam.sentry.io/issues/ATLAS-5V7/

## Root Causes

**ATLAS-5VD:** `validateMCPEnvironmentForWorkspace()` in `manager.ts:37-113`
found missing env vars for MCP servers. This is a user configuration
error (missing `.env` entries), not a platform bug.

**ATLAS-5VA:** `@std/yaml` parser rejects user's `workspace.yml` at
line 235 — a multiline key without proper quoting. The error originates
in the user's file, not in platform code.

**ATLAS-5V7:** `parseResult()` in `packages/client/v2/mod.ts:75-85`
captured a 404 API response. This is expected behavior when querying
a deleted/missing resource.

## Fix

### File: `packages/atlas-daemon/src/config/loader.ts`

Wrap YAML parse errors in `UserConfigurationError`:

```typescript
import { UserConfigurationError } from '../errors.ts';

// In ConfigLoader.load():
try {
  return yaml.parse(content);
} catch (err) {
  if (err instanceof SyntaxError || err?.name === 'YAMLError') {
    throw new UserConfigurationError(
      `Invalid YAML in workspace configuration file: ${err.message}`,
      { cause: err }
    );
  }
  throw err;
}
```

### File: `packages/atlas-daemon/src/mcp/manager.ts` (~line 37-113)

Wrap `MissingEnvironmentError` as `UserConfigurationError` (or directly
use `UserConfigurationError` as the thrown type):

```typescript
// In validateMCPEnvironmentForWorkspace():
const missing = requiredVars.filter(v => !process.env[v] && !workspaceEnv[v]);
if (missing.length > 0) {
  throw new UserConfigurationError(
    `Missing required environment variables for MCP server "${serverName}": ` +
    missing.join(', ') +
    `. Please add them to your workspace .env file.`
  );
}
```

### File: `packages/client/v2/mod.ts` (~line 75-85)

Mark 404 responses as expected / lower severity:

```typescript
// In parseResult():
if (response.status === 404) {
  // 404 is expected for missing/deleted resources — do not throw to Sentry
  throw new DetailedError('Not Found', {
    status: 404,
    expected: true,  // flag for Sentry beforeSend
  });
}
```

### File: `packages/atlas-daemon/src/sentry.ts` — Consolidated beforeSend

Add a comprehensive `beforeSend` filter that covers all user-config-class
errors. This single change would suppress ~10 of the 16 recent Sentry issues:

```typescript
import Sentry from '@sentry/deno'; // or node, depending on runtime
import {
  UserConfigurationError,
  MissingEnvironmentError,
  WorkspaceNotFoundError,
  DetailedError,
} from './errors.ts';

Sentry.init({
  dsn: Deno.env.get('SENTRY_DSN'),
  environment: Deno.env.get('ATLAS_ENV') ?? 'production',

  beforeSend(event, hint) {
    const err = hint?.originalException;

    // User configuration mistakes — not platform bugs
    if (err instanceof UserConfigurationError) return null;
    if (err instanceof MissingEnvironmentError) return null;
    if (err instanceof WorkspaceNotFoundError) return null;

    // Expected client 404s
    if (err instanceof DetailedError && (err as any).status === 404) return null;
    if (err instanceof DetailedError && (err as any).expected === true) return null;

    return event;
  },
});
```

## Testing
1. Create a workspace with a malformed YAML config — verify user-facing
   error message and no Sentry event.
2. Create a workspace with missing MCP env vars — verify user-facing
   error and no Sentry event.
3. Query a deleted resource via the client — verify 404 is handled
   gracefully and no Sentry event.
4. Trigger a genuine platform error — verify it DOES reach Sentry.
