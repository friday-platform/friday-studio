<!-- v3 - 2026-04-24 - Generated via /improving-plans from docs/plans/2026-04-24-mcp-detail-credential-management-design.v2.md -->

# MCP Server Detail — Credential Management Panel

## Problem Statement

Users manage credentials for MCP servers via inline `connect_service` cards in the chat flow. There is no centralized place in the MCP catalog to see which credentials are already connected, replace expired tokens, or add new ones without triggering a chat message. This forces users to either:

- Start a chat specifically to trigger a `connect_service` prompt just to rotate an API key.
- Have no visibility into which servers have active credentials vs. which still need setup.

Additionally, replacing an API key or re-authenticating an OAuth credential currently requires deleting the old credential (which gets a new ID) and creating a new one, breaking any workspace configs that referenced the old credential by ID.

## Solution

Add a **Credentials** section to the MCP server detail pane. It shows existing credentials for the server's providers, allows adding new ones, and supports replacing secrets in-place so workspace references stay intact.

- The section appears **only** for servers whose `configTemplate.env` contains `LinkCredentialRef` values — i.e., servers that actually need Link-managed credentials.
- It discovers **all unique provider IDs** from those refs and groups the UI by provider. Most servers have one provider; custom servers may have multiple.
- For each provider, it lists all credentials with type, label, status, and action buttons.
- For **API key** providers: an inline form to add a new credential, and a **Replace** action on existing credentials that opens the same form with the existing label shown as static text and calls `PATCH` to overwrite the secret while preserving the ID.
- For **OAuth** providers: a **Re-authenticate** button that triggers the OAuth popup. The existing Link callback flow uses `storage.upsert()`, so re-authenticating with the same identity automatically replaces the token in-place.
- For **app-install** providers: same pattern as OAuth — **Re-install** triggers the app-install popup; the internal flow handles in-place replacement.
- Each credential row shows a **status badge** (`ready`, `expired`, `unknown`) so users know whether the credential is healthy or needs attention.
- Each credential row has a **Remove** action.
- If a server's `LinkCredentialRef` uses an `id`-based reference (no `provider` field), the panel shows a read-only note explaining that the credential is managed by ID and should be handled in Settings > Connections.

## User Stories

1. As a Friday user, I want to see which credentials are already connected for an MCP server, so that I know whether it is ready to use in workspaces.
2. As a Friday user, I want to add a new API key credential for an MCP server from its detail page, so that I don't have to start a chat just to trigger a `connect_service` prompt.
3. As a Friday user, I want to replace an expired API key credential in-place, so that workspace configs referencing it continue to work without manual updates.
4. As a Friday user, I want to re-authenticate an OAuth-based MCP server when its token expires, so that the credential is refreshed without changing its ID.
5. As a Friday user, I want to remove a credential I no longer need, so that it stops being used by workspaces.
6. As a Friday user, I want the MCP server detail page to clearly show when no credentials are connected, so that I understand the server is not yet usable.
7. As a Friday user, I want to see the label, type, and health status of each connected credential, so that I can distinguish multiple credentials for the same provider and know which ones need attention.
8. As a Friday user, I want the OAuth popup to have a full-page redirect fallback if my browser blocks popups, so that I can still complete the flow.
9. As a Friday user, I want to see a loading state while credential operations are in progress, so that I know the UI is responding.
10. As a Friday user, I want error messages from credential operations to appear inline in the panel, so that I don't lose context by looking elsewhere for toast notifications.
11. As a Friday developer, I want the credential UI logic to be shared between the chat `connect_service` component and the MCP detail page, so that bug fixes and feature changes apply to both surfaces automatically.
12. As a Friday developer, I want the shared query layer to handle Link API schema validation and query invalidation automatically, so that credential lists stay fresh after any mutation.
13. As a Friday developer, I want the Link `PATCH /v1/credentials/:id` endpoint to accept a `secret` field, so that the public API supports in-place secret replacement.
14. As a Friday developer, I want the MCP detail view's credential panel to derive provider IDs from the server's `LinkCredentialRef` values, so that it works for both registry-imported and custom-added servers without additional configuration.
15. As a Friday developer, I want the shared credential primitives (popup handlers, form generation, callback listeners) extracted into a reusable module, so that both chat cards and detail panels consume the same logic.
16. As a Friday developer, I want the URL construction for OAuth and app-install authorization to live in a single place, so that popup fallback redirects never drift from the popup URL.

