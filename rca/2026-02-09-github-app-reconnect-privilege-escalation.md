# Incident Report: GitHub App Reconnect Privilege Escalation

**Date:** 2026-02-09
**Severity:** Critical (P0)
**Status:** Remediated

---

## Executive Summary

A multi-tenant privilege escalation vulnerability in the Link service's GitHub
App reconnect flow allowed any user clicking "Connect GitHub" to claim ALL
GitHub App installations globally. An external user (`l6kg6jk2w5wrddr`) triggered the bug on 2026-02-04,
causing credentials for 3 GitHub organizations to be stored under their account
and webhook routing to be hijacked. The misassigned
credentials were used 3 times via internal API but all agent sessions failed due
to insufficient credits. The user self-deleted the misassigned credentials ~14
minutes later.

---

## Timeline

### Bug Introduction

| Date | Event |
|------|-------|
| 2026-01-02 | PR #1062 (`e4beeaab`) introduces app installation flow with unsafe `ON CONFLICT DO UPDATE` upsert — no ownership check |
| 2026-01-28 08:54 UTC | PR #1690 (`31c2fb35`) adds `reconnect()` short-circuit using `listInstallationIds()` — calls `GET /app/installations` (app-level JWT, returns ALL installations globally) |

### Legitimate Installations (Production)

| Timestamp (UTC) | Event | User | Installation |
|-----------------|-------|------|--------------|
| 2026-01-27 00:35:48 | `app_install_completed` | Sara `d401m99q1relnrg` (internal) | LissaGreense (106314575) |
| 2026-01-27 19:18:57 | `app_install_completed` | Tempest Team! `nngmqp710z680le` (friday-dogfooding) | yenatempest (106466395) |
| 2026-01-27 19:28:25 | `app_install_completed` | Tempest Team! `nngmqp710z680le` (friday-dogfooding) | tempestteam (106467834) |

**Note:** Earlier log events at 09:52/10:09 on 2026-01-27 attributed to Łukasz
(`84y9jdw5zy9e90m`) were actually an earlier instance of the same cross-user
reconnect bug — his reconnect claimed all installations via
`listInstallationIds()`, logged `app_install_completed` under his user context,
but the installations belonged to Sara and Tempest Team!.

### Incident (Production)

| Timestamp (UTC) | Event | Details |
|-----------------|-------|---------|
| 2026-02-04 03:53:29 | `app_install_reconnected` | External user `l6kg6jk2w5wrddr` triggers reconnect. Installation 106314575 (LissaGreense) claimed |
| 2026-02-04 03:53:29 | `app_install_reconnected` | Installation 106466395 (yenatempest/friday-dogfooding) claimed by `l6kg6jk2w5wrddr` |
| 2026-02-04 03:53:30 | `app_install_reconnected` | Installation 106467834 (tempestteam/friday-dogfooding) claimed by `l6kg6jk2w5wrddr` |
| 2026-02-04 03:53:29-30 | `platform_route` upsert x3 | Routes for all 3 installations overwritten: owners (Sara, Tempest Team!) changed to `l6kg6jk2w5wrddr` |
| 2026-02-04 ~03:54-04:07 | Credential used x3 | Misassigned credential `r138n48rnl1eelz` (tempestteam) fetched 3 times via `GET /internal/v1/credentials/r138n48rnl1eelz` |
| 2026-02-04 ~03:54-04:07 | Agent sessions x3 | All 3 sessions failed: "Credit balance is too low" — no GitHub API calls made |
| 2026-02-04 04:07 UTC | Self-cleanup | External user `l6kg6jk2w5wrddr` soft-deleted all 3 misassigned credentials |
| 2026-02-09 | Route cleanup | Routes restored to rightful owners via SQL |
| 2026-02-09 | Code fix | Security fix implemented (this report) |

### Sandbox Environment

The same bug was present in `tempest-sandbox`. Reconnect events found for
Łukasz (`d3k3r8pz8p8dl3g` in sandbox) and Sara (`5rkn85pd6ng809g` in sandbox),
with the same cross-user installation claiming behavior. 8
`app_install_reconnected` events found in sandbox logs.

---

## Root Cause Analysis

### Vulnerability Chain

```
User clicks "Connect GitHub"
  → GET /v1/app-install/github/authorize
    → service.reconnect("github", userId)
      → provider.listInstallationIds()                    ← BUG 1: App-level API
        → GET /app/installations (GitHub API, JWT auth)
        → Returns ALL installations across ALL orgs
      → for each installation:
          → provider.completeReinstallation(id)           ← No ownership check
          → persistInstallResult(result, userId)          ← Stores under requesting user
            → credentialStorage.save(credential, uid)     ← Credential created for wrong user
            → routeStorage.upsert(externalId, uid)        ← BUG 2: Unconditional overwrite
              → ON CONFLICT DO UPDATE SET user_id = $2    ← Previous owner overwritten
```

