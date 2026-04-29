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

## Delegated OAuth mode

Google Workspace providers (`google-calendar`, `google-gmail`, `google-drive`,
`google-docs`, `google-sheets`) use **delegated mode** — the code→token exchange
happens in an external Cloud Function rather than in Link.

Why: Friday's own OAuth client is unverified and triggers Google's scary
"unverified app" warning. The delegated flow piggybacks on the Gemini CLI
Workspace Extension's **verified** client (`338689075713-...`) via its public
Cloud Function at `https://google-workspace-extension.geminicli.com`.

Flow:

1. Link builds the auth URL with `redirect_uri = <Cloud Function>` and a base64
   `state` payload containing `{uri: <local callback>, manual: false, csrf}`.
2. User consents on Google. The consent screen says **"Gemini CLI Workspace
   Extension"** — not Friday Studio. This is expected.
3. Google redirects to the Cloud Function with an auth `code`.
4. Cloud Function exchanges `code` for tokens (it holds the `client_secret`).
5. Cloud Function redirects to the `uri` from the `state` payload with tokens in
   query params: `?access_token=...&refresh_token=...&expiry_date=...`.
6. Link's callback handler parses the tokens directly — no code exchange.
7. Token refresh: Link POSTs `{refresh_token}` to the Cloud Function's
   `/refreshToken` endpoint. Response has a new `access_token` but **never a new
   `refresh_token`** — the original is preserved.

### Critical constraints

- **Localhost-only callback** — the Cloud Function only redirects to `localhost`
  or `127.0.0.1`. If Link ever runs on a non-localhost URL, this flow breaks.
- **Cloud Function dependency** — the entire Google integration depends on a
  third-party endpoint Google can revoke or rate-limit at any time. If it goes
  down, all Google OAuth flows and refreshes fail across all users.
- **Scope subset** — the scopes Link requests must remain a subset of what
  Gemini's verified GCP project covers. Adding a new Google scope outside that
  set silently re-introduces the unverified-app warning.
- **Token refresh never rotates** — `refreshDelegatedToken` explicitly preserves
  the original `refresh_token` because the Cloud Function refresh response
  doesn't include one.