## Implementation Decisions

### Backend — Extend Link `PATCH` endpoint

The existing `PATCH /v1/credentials/:id` route only accepts `{ displayName }` and calls `storage.updateMetadata()`. We extend the request schema to also accept `{ secret }`:

- `displayName` only → rename (existing behavior).
- `secret` only → read the existing credential via `storage.get()` to obtain its `provider`, look up the provider definition in the registry, validate the secret against the provider's `secretSchema`, then call `storage.update(id, { ...existing, secret }, userId)`. This overwrites the secret while preserving `id`, `isDefault`, `provider`, `label`, and `createdAt`.
- Both → rename + replace secret in one request.
- Neither → 400, at least one field must be provided.

The request body schema is updated so that both `displayName` and `secret` are optional, with a `.refine()` ensuring at least one is present:

```ts
z.object({
  displayName: z.string().min(1).max(100).optional(),
  secret: z.record(z.string(), z.unknown()).optional(),
}).refine((data) => data.displayName !== undefined || data.secret !== undefined, {
  message: "At least one of displayName or secret must be provided",
})
```

**No health check on PATCH.** Unlike `PUT /v1/credentials/:type`, the PATCH endpoint does **not** run the provider's `health()` check after validating the secret schema. This is intentional: a user may replace a credential with a key that is not yet active on the provider side (provisioning in progress, not yet enabled). Rejecting at PATCH time would block legitimate workflows. Invalid secrets surface later at runtime when the MCP server actually uses them.

The `storage.update()` method already exists on all storage adapters (filesystem, cypher) and preserves the ID. No storage-layer changes are needed.

OAuth and app-install flows already use `storage.upsert()` internally, which preserves the ID when re-authenticating with the same identity. No changes needed for those paths.

### Backend — Enhance `GET /v1/summary` with status

The `GET /v1/summary?provider=xxx` endpoint returns credential summaries. We add a lightweight, **read-only** `status` field to each summary entry. The endpoint **never** attempts token refresh or storage mutation:

- `"ready"` — credential is active and unexpired. For API key credentials this is the default. For OAuth/app-install, the token's `expires_at` (if present) is beyond the current time plus a 5-minute buffer, or the token has a `refresh_token` (runtime will refresh when used).
- `"expired"` — OAuth/app-install token is past expiry and has no `refresh_token` available (permanent expiration).
- `"unknown"` — status could not be determined (fallback for malformed secrets or missing expiry metadata).

This is computed at read time by inspecting the credential's `type`, `secret.expires_at`, and `secret.refresh_token`. No schema or storage changes are required beyond extending the response serialization. The `CredentialSummarySchema` in `apps/link/src/types.ts` is extended with an optional `status` field so types and Zod parsing stay aligned. The response shape remains backward-compatible — consumers that ignore `status` continue to work.

### Shared Credential UI Primitives

The chat `connect-service.svelte` component already implements OAuth popup management, app-install popup management, API-key form generation from `secretSchema`, fallback redirect logic, and callback listeners. Rather than duplicating this in a new panel component, we extract reusable primitives.

**`oauth-popup.ts` — URL builders**
Before the rune can expose a `blockedUrl`, `oauth-popup.ts` must export URL generation functions that mirror the popup-openers without actually opening windows:

```ts
export function getOAuthUrl(provider: string): string
export function getAppInstallUrl(provider: string): string
```

