# Settings Integrations: Migration Plan

## Context

The original plan (`2026-02-13-settings-integrations-design.md`) was implemented — the settings page currently shows a unified table with both connected credentials and unconnected providers inline. This migration moves unconnected providers out of the main table and into an "Add Integration" dialog.

## What Exists Today

- `+page.svelte` — unified `IntegrationRow` type (`connected | unconnected`), single table with conditional rendering per row kind
- `connect-provider-cell.svelte` — "Connect" button with OAuth/apikey/app-install flow, rendered inline in the table's actions column for unconnected rows
- `provider-name-cell.svelte` — simple `<span>` showing provider name for unconnected rows

## What We're Moving To

- Main table shows **only connected credentials** (no `IntegrationRow` union, no conditional rendering)
- "Add Integration" button below the table opens a **dialog** with a searchable provider table
- Dialog table uses the **same column layout** as the main table (logo, provider name, connect action)
- Dialog shows **5–6 rows** at a time with scroll overflow
- Dialog has **cancel/close only** (no confirm button), uses existing `components/dialog/` primitives
- Clicking "Connect" **dismisses the dialog**, then OAuth popup or API key modal takes over

## Migration Steps

### 1. Create `add-integration-dialog.svelte`

New component at `apps/web-client/src/routes/(app)/settings/(components)/add-integration-dialog.svelte`.

**Props:** `providers: Provider[]`

**Structure:**
- `Dialog.Root` + `Dialog.Trigger` wrapping `<Button noninteractive>` (renders as a styled div since `Dialog.Trigger` is already a `<button>`)
- `Dialog.Content` with `Dialog.Cancel` in footer (no confirm button)
- Search `<input>` in dialog body, above the table
- TanStack table with same column structure as the main credentials table:
  - `provider_logo` — `LogoColumn` component
  - `provider` — provider `displayName` (plain text, no label/date)
  - `actions` — "Connect" button (reuse connect logic from `connect-provider-cell.svelte`)
- Table container height capped to show 5–6 rows, `overflow-y: auto`

**Search:** Reactive `searchQuery` state, filters `providers` with case-insensitive `displayName.includes()`.

**Connect behavior:** Clicking "Connect" closes the dialog first, then initiates the connect flow:
- **OAuth:** Popup to `/api/link/v1/oauth/authorize/{providerId}` with `redirect_uri=/oauth/callback`. Listen for `message`/`storage` events. On success → `invalidateAll()`.
- **App install:** Same popup pattern, URL is `/api/link/v1/app-install/{providerId}/authorize`.
- **API key:** Render `LinkAuthModal` after dialog closes. On success → `invalidateAll()`.

Move the connect logic from `connect-provider-cell.svelte` into this component (or extract shared helpers if cleaner).

### 2. Simplify `+page.svelte`

**Remove:**
- `IntegrationRow` union type — table rows are just credentials again
- Unconnected row generation (the `Set`-based filtering of providers without credentials)
- Conditional column rendering (`row.kind === "connected"` checks)
- Imports of `ConnectProviderCell` and `ProviderNameCell`

**Add:**
- Import and render `AddIntegrationDialog`, passing `data.providers`
- Place `AddIntegrationDialog` below the credentials table — its trigger is `Dialog.Trigger` wrapping `<Button noninteractive>` ("Add Integration")

**Keep:**
- Connected credentials table columns as they were before the original plan (logo, provider details, edit, delete)
- Empty state guard — show message when no credentials, with "Add Integration" still accessible
- OAuth redirect handling on mount (`credential_id` URL param cleanup + `invalidateAll()`)
- All env vars / advanced settings sections unchanged

### 3. Delete unused components

- `connect-provider-cell.svelte` — connect logic moves into `add-integration-dialog.svelte`
- `provider-name-cell.svelte` — no longer needed (dialog table renders provider name directly)

## Files Changed

| File | Action |
|------|--------|
| `apps/web-client/src/routes/(app)/settings/+page.svelte` | Modify — remove unified row type, simplify table back to connected-only, add `AddIntegrationDialog` |
| `apps/web-client/src/routes/(app)/settings/(components)/add-integration-dialog.svelte` | Create — searchable dialog with provider table and connect flows |
| `apps/web-client/src/routes/(app)/settings/(components)/connect-provider-cell.svelte` | Delete — logic absorbed into dialog |
| `apps/web-client/src/routes/(app)/settings/(components)/provider-name-cell.svelte` | Delete — no longer needed |

## Verification

1. Load settings page — only connected credentials in the table, "Add Integration" button visible
2. Click "Add Integration" — dialog opens with all providers listed in a table, search bar at top
3. Type in search bar — table filters client-side by provider name
4. Click "Connect" on an OAuth provider — dialog dismisses, popup opens, complete flow, main table refreshes
5. Block popup → fallback link → same-tab redirect → returns to settings with credential connected
6. Click "Connect" on an API key provider — dialog dismisses, API key modal appears, submit, main table refreshes
7. No credentials connected — empty state shown with "Add Integration" button still accessible
8. Dialog table shows 5–6 rows at a time, scrolls for longer lists
