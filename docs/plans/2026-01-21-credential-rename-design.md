<!-- v2 - 2026-01-21 - Generated via design-critique from docs/plans/2026-01-21-credential-rename-design.md -->

# Credential Rename Feature

Allow users to set a custom display name for Link credentials from the settings
page.

## Problem

OAuth credentials use the `label` field for display, which is set to
`userIdentifier` during auth. Some providers return ugly identifiers:

- **Linear:** UUID like `31e50aaa-c981-466f-ba2b-68ff534487e5`
- **Notion:** Email like `eric@tempest.team` (better, but still not user-chosen)

Users should be able to rename credentials to something meaningful like "Work
Linear" or "Personal Notion".

## Constraints

**Must preserve:** Replace-in-place OAuth re-auth. The current upsert logic uses
`(user_id, provider, label)` as the unique key. If we let users change `label`,
re-auth would create a new credential instead of updating the existing one.

## Design

### Data Model

Add a new nullable field to the `Credential` type:

```typescript
displayName?: string  // null until user sets it
```

**Display logic:** `displayName ?? label`

**Validation:**

- 1-100 characters
- Non-empty once set (no clearing back to null)
- Trimmed whitespace

The existing `label` field remains unchanged as the immutable upsert key.

### Database Migration

**Postgres:** Add nullable `display_name` column (varchar 100) to `credential`
table. No backfill - existing credentials remain null until users rename them.

**DenoKV:** No migration needed, schema-less.

### Storage Interface

Add new method to `StorageAdapter` for metadata-only updates (avoids
decrypt/re-encrypt cycle):

```typescript
updateMetadata(id: string, metadata: { displayName?: string }, userId: string): Promise<Metadata>;
```

### API

**New endpoint:**

```
PATCH /v1/credentials/:id
Content-Type: application/json

{ "displayName": "My Work Linear" }
```

**Response:** Updated credential summary

```json
{
  "id": "...",
  "type": "oauth",
  "provider": "linear",
  "userIdentifier": "31e50aaa-c981-466f-ba2b-68ff534487e5",
  "label": "31e50aaa-c981-466f-ba2b-68ff534487e5",
  "displayName": "My Work Linear",
  "createdAt": "2026-01-21T...",
  "updatedAt": "2026-01-21T..."
}
```

**Errors:**

| Case                   | Status | Response                                              |
| ---------------------- | ------ | ----------------------------------------------------- |
| Not found / wrong user | 404    | `{ "error": "Credential not found" }`                 |
| Validation fail        | 400    | `{ "error": "displayName must be 1-100 characters" }` |
| Invalid type           | 400    | `{ "error": "displayName must be a string" }`         |

**Future compatibility:** This endpoint handles metadata updates. Secret
rotation (API key replacement) will use a separate
`PUT /v1/credentials/:id/secret` endpoint when needed.

### Summary Endpoint Changes

Update `GET /v1/summary` response to include `displayName` and `userIdentifier`:

```typescript
// Before
{
  id, type, provider, label, createdAt;
}

// After
{
  id, type, provider, userIdentifier, label, displayName, createdAt, updatedAt;
}
```

### UI

**Settings page changes:**

- Display `displayName ?? label` for each credential
- Add edit (pencil) icon button next to credential name

**Rename modal:**

- Text input pre-filled with current display name (or label if null)
- Save and Cancel buttons
- On save: `PATCH /v1/credentials/:id`
- On success: refresh list, close modal
- On error: show inline error, keep modal open

## Files to Change

**Backend (apps/link):**

- `src/types.ts` - Add `displayName` to `CredentialSchema`, add
  `updateMetadata()` to `StorageAdapter` interface
- `src/routes/credentials.ts` - Add PATCH endpoint
- `src/routes/summary.ts` - Include `displayName`, `userIdentifier`, `updatedAt`
  in response
- `src/adapters/cypher-storage-adapter.ts` - Add `updateMetadata()`
  implementation
- `src/adapters/deno-kv-adapter.ts` - Add `updateMetadata()` implementation
- New migration file for Postgres

**Frontend (apps/web-client):**

- `src/routes/(app)/settings/+page.svelte` - Add edit button, modal
- `src/routes/(app)/settings/(components)/provider-details-column.svelte` -
  Display displayName ?? label

## Testing

- **Unit:** Storage adapters handle displayName field correctly
- **Integration:** PATCH endpoint validates, persists, returns updated
  credential
- **E2E (optional):** Full flow - click edit, enter name, save, verify display
