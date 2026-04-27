# OAuth Credential Upsert Implementation

**Linear:** [TEM-3400](https://linear.app/tempestteam/issue/TEM-3400/)\
**Branch:** `replace-oauth-creds`\
**PR:** [#1213](https://github.com/friday-platform/friday-studio/pull/1213)\
**Status:** Complete

## Problem

Re-authenticating with the same OAuth identity created duplicate credentials
instead of updating the existing one. PR #1000 removed upsert behavior when
adding Cypher encryption.

**Evidence:** Same user (`eric@tempest.team`) with Notion OAuth had 4 separate
credentials with identical `(provider, label)` tuples.

## Solution

Added native `upsert()` method to storage adapters using PostgreSQL
`ON CONFLICT` for atomic create-or-update by composite key
`(user_id, provider, label)`.

## What Was Built

### Database Migration

**File:** `supabase/migrations/20251229203742_credential_upsert_index.sql`

```sql
CREATE UNIQUE INDEX IF NOT EXISTS credential_user_provider_label_active_idx
ON public.credential (user_id, provider, label)
WHERE deleted_at IS NULL;
```

Partial unique index excludes soft-deleted credentials, enabling `ON CONFLICT`
to work correctly.

### StorageAdapter Interface

**File:** `apps/link/src/types.ts`

Added `upsert()` method to interface:

```typescript
interface StorageAdapter {
  // ... existing methods ...
  /**
   * Create or update credential by composite key (provider, label, userId).
   * If active credential with same key exists, updates it. Otherwise creates new.
   * Atomic—no race conditions.
   */
  upsert(credential: CredentialInput, userId: string): Promise<SaveResult>;
}
```

### CypherStorageAdapter

**File:** `apps/link/src/adapters/cypher-storage-adapter.ts`

Single atomic query using `ON CONFLICT ... DO UPDATE`:

```typescript
async upsert(input: CredentialInput, userId: string): Promise<SaveResult> {
  const encryptedSecret = await this.encryptSecret(input.secret);

  return await withUserContext(this.sql, userId, async (tx) => {
    const rows = await tx<{ id: string; created_at: Date; updated_at: Date }[]>`
      INSERT INTO public.credential (user_id, type, provider, label, encrypted_secret)
      VALUES (${userId}, ${input.type}, ${input.provider}, ${input.label}, ${encryptedSecret})
      ON CONFLICT (user_id, provider, label) WHERE deleted_at IS NULL
      DO UPDATE SET
        encrypted_secret = EXCLUDED.encrypted_secret,
        updated_at = now()
      RETURNING id, created_at, updated_at
    `;

    const row = rows[0];
    if (!row) throw new Error("Upsert failed: no row returned");

    return {
      id: row.id,
      metadata: {
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      },
    };
  });
}
```

### DenoKVStorageAdapter

**File:** `apps/link/src/adapters/deno-kv-adapter.ts`

Iteration-based lookup (DenoKV is local dev only):

```typescript
async upsert(input: CredentialInput, userId: string): Promise<SaveResult> {
  using kv = await Deno.openKv(this.kvPath);

  // Find existing credential with same provider+label
  let existingId: string | null = null;
  let existingMetadata: Metadata | null = null;

  for await (const entry of kv.list<Credential>({ prefix: ["credentials", userId] })) {
    if (entry.value.provider === input.provider && entry.value.label === input.label) {
      existingId = entry.value.id;
      existingMetadata = entry.value.metadata;
      break;
    }
  }

  const now = new Date().toISOString();

  if (existingId && existingMetadata) {
    const metadata: Metadata = { createdAt: existingMetadata.createdAt, updatedAt: now };
    const credential: Credential = { ...input, id: existingId, metadata };
    await kv.set(["credentials", userId, existingId], credential);
    return { id: existingId, metadata };
  }

  const id = nanoid();
  const metadata: Metadata = { createdAt: now, updatedAt: now };
  const credential: Credential = { ...input, id, metadata };
  await kv.set(["credentials", userId, id], credential);
  return { id, metadata };
}
```

### OAuth Completion Flow

**File:** `apps/link/src/oauth/service.ts`

Changed `save()` to `upsert()` in `completeFlow()`:

```typescript
// 8. Upsert credential (atomic create-or-update by provider+label identity)
const { id, metadata } = await this.storage.upsert(
  credentialInput,
  userId || "dev",
);
```

### Tests

**File:** `apps/link/tests/oauth.test.ts`

1. **Replaced** "Each OAuth flow creates new credential" with "Same OAuth
   identity updates existing credential (upsert)" — verifies same ID returned on
   re-auth
2. **Added** "OAuth flow after delete creates new credential" — verifies
   soft-deleted credentials don't block new ones

## Design Decisions

| Decision        | Choice                           | Reasoning                                       |
| --------------- | -------------------------------- | ----------------------------------------------- |
| Approach        | Native upsert with `ON CONFLICT` | Atomic—no race window between lookup and write  |
| API             | Add `upsert()`, keep `save()`    | Explicit intent, doesn't break existing callers |
| Composite key   | `(provider, label, userId)`      | Allows multiple accounts per provider           |
| DenoKV strategy | Simple iteration                 | Local dev only, YAGNI on secondary indexes      |
| Return type     | `SaveResult` (id + metadata)     | Same as `save()`, no `created` flag (YAGNI)     |

## QA Steps

1. List credentials: `GET http://localhost:3100/v1/credentials/type/oauth` →
   expect 0 creds
2. Authorize with Notion:
   `http://localhost:8080/api/link/oauth/authorize/notion/`
3. List credentials → expect 1 cred
4. Re-authorize with Notion (same link)
5. List credentials → expect 1 cred (same ID, not duplicate)

## Future Considerations

If credential renaming is added later:

- `label` would become editable display name
- Need to add `externalId` (or similar) as stable matching key
- Migration to populate `externalId` from current `label` values

For now, `label === userIdentifier` is enforced by the OAuth flow.