These build the same authorization URLs used by `startOAuthFlow` and `startAppInstallFlow`, including the `redirect_uri` query param. This keeps URL construction in one place and prevents drift between popup and fallback-redirect paths.

**`useCredentialConnect(providerId)`** — a Svelte rune that returns:
- `startOAuth()` / `startAppInstall()` — trigger popup with fallback redirect handling
- `popupBlocked` / `blockedUrl` — reactive state for fallback UI; `blockedUrl` is computed via the new `getOAuthUrl` / `getAppInstallUrl` helpers
- `listenForCallback(onSuccess)` — manages `listenForOAuthCallback` lifecycle
- `submitApiKey(label, secret)` — PUT to `/v1/credentials/apikey`
- `submitting` / `error` — reactive loading and error state

The chat `connect-service.svelte` is refactored to consume `useCredentialConnect()` + `CredentialSecretForm`. The MCP detail panel uses the same primitives. This is a pure code-move with no user-visible change to the chat card.

**`CredentialSecretForm.svelte`** — a presentational component that:
- Receives `secretSchema`, `initialLabel?` (display-only), `submitting`, `error`, and `onSubmit(label, secret)` props
- Renders a **static label display** when `initialLabel` is provided (replace mode), or a label input when it is absent (add-new mode)
- Renders dynamic fields from `secretSchema.properties`
- Handles required-field validation client-side before submit
- Renders inline error messages and loading states

### Shared Query Layer

Two modules follow the existing playground convention (`mcp-queries.ts` for factories, `mcp.ts` for mutations):

**`link-provider-queries.ts`** — query option factories:
- `providerDetails(providerId)` — query for provider metadata (type, displayName, description, secretSchema).
- `credentialsByProvider(providerId)` — query for all credential summaries for a provider, including the new `status` field.

**`link-credentials.ts`** — mutation hooks:
- `useDeleteCredential()` — mutation wrapping `DELETE /v1/credentials/:id`.
- `useUpdateCredentialSecret()` — mutation wrapping `PATCH /v1/credentials/:id` with `{ secret }`.

All mutations invalidate `credentialsByProvider` queries on success.

Zod schemas in both files align with Link's public API shapes (e.g., `CredentialSummarySchema` from `apps/link/src/types.ts` with the added `status` field).

### MCP Credentials Panel Component

A new Svelte component rendered inside the MCP server detail pane when the server has Link credential refs.

**Discovery logic:** The panel scans `configTemplate.env` for `LinkCredentialRef` values.
- If the ref contains a `provider` field, the provider ID is collected for grouping.
- If the ref contains only an `id` field (no `provider`), the panel renders a read-only subsection:
  "This server references a credential by ID. Manage it in Settings > Connections."
- Each unique `provider` gets its own interactive subsection.

**Per-provider subsection:**
- Header: provider display name (fetched via `providerDetails`).
- Credential list: renders rows with label, type badge, status badge, and action buttons.
  - **Replace** (API key) — opens `CredentialSecretForm` with the existing label shown as static text (not editable). On submit, calls `useUpdateCredentialSecret` to overwrite the secret. The label is immutable during replacement because it is the identity key used by Link's upsert logic.
  - **Re-authenticate / Re-install** (OAuth / app-install) — calls `startOAuth()` / `startAppInstall()` from `useCredentialConnect`. On callback, `upsert` handles token replacement.
  - **Remove** — calls `useDeleteCredential` with a confirmation dialog.
- **Add new:**
  - OAuth / app-install → **Connect** / **Install** button with popup + fallback redirect.
  - API key → `CredentialSecretForm` (editable label + fields from `secretSchema`). On submit, calls `PUT /v1/credentials/:type` to create a new credential.
- **Empty state:** "No credentials connected for {providerName}. Add one to use this server in workspaces."

**Status badges:**
- `ready` → green dot / no badge (default healthy state).
- `expired` → yellow/orange warning badge with tooltip "Re-authenticate to refresh."
- `unknown` → gray badge (no health data available, typically API keys).

