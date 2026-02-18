# Settings Page: Show All Integrations

## Context

The settings page currently only shows connected credentials. Users have no way to discover or connect new integrations from settings — they only encounter the connect flow mid-conversation when an agent requests access. This change lists ALL available integrations on the settings page, with a "Connect" button for unconnected ones that triggers the same OAuth/apikey/app-install popup flow used in chat.

## Files to Modify/Create

| File | Action |
|------|--------|
| `apps/web-client/src/routes/(app)/settings/+page.svelte` | Modify — unified row type, rebuilt table, OAuth redirect handling on mount |
| `apps/web-client/src/routes/(app)/settings/(components)/connect-provider-cell.svelte` | Create — connect button with OAuth/apikey/app-install flow |
| `apps/web-client/src/routes/(app)/settings/(components)/provider-name-cell.svelte` | Create — simple provider name for unconnected rows |

No backend changes needed — `client.link.v1.summary.$get()` already returns both `providers` and `credentials`.

## Implementation

### 1. Create `provider-name-cell.svelte`

Simple display component for unconnected rows (no label/date, just provider name). Mirrors `provider-details-column.svelte` style.

### 2. Create `connect-provider-cell.svelte`

Handles the connect flow for a single unconnected provider. Reuses patterns from `connect-service.svelte` (reference: `apps/web-client/src/lib/modules/messages/connect-service.svelte`).

**Props:** `providerId: string`, `displayName: string`, `providerType: "oauth" | "apikey" | "app_install"`

**By provider type:**
- **OAuth:** "Connect" button → popup to `/api/link/v1/oauth/authorize/{providerId}` with `redirect_uri=/oauth/callback`. Listen for `message`/`storage` events from popup. On success → `invalidateAll()`.
- **App install:** Same popup pattern but URL is `/api/link/v1/app-install/{providerId}/authorize`.
- **API key:** Fetch provider details on mount (`client.link.v1.providers[":id"].$get()`) to get `secretSchema.required[0]`. Render `LinkAuthModal` (from `$lib/modules/messages/link-auth-modal.svelte`) with "Connect" as trigger. On success → `invalidateAll()`.

**Popup blocked fallback:** Same-tab redirect with `redirect_uri=window.location.href` (settings page). Return handled by step 4.

**Cleanup:** Remove `message`/`storage` listeners in `$effect` cleanup.

### 3. Rebuild table in `+page.svelte`

**Unified row type:**
```typescript
type IntegrationRow =
  | { kind: "connected"; credential: CredentialRow; providerName: string }
  | { kind: "unconnected"; provider: Provider };
```

**Derive unified data:** Connected rows (from credentials) first, then unconnected rows (providers with zero credentials). Use `Set` of connected provider IDs to filter.

**Table columns** (same 4 columns, conditional rendering per row kind):
- **Logo:** Extract `provider` id from either `credential.provider` or `provider.id`
- **Provider:** Connected → `ProviderDetails` (name, label, date). Unconnected → `ProviderNameCell` (just name)
- **Edit:** Connected → `RenameCredentialModal`. Unconnected → empty string
- **Actions:** Connected → `RemoveCredentialDialog`. Unconnected → `ConnectProviderCell`

**Row ID:** Connected uses `credential.id`, unconnected uses `unconnected-${provider.id}`

**Remove empty state guard** — table always has rows (providers always exist). Keep a defensive check with updated message.

### 4. Handle OAuth redirect on settings page mount

Add to existing `onMount`: check for `credential_id` in URL search params. If present, clean URL params (`credential_id`, `provider`, `error`, `error_description`) via `history.replaceState`, then `invalidateAll()`. This handles the popup-blocked same-tab redirect fallback.

## Verification

1. Load settings page — all providers should appear; connected ones first with edit/delete, unconnected ones with "Connect"
2. Click "Connect" on an OAuth provider — popup opens, complete flow, table refreshes with new credential
3. Block popup → fallback link appears → click it → same-tab redirect → returns to settings with credential connected
4. Click "Connect" on an API key provider → modal appears with label + API key fields → submit → table refreshes
5. Delete a connected credential → provider moves back to unconnected section with "Connect" button
6. Provider with multiple credentials → shows multiple connected rows, no unconnected row
