# Link

Credential management and OAuth orchestration service. Stores API keys and OAuth
tokens, manages token refresh, provides unified credential access for agents.

## Critical: Row-Level Security

**Every database query acting on behalf of a user MUST use `withUserContext()`.**

```typescript
// CORRECT — RLS enforced
const rows = await withUserContext(sql, userId, async (tx) => {
  return await tx<CredentialRow[]>`
    SELECT * FROM public.credential WHERE id = ${id}
  `;
});

// WRONG — bypasses RLS, leaks cross-user data
const rows = await sql<CredentialRow[]>`
  SELECT * FROM public.credential WHERE id = ${id}
`;
```

**How it works** (`src/adapters/rls.ts`):

1. Starts a transaction
2. Sets `request.user_id` via `set_config(..., true)` (as connection owner)
3. Sets `SET LOCAL ROLE authenticated` (activates RLS policies, drops privileges)
4. RLS policies filter rows by `current_setting('request.user_id', true)`

Transaction-local scope prevents the session variable from leaking to other
queries on the same pooled connection.

Cross-user lookups (e.g. ownership checks) use SECURITY DEFINER functions, not
superuser queries.

## Commands

```bash
deno task start                       # Start service (port 3100)
deno task dev                         # Dev mode (watch + auto-restart)
deno task test                        # Run tests
deno task test tests/oauth.test.ts    # Run specific test
deno task check                       # Type check
```

## Gotchas

- **Stateless OAuth flows** — flow state encoded as signed JWT, no server-side
  session storage. Survives restarts and horizontal scaling.
- **Proactive token refresh** — internal endpoint refreshes tokens expiring
  within 5 minutes. Agents get working tokens without handling 401s.
- **Credential identity** — OAuth credentials use synthetic IDs
  (`oauth:{provider}:{userIdentifier}`). Re-authorizing the same account
  upserts the existing credential, doesn't create a duplicate.
- **AsyncLocalStorage for auth** — JWT tokens stored in AsyncLocalStorage
  (`auth-context.ts`) so CypherHttpClient can access them without explicit
  parameter passing through the call chain.
- **Provider registry import order** — `registry.ts` imports `config.ts` to
  ensure `loadEnv()` runs before provider factories read env vars. ES module
  evaluation order dependency.
- **Legacy Slack migration** — Pre-Jan 2026 Slack credentials missing `platform`
  field are lazily migrated via Zod preprocessor (not DB migration — credentials
  are encrypted per-user).
- **Dev mode** — `LINK_DEV_MODE=true` skips JWT verification, defaults user ID
  to `"dev"`. Tests use this.