### Bug 1: `listInstallationIds()` uses app-level auth

**File:** `apps/link/src/providers/github-app.ts` (lines 210-236, now removed)

```typescript
// REMOVED — used app-level JWT, returned ALL installations globally
async listInstallationIds(): Promise<number[]> {
  const jwt = await this.generateJwt();
  const response = await fetch("https://api.github.com/app/installations", {
    headers: { Authorization: `Bearer ${jwt}`, Accept: "..." },
  });
  const data = InstallationsSchema.parse(await response.json());
  return data.map((i) => i.id);
}
```

The Go version (`tempest-core/applications/link`) correctly uses
`GET /user/installations` (user-scoped OAuth token) per GitHub's own best
practices.

### Bug 2: Unconditional `ON CONFLICT DO UPDATE`

**File:** `apps/link/src/adapters/platform-route-repository.ts`

```sql
-- BEFORE (unsafe): overwrites any existing owner
INSERT INTO platform_route (team_id, user_id) VALUES ($1, $2)
ON CONFLICT (team_id) DO UPDATE SET user_id = EXCLUDED.user_id

-- AFTER (safe): only updates if same owner
INSERT INTO platform_route (team_id, user_id) VALUES ($1, $2)
ON CONFLICT (team_id) DO UPDATE SET user_id = EXCLUDED.user_id
WHERE platform_route.user_id = EXCLUDED.user_id
```

### Bug 3: No RLS policies on `platform_route`

**File:** `supabase/migrations/20251210000000_create_platform_route_table.sql`

The `platform_route` table had RLS enabled and forced, but with **zero
policies** and **no GRANT to the `authenticated` role**:

```sql
ALTER TABLE public.platform_route ENABLE ROW LEVEL SECURITY;
-- "No policies defined - table access is only via service role (which bypasses RLS)"
```

The Link service connected as superuser, bypassing RLS entirely. All
authorization was done manually in app code — the exact layer where the bug
lived. Compare with the `credential` table which has 4 RLS policies
(RESTRICTIVE baseline + per-operation PERMISSIVE grants) and all queries go
through `withUserContext()` which sets `SET LOCAL ROLE authenticated`.

The `platform_route` table was designed as a "system-level routing table" with
the assumption that only service-role code would access it. But the Link
service's app-install flow writes to it on behalf of users, making it a
user-facing table that needed the same RLS treatment as `credential`.

| Table | RLS Policies | Access Pattern |
|-------|-------------|----------------|
| `credential` | 4 policies (RESTRICTIVE + PERMISSIVE) | `withUserContext()` → `authenticated` role |
| `platform_route` | None (before fix) | Direct superuser queries, manual app-layer checks |

**Fix:** Added RLS policies and migrated all queries to `withUserContext()`:

```sql
-- RESTRICTIVE baseline: users can ONLY access their own rows
CREATE POLICY "platform_route_user_isolation" ... AS RESTRICTIVE FOR ALL
    USING (user_id = current_setting('request.user_id', true))
    WITH CHECK (user_id = current_setting('request.user_id', true));
-- PERMISSIVE per-operation grants (SELECT, INSERT, UPDATE, DELETE) — all scoped to own user_id
```

Ownership checks (cross-user visibility) use `is_route_claimable()` SECURITY
DEFINER function — runs as definer role, bypasses RLS without requiring
BYPASSRLS on the connection.

Signal-gateway continues to access via service role (superuser) for webhook
routing — this is intentional as it has no user context.

### Secondary: No ownership check on no-code callback

In `completeInstall()`, the `!code` path called `completeReinstallation(installationId)`
with any `installation_id` from the callback URL — no check whether the user
owned that installation.

---

## Affected Users

### Production (`tempest-production`)

| User | User ID | Type | Impact |
|------|---------|------|--------|
| — | `l6kg6jk2w5wrddr` | External | **Triggered bug** — 3 credentials incorrectly assigned to their account, routes for 3 installations overwritten |
| Sara | `d401m99q1relnrg` | Internal | **Affected** — LissaGreense (106314575) route hijacked, credential duplicated under wrong user |
| Tempest Team! | `nngmqp710z680le` | Internal (friday-dogfooding) | **Affected** — yenatempest (106466395) + tempestteam (106467834) routes hijacked |

### Sandbox (`tempest-sandbox`)

Same vulnerability pattern. Łukasz (`d3k3r8pz8p8dl3g`) and Sara (`5rkn85pd6ng809g`)
affected with cross-user installation claiming via reconnect.

---

## Misassigned Credential Usage

### Credential `r138n48rnl1eelz` (tempestteam installation)

