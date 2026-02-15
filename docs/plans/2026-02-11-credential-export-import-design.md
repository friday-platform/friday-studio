# Credential-Aware Workspace Export/Import

## Problem Statement

Workspaces reference credentials via Link credential IDs (e.g., `cred_abc123`),
which are user-scoped. When a workspace is exported and imported by a different
user, these credential references break because the IDs are meaningless outside
the original user's context. This makes workspace sharing non-functional for any
workspace that uses credentials.

## Solution

Strip user-scoped credential IDs during export, replacing them with
provider-based references. During import, resolve provider-based references back
to concrete credential IDs belonging to the importing user. If the importing
user is missing required integrations, fail the import with a clear error
listing which providers need to be connected first.

## User Stories

1. As a workspace author, I want to export my workspace so that another user can
   import it without my credential IDs leaking into the export
2. As a workspace importer, I want credentials to automatically resolve to my
   own integrations so that the imported workspace works immediately
3. As a workspace importer, I want a clear error listing missing integrations so
   that I know exactly what to connect before retrying the import
4. As a workspace author, I want export to fail if any of my credentials can no
   longer be resolved so that I don't produce a broken export file
5. As a workspace importer with multiple credentials for the same provider, I
   want the system to pick a credential automatically so that import is
   frictionless (future: UI picker for explicit selection)

## Implementation Decisions

### Schema Change: Allow Both `id` and `provider` in LinkCredentialRef

**File:** `packages/agent-sdk/src/types.ts` (lines 67-77)

**Change the XOR constraint to "at least one".** The `LinkCredentialRefSchema`
currently requires exactly one of `id` or `provider`. Change this to allow both
simultaneously:

```typescript
// Before (XOR):
.refine((data) => Boolean(data.id) !== Boolean(data.provider), {
  message: "Exactly one of 'id' or 'provider' must be specified",
})

// After (at least one):
.refine((data) => Boolean(data.id) || Boolean(data.provider), {
  message: "At least one of 'id' or 'provider' must be specified",
})
```

This enables credential refs to carry both the specific binding (`id`) and the
abstract requirement (`provider`):

```yaml
# Valid states:
GITHUB_TOKEN: { from: "link", id: "cred_abc123", provider: "github", key: "token" }  # both
GITHUB_TOKEN: { from: "link", provider: "github", key: "token" }                      # provider only
GITHUB_TOKEN: { from: "link", id: "cred_abc123", key: "token" }                       # id only (legacy)
```

**Why:** Export needs the provider name to produce portable configs. Storing
provider alongside id at credential assignment time means export never needs
Link API lookups — it just drops the `id` field.

**Backward compatibility:** Changing XOR to "at least one" is additive — all
existing configs (which have exactly one field) remain valid.

### Credential Assignment: Store Both `id` and `provider`

When `PUT /config/credentials/:path` updates a credential, it already fetches
the credential from Link to validate provider match. At that point, store both
`id` and `provider` in the written ref:

```typescript
// In updateCredential or at the route layer:
const newRef: LinkCredentialRef = {
  from: "link",
  id: credentialId,
  provider: credential.provider,  // from Link validation response
  key: existingRef.key,
};
```

This means all credential refs created or updated after this change will carry
both fields. Legacy id-only refs will get `provider` added on their next update.

### Export Flow

Modify `GET /:workspaceId/export` to convert all credential refs to
provider-only refs before serializing to YAML.

- For refs with `provider` present — drop `id`, keep `provider` and `key`
- For refs with only `id` (legacy, not yet updated via PUT) — fall back to
  fetching the credential from Link to determine provider, then replace. This
  is a vanishing edge case as credentials get updated through normal use.
- If any legacy id-only credential cannot be resolved (deleted, Link
  unavailable), return **422** with `unresolvable_credentials` error listing
  affected paths

### Import Flow

Modify `POST /create` to resolve all `provider`-based refs to `id`-based refs
(with `provider` preserved) before creating the workspace.

- Walk all `LinkCredentialRef` entries in MCP server env and agent env
- Collect unique providers needed
- Fetch importing user's credentials from Link for each provider **in
  parallel** using `Promise.allSettled` (not `Promise.all` — see below)
- Collect all missing providers from settled results before returning an error
- If any providers have zero credentials, return **400** with
  `missing_credentials` error listing **all** missing providers
- If all providers have credentials, pick the first credential for each provider
  and rewrite refs: `{ from: "link", provider: "github", key: "token" }` →
  `{ from: "link", id: "cred_xyz789", provider: "github", key: "token" }`