### Module Boundaries

**`useCredentialConnect()`**
- **Interface:** Receives `providerId`. Returns reactive state and action functions for OAuth, app-install, and API-key flows.
- **Hides:** Popup window management and fallback redirect logic, callback listener lifecycle, fetch calls to Link endpoints, form submission state machine.
- **Trust contract:** A consumer passes a provider ID and calls the returned functions. On success, the consumer's `onConnected` callback fires. On popup block, `popupBlocked` flips true and `blockedUrl` provides the fallback redirect target. The consumer does not need to know whether the provider is OAuth or API key.

**`CredentialSecretForm.svelte`**
- **Interface:** Receives `secretSchema`, `initialLabel?` (display-only), `submitting`, `error`, `onSubmit(label, secret)`.
- **Hides:** Field generation from JSON Schema, required-field validation, password masking for sensitive keys, loading spinner rendering.
- **Trust contract:** The parent provides a schema and a submit handler; the form validates client-side before invoking the handler and surfaces errors inline.

**`mcp-credentials-panel.svelte`**
- **Interface:** Receives `serverId` and `configTemplate` props. Renders grouped credential lists + add/replace/remove UI. No callbacks to parent.
- **Hides:** Provider type discovery (OAuth vs API key vs app-install), provider grouping logic, all `useCredentialConnect` calls, all TanStack Query key conventions, all Link API paths, id-based ref edge-case messaging.
- **Trust contract:** The parent passes a server config and the panel handles everything else. On any credential change, the panel refreshes its own state. The parent does not need to know how many providers the server references.

**Link `PATCH` route handler**
- **Interface:** Accepts `displayName` and/or `secret` for an existing credential ID. Returns the updated credential summary.
- **Hides:** The `storage.update()` call, schema validation against the provider's `secretSchema`, and the distinction between rename-only and replace-only requests.
- **Trust contract:** On 200, the credential's secret has been overwritten and the ID is unchanged. On 400, the input failed schema validation or neither field was provided. On 404, the credential does not exist. No health check is performed — the secret is accepted as-is.

### Data Isolation

Not applicable. The MCP registry and Link credentials are single-tenant daemon resources. No user-scoped database tables are involved.

## Testing Decisions

**Link route integration tests** (extend existing Link test suite):
- `PATCH /v1/credentials/:id` with `secret` only → 200, credential updated, `id` unchanged, `createdAt` unchanged.
- `PATCH /v1/credentials/:id` with both `displayName` and `secret` → 200, both updated.
- `PATCH /v1/credentials/:id` with invalid `secret` (fails provider schema) → 400.
- `PATCH /v1/credentials/:id` for non-existent credential → 404.
- `PATCH /v1/credentials/:id` with neither `displayName` nor `secret` → 400.
- `GET /v1/summary?provider=xxx` returns credentials with `status` field → status is `"ready"` for fresh API key, `"unknown"` when no health metadata exists.
- `GET /v1/summary` for expired OAuth token without `refresh_token` → status is `"expired"`.
- `GET /v1/summary` for expired OAuth token with `refresh_token` → status is `"ready"` (refreshable at runtime).

**Client-side shared query tests** (new Vitest tests for `link-provider-queries.ts` and `link-credentials.ts`):
- `providerDetails` factory produces correct query key and parses response.
- `credentialsByProvider` filters by provider query param and parses `status`.
- `useDeleteCredential` invalidates credentials query on success.
- `useUpdateCredentialSecret` invalidates credentials query on success.

**`useCredentialConnect` unit tests**:
- `startOAuth()` opens popup with correct URL.
- `popupBlocked` flips true when `window.open` returns null.
- `blockedUrl` matches the URL returned by `getOAuthUrl()`.
- `submitApiKey()` calls PUT with correct body and flips `submitting` state.
- Callback listener cleanup runs on rune disposal.