- Fetched 3 times via `GET /internal/v1/credentials/r138n48rnl1eelz`
- External user was building a translation memory scraper — legitimate use case,
  wrong credential
- All 3 agent sessions failed: **"Credit balance is too low"**
- **No GitHub API calls were made with the misassigned tokens**
- Other 2 credentials (LissaGreense, yenatempest) were never fetched

### Self-Cleanup

External user `l6kg6jk2w5wrddr` soft-deleted all 3 misassigned credentials at
2026-02-04 04:07 UTC (~14 minutes after incident). Supabase
`_tempest.soft_delete()` trigger confirmed the deletion.

---

## Remediation

### Database Cleanup (2026-02-09)

Routes restored to rightful owners:

```sql
-- LissaGreense → Sara
UPDATE platform_route SET user_id = 'd401m99q1relnrg'
WHERE team_id = '106314575';

-- yenatempest + tempestteam → Tempest Team! (friday-dogfooding)
UPDATE platform_route SET user_id = 'nngmqp710z680le'
WHERE team_id IN ('106466395', '106467834');
```

Misassigned credentials were already soft-deleted by external user on 2026-02-04.

### Code Fix (9 files changed + 1 new migration)

| File | Change |
|------|--------|
| `supabase/migrations/20260209000000_add_rls_policies_platform_route.sql` | **New** — RLS policies + GRANT for `platform_route` |
| `adapters/platform-route-repository.ts` | All queries through `withUserContext()`; upsert changed to `ON CONFLICT DO NOTHING` + `is_route_claimable()` check inside transaction (TOCTOU fix); `findOwner` replaced with `isClaimable` via SECURITY DEFINER function |
| `adapters/platform-route-repository.test.ts` | Updated mocks for `withUserContext()` transaction pattern |
| `app-install/errors.ts` | Added `INSTALLATION_OWNED` error code |
| `app-install/service.ts` | Rewrote `reconnect()` to be user-scoped; added ownership check in `completeInstall()` no-code path |
| `providers/types.ts` | Removed `listInstallationIds` from `AppInstallProvider` interface |
| `providers/github-app.ts` | Removed `listInstallationIds` implementation (29 lines) |
| `routes/app-install.ts` | Added HTTP 403 mapping for `INSTALLATION_OWNED` |
| `app-install/service.test.ts` | Updated mocks and tests for route-based reconnect, ownership checks |
| `routes/app-install.test.ts` | Updated mocks for new repository interface |

### Key Changes

**1. `reconnect()` — now user-scoped**

Before: `provider.listInstallationIds()` → `GET /app/installations` (all orgs)
After: `routeStorage.listByUser(uid, provider.platform)` → only installations this user owns for this platform

```typescript
// BEFORE (unsafe)
const ids = await provider.listInstallationIds(); // ALL installations globally

// AFTER (safe)
const ownedInstallationIds = await this.routeStorage.listByUser(uid, provider.platform); // Only user's own, platform-filtered
```

**2. `completeInstall()` — ownership check on no-code path**

```typescript
if (!code) {
  const installationIdParam = callbackParams?.get("installation_id") ?? "";
  const installationId = Number(installationIdParam);
  if (provider.completeReinstallation && installationId > 0) {
    const claimable = await this.routeStorage.isClaimable(installationIdParam, uid);
    if (!claimable) {
      throw new AppInstallError("INSTALLATION_OWNED",
        `Installation ${installationId} belongs to another user`);
    }
    result = await provider.completeReinstallation(installationId);
  }
}
```

**3. RLS policies on `platform_route` + `withUserContext()`**

All queries now go through `withUserContext()` (same as `credential` table):

```typescript
// All repository methods now run within RLS-enforced transactions
await withUserContext(this.sql, userId, async (tx) => {
  await tx`INSERT INTO platform_route ...`;
});
```

RLS policies enforce: all operations (SELECT, INSERT, UPDATE, DELETE) restricted
to own `user_id` via RESTRICTIVE baseline policy. Ownership checks use
`is_route_claimable()` SECURITY DEFINER function — runs as definer role to see
all rows without requiring BYPASSRLS on the connection. Even if app code has a
bug, the database prevents cross-user writes.

Upsert changed from `ON CONFLICT DO UPDATE` to `ON CONFLICT DO NOTHING` +
`is_route_claimable()` check inside the same transaction (eliminates TOCTOU gap).

**4. Removed `listInstallationIds`** — eliminated app-level `GET /app/installations` entirely

### Test Coverage

47 tests pass. New tests:
- Reconnect returns null when user has no owned routes
- Reconnect only refreshes user-owned installations
- Reconnect handles partial failures gracefully
- `completeInstall` no-code path rejects foreign installations (403)
- Repository methods execute within RLS context (SET LOCAL ROLE + set_config)