- **Validate keys:** For each resolved credential, fetch the full credential
  from Link and verify that each referenced `key` exists in the credential's
  `secret` object. Return **400** with `invalid_credential_keys` if any keys
  are missing (see Error Shapes below)
- Proceed with normal workspace creation using the resolved config
- **Include `resolvedCredentials` in the success response** (see below)

#### Why `Promise.allSettled` instead of `Promise.all`

`resolveCredentialsByProvider` (the only exported provider-based fetch in
`credential-resolver.ts`) throws `CredentialNotFoundError` when zero credentials
exist for a provider. Using `Promise.all` would short-circuit on the first
missing provider, showing only one error at a time. `Promise.allSettled`
captures all results, then the route collects failures into the complete
`missingProviders` list.

This avoids changes to `credential-resolver.ts` — the existing
`resolveCredentialsByProvider` function is used as-is, and its throw-on-empty
behavior is handled by the settled result filtering.

#### Key Validation During Import

After resolving provider-based refs to credential IDs, fetch the full credential
for each unique credential ID using `fetchLinkCredential`. For each credential
ref, verify that the `key` field (e.g., `"token"`, `"webhook_secret"`) exists in
`credential.secret`. This catches config errors at import time instead of
deferring them to runtime where the error message is less actionable.

This adds one `fetchLinkCredential` call per unique resolved credential (not per
ref — credentials are deduplicated by ID). For a workspace with 3 providers,
this means 3 additional API calls during import.

### Ambiguous Credential Selection

When a user has multiple credentials for the same provider, the system picks the
first one returned by Link. This is a simplification — the architecture supports
returning the full list for UI-driven selection in the future. Code should be
structured to make this swap trivial (the resolution function receives a
pre-built `provider → credentialId` map, so the caller controls selection
logic).

### Error Shapes

**Import — missing credentials (400):**

```json
{
  "error": "missing_credentials",
  "message": "Connect these integrations first",
  "missingProviders": ["slack", "linear"]
}
```

**Import — invalid credential keys (400):**

Only returned after credential resolution succeeds. Validates that each `key`
referenced in credential refs exists in the resolved credential's `secret`
object.

```json
{
  "error": "invalid_credential_keys",
  "message": "Resolved credentials are missing expected keys",
  "invalidKeys": [
    {
      "path": "mcp:github:GITHUB_TOKEN",
      "provider": "github",
      "key": "access_token",
      "availableKeys": ["token", "refresh_token"]
    }
  ]
}
```

**Export — unresolvable credentials (422):**

Only applies to legacy id-only refs where the credential has been deleted from
Link. Refs that already carry `provider` never hit this path.

```json
{
  "error": "unresolvable_credentials",
  "message": "Cannot resolve credentials for export",
  "unresolvedPaths": ["mcp:github:GITHUB_TOKEN"]
}
```

### Import Success Response

When credentials are resolved during import, include a `resolvedCredentials`
field in the success response so users and UIs can see which credentials were
bound:

```json
{
  "success": true,
  "workspace": { "...": "..." },
  "created": true,
  "workspacePath": "/path/to/workspace",
  "filesCreated": ["workspace.yml", ".env"],
  "resolvedCredentials": [
    {
      "path": "mcp:github:GITHUB_TOKEN",
      "provider": "github",
      "credentialId": "cred_xyz789",
      "label": "My GitHub"
    },
    {
      "path": "agent:researcher:SLACK_TOKEN",
      "provider": "slack",
      "credentialId": "cred_abc456",
      "label": "Work Slack"
    }
  ]
}
```

When no credentials are resolved (e.g., config has no provider-based refs), the
field is omitted or an empty array.

### Code Structure

**Pure config transforms in `packages/config/src/mutations/credentials.ts`:**

- `toProviderRefs(config, providerMap: Record<string, string>)` — for export.
  Drops `id` from all credential refs that have `provider`. For legacy id-only
  refs, uses the provided `credentialId → providerName` map to add `provider`
  before dropping `id`. **Throws if a legacy id-only ref has no entry in the
  map** (defense-in-depth — caller must resolve all legacy refs before calling).
  Pure function, no Link dependency.
- `toIdRefs(config, credentialMap: Record<string, string>)` — for import. Takes
  a map of `providerName → credentialId`, adds `id` to provider-based refs
  while preserving `provider`. Pure function, no Link dependency.