**`CredentialSecretForm` component tests**:
- Renders label input when `initialLabel` is absent.
- Renders static label text when `initialLabel` is present.
- Generates fields from `secretSchema.properties` and validates required fields before calling `onSubmit`.

**Playground route integration tests**:
- MCP detail page renders credential panel when server has `LinkCredentialRef` env values.
- MCP detail page omits credential panel when server has no `LinkCredentialRef` env values.
- MCP detail page shows id-based ref notice when server has only `id`-based refs.
- Adding an API key credential from the panel → new credential appears in list.
- Replacing an API key credential → list refreshes, ID unchanged.
- Removing a credential → confirmation dialog appears, list refreshes after deletion.
- Multi-provider server → panel renders separate subsection per provider.
- Expired OAuth credential → status badge renders warning indicator.

**Manual smoke tests**:
- Registry-imported server with env vars → panel appears, add API key, verify workspace can resolve it.
- OAuth server → panel appears, click Connect, complete OAuth flow, verify credential appears with `ready` status.
- Re-authenticate same OAuth identity → verify credential ID is unchanged via Link internal GET.
- Custom-added server with API key provider → same panel behavior as registry-imported.
- Custom server with two different provider refs → panel shows two grouped sections.
- Browser blocks popup → fallback redirect URL matches popup URL, flow completes successfully.

## Out of Scope

- **Editing credential labels or display names** — focused on secret replacement; renaming can be added later.
- **Setting a credential as default** — explicitly excluded per product decision.
- **Bulk credential operations** — one at a time.
- **Credential health checks during creation** — PUT already runs health checks; PATCH intentionally skips them.
- **Changing the provider type of an existing credential** — not supported by Link.
- **Link storage adapter interface changes** — `update()` and `upsert()` already support in-place replacement.
- **Global popup manager / popup deduplication** — out of scope; both chat card and panel can independently open popups.

## Further Notes

### Why provider-based refs make this safe

Both registry import and custom server addition generate `configTemplate.env` with provider-based `LinkCredentialRef` values: `{ from: "link", provider: "<server-id>", key: "..." }`. These refs resolve at runtime via `fetchDefaultCredential(provider)`, which looks up the default credential for that provider. Because workspaces use the provider name (not a fixed credential ID), deleting and re-adding a credential, or replacing it in-place, never breaks workspace configs.

ID-based refs (`{ from: "link", id: "cred_abc", key: "..." }`) are brittle to credential churn, but they are not generated by the MCP registry flows. The panel detects id-based refs and shows a read-only notice rather than leaving an unexplained empty space.

### OAuth re-authentication already preserves IDs

The Link OAuth callback flow calls `storage.upsert(credentialInput, userId)`. The filesystem adapter's `upsert()` matches on `provider + label` composite key. For OAuth credentials, the `label` is typically the user's email or account identifier. Re-authenticating with the same identity produces the same label, so `upsert()` finds the existing credential and calls `update()` — preserving the ID. The UI only needs to trigger the popup; the backend handles in-place replacement automatically.

### App-install re-installation already preserves IDs

The app-install service explicitly calls `storage.update(existingCredential.id, result.credential, userId)` when it finds an existing credential by `externalId`. Same behavior as OAuth — the UI triggers the flow, the backend preserves the ID.

### Multi-provider grouping rationale

Most servers reference a single provider. The grouping UI is defensive: if a custom server references two providers, the user sees two clearly labeled sections rather than a single mixed list that is ambiguous. If there is only one provider, the group header is elided for visual simplicity — the section title "Credentials" is sufficient.

### URL builder extraction rationale

`connect-service.svelte` currently reconstructs the OAuth authorize URL manually in its fallback redirect handler. This duplicates the logic in `startOAuthFlow` and will drift when endpoint paths or query params change. Extracting `getOAuthUrl` and `getAppInstallUrl` into `oauth-popup.ts` gives the rune a single source of truth for `blockedUrl`, eliminates the duplication, and makes the fallback path testable without mocking `window.open`.