---

## Lessons Learned

1. **App-level vs user-level API auth**: GitHub's `GET /app/installations` returns
   everything. The Go version correctly used `GET /user/installations`. The TS
   port skipped this.

2. **RLS is not optional for user-facing tables**: `platform_route` was treated
   as a "system table" but the Link service writes to it on behalf of users.
   Any table touched by user-initiated flows needs RLS policies — app-layer
   authorization is not a substitute for database-level enforcement.

3. **Reconnect should never discover — only refresh**: The reconnect flow should
   only operate on installations the user already owns (from `platform_route`),
   not discover new ones via provider-level API.

4. **PR #1690 introduced the critical path**: The `reconnect()` short-circuit was
   added as a UX improvement but created a security bypass that skipped the
   normal OAuth flow's user-scoped validation.

---

## Codebase Audit: Other Multi-Tenant Isolation Gaps

A full audit of the Link service was performed to check if any other database
operations bypass RLS. **No additional vulnerabilities found.** The
`platform_route` table was the only one with the "RLS enabled but no policies"
gap.

### Secure: Credential Storage (`cypher-storage-adapter.ts`)

All 8 methods use `withUserContext()`:

| Method | RLS | Scoping |
|--------|-----|---------|
| `save()` | `withUserContext(sql, userId, ...)` | INSERT with own `user_id` |
| `upsert()` | `withUserContext(sql, userId, ...)` | ON CONFLICT keyed on `(user_id, provider, label)` |
| `update()` | `withUserContext(sql, userId, ...)` | WHERE `user_id = ${userId}` |
| `get()` | `withUserContext(sql, userId, ...)` | WHERE `user_id = ${userId}` |
| `list()` | `withUserContext(sql, userId, ...)` | WHERE `user_id = ${userId}` |
| `delete()` | `withUserContext(sql, userId, ...)` | Soft delete, own rows only |
| `updateMetadata()` | `withUserContext(sql, userId, ...)` | WHERE `user_id = ${userId}` |
| `findByProviderAndExternalId()` | `withUserContext(sql, userId, ...)` | WHERE `user_id = ${userId}` |

RLS policies: RESTRICTIVE baseline (`credential_user_isolation`) ensures no
future PERMISSIVE policy can bypass isolation, plus per-operation PERMISSIVE
grants (SELECT, INSERT, UPDATE).

### Secure: Platform Routes (`platform-route-repository.ts`, post-fix)

All write methods and `listByUser` use `withUserContext()`. `isClaimable` uses
`is_route_claimable()` SECURITY DEFINER function (no RLS context needed). RLS
policies: RESTRICTIVE baseline restricts all operations to own `user_id`.

### Secure: Filesystem Adapter (`filesystem-adapter.ts`, dev mode)

All methods use `userId` for directory-based isolation
(`${basePath}/${userId}/${id}.json`). Not used in production.

### Secure: Route Handlers

All route handlers extract `userId` from JWT middleware and pass to storage:

| Route file | userId extraction | Passes to storage |
|------------|------------------|-------------------|
| `routes/credentials.ts` | `c.get("userId")` | All CRUD operations |
| `routes/app-install.ts` | `c.get("userId")` | Service methods |
| `routes/oauth.ts` | `c.get("userId")` | OAuth flow + credential ops |
| `routes/summary.ts` | `c.get("userId")` | `storage.list()` calls |

### Secure: Auth Middleware (`index.ts`)

- Production: extracts `tempest_user_id` from JWT, returns 401 if missing
- Dev mode: sets `userId = "dev"` (non-production fallback)
- No path allows empty or missing userId to reach storage adapters

### Not in scope (no RLS needed)

| Component | Reason |
|-----------|--------|
| `cortex-adapter.ts` | Stores global provider definitions, not per-user data |
| Signal-gateway (Go) | Read-only superuser access for webhook routing, no user context |

### Defense-in-depth layers

```
1. Type system     — userId parameter required at compile time
2. Auth middleware  — JWT validation, 401 on missing userId
3. withUserContext  — SET LOCAL ROLE authenticated + request.user_id
4. RLS policies    — database-level row isolation
5. Parameterized SQL — postgres.js tagged templates prevent injection
```

---

## Recommendations

1. **Deploy this fix immediately** — create PR, merge, deploy
2. **Audit sandbox routes** — same cleanup needed for `tempest-sandbox`
3. **Add integration test** — multi-user scenario that verifies cross-user
   isolation during reconnect
4. **Consider rate limiting** — on `/v1/app-install/:provider/authorize` to
   limit reconnaissance potential
5. **Notify affected users** — Sara (`d401m99q1relnrg`) and Tempest Team!
   (`nngmqp710z680le`) should be informed their GitHub installation credentials
   were briefly assigned to an external user's account