**Route-level orchestration in `apps/atlasd/routes/workspaces/index.ts`:**

- Export endpoint: extracts credentials via `extractCredentials()`, identifies
  legacy id-only refs, fetches those from Link to build the fallback
  `id → provider` map, calls `toProviderRefs`, serializes to YAML
- Import endpoint: extracts required providers from config, fetches importing
  user's credentials from Link **in parallel** (`Promise.allSettled`), collects
  all missing providers from rejected results, builds `provider → credentialId`
  map (picking first when ambiguous), validates keys by fetching full
  credentials, calls `toIdRefs`, includes `resolvedCredentials` in response,
  proceeds with creation

**Update to `updateCredential` in `packages/config/src/mutations/credentials.ts`:**

- When building the new ref, accept an optional `provider` parameter and include
  it in the stored ref. The route layer passes `provider` from the Link
  validation response.

**No changes to `packages/core/src/mcp-registry/credential-resolver.ts`** —
existing `resolveCredentialsByProvider` and `fetchLinkCredential` are sufficient
for the route layer. The runtime `resolveEnvValues` already handles both
id-based and provider-based refs.

### Separation of Concerns

- `packages/config` owns pure config transformations (no I/O, no Link calls)
- Route layer owns Link service interaction and orchestration
- Existing `extractCredentials()` function is reused to walk credential refs
- `toProviderRefs` and `toIdRefs` each do a single `produce()` call for the
  full config transformation (not N intermediate copies)

## Testing Decisions

Good tests for this feature validate the transformation logic and error paths,
not Link service internals.

**Unit tests for pure transform functions:**

- `toProviderRefs` — drops `id` from refs that have both `id` and `provider`,
  uses providerMap for legacy id-only refs, throws on unmapped legacy refs,
  leaves provider-only refs untouched
- `toIdRefs` — adds `id` to provider-based refs while preserving `provider`,
  leaves refs that already have `id` untouched, handles mixed refs
- Both functions handle configs with no credentials (no-op)
- Both functions handle credentials in MCP server env and agent env

**Schema change tests:**

- `LinkCredentialRefSchema` accepts `{ id, provider, key }` (both fields)
- `LinkCredentialRefSchema` accepts `{ id, key }` (id only, legacy)
- `LinkCredentialRefSchema` accepts `{ provider, key }` (provider only)
- `LinkCredentialRefSchema` rejects `{ key }` (neither field)

**Integration tests for route endpoints:**

- Export endpoint returns provider-based refs with no credential IDs in output
- Export endpoint handles legacy id-only refs via Link fallback
- Import endpoint resolves provider-based refs to refs with both id and provider
- Import endpoint returns 400 with missing provider list when user lacks
  integrations — **all** missing providers listed, not just the first
- Import endpoint returns 400 with `invalid_credential_keys` when a key doesn't
  exist in the resolved credential's secret
- Import endpoint success response includes `resolvedCredentials` field
- Import endpoint uses `Promise.allSettled` to collect all provider fetch
  results before reporting errors
- Export endpoint returns 422 when legacy credential cannot be resolved
- `PUT /credentials/:path` stores both `id` and `provider` in the written ref
- Prior art: existing workspace endpoint tests in the routes test files

## Out of Scope

- UI picker for ambiguous credential selection (future work, code structured to
  support it)
- Credential migration tooling for existing exported workspaces
- Changes to the Link service API
- Changes to runtime credential resolution (`credential-resolver.ts`)
- Bulk migration of existing id-only refs (happens organically via credential
  updates)

## Further Notes

- The `LinkCredentialRef` schema change (XOR → at least one) is backward
  compatible and requires no migration
- The `extractCredentials()` function in `packages/config` already walks both
  MCP server and agent env entries, which can be reused for discovery
- The credential update endpoint (`PUT /config/credentials/:path`) serves as
  prior art for how credential mutations are orchestrated
- Legacy id-only refs are a vanishing edge case — every credential update via
  the API will add `provider` going forward
- Import parallelizes Link calls via `Promise.allSettled` to minimize latency
  while collecting all errors
- The `LinkCredentialRefSchema` lives in `packages/agent-sdk/src/types.ts`
  (lines 67-77)
- `fetchCredentialsByProvider` is private in `credential-resolver.ts` — the
  import flow uses the exported `resolveCredentialsByProvider` wrapper and
  handles its `CredentialNotFoundError` via `Promise.allSettled`
