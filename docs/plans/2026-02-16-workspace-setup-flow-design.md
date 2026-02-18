## Problem Statement

When a user uploads a workspace YAML that references credentials they haven't
connected yet, the workspace creation fails with `missing_credentials`. The user
has to connect the integrations first (via a modal dialog), then retry. This
blocks workspace creation on credential resolution, which is friction —
especially for shared/exported workspace configs where the uploader may not have
credentials ready yet.

## Solution

Skip credential validation during workspace creation. Always create the
workspace and redirect to its detail page. If the workspace has unresolved
credentials, the detail page shows a one-time setup flow: workspace title,
description, an integrations table (same pattern as the edit page), and a
"Complete Setup" button. Once all credentials are connected and the user clicks
Complete Setup, the flag is cleared and the normal workspace view renders. If
credentials break later (revoked, expired), the setup screen does not reappear —
that's a different problem handled elsewhere.

## User Stories

1. As a user importing a workspace, I want the workspace to be created
   immediately regardless of missing credentials, so that I'm not blocked by
   integration setup during upload
2. As a user with a newly created workspace that needs credentials, I want to
   see which integrations are required on the workspace page, so that I know
   what to connect
3. As a user on the setup page, I want to connect each missing integration
   directly (OAuth popup, app install, or API key entry), so that I don't have
   to leave the workspace context
4. As a user on the setup page, I want the Connect button to automatically bind
   the new credential to all config paths referencing that provider, so that I
   don't have to update each MCP server or agent individually
5. As a user who has connected all required integrations, I want to click
   "Complete Setup" to finalize and see the normal workspace view, so that I
   have a clear transition from setup to ready
6. As a user whose workspace credentials break after setup, I want the setup
   screen to NOT reappear, so that I can still access my workspace and fix
   credentials through the edit page instead
7. As a user creating a workspace with no credential requirements, I want the
   workspace to skip the setup flow entirely and go straight to the normal view,
   so that the experience is unchanged for simple workspaces
8. As a user on the setup page, I want to see the workspace title and
   description, so that I know which workspace I'm setting up

## Implementation Decisions

### `requires_setup` flag

A boolean stored in workspace metadata (`workspace.metadata.requires_setup`).
Set by the server at creation time based on whether any credential providers are
unresolved. Cleared by a dedicated endpoint when the user completes setup.

This is a one-time flag — it only gates the initial setup flow, not ongoing
credential health.

### Server: `POST /create` changes

Current behavior: extracts credentials, resolves each provider, fails with
`missing_credentials` if any are unresolved.

New behavior:

1. Extract credentials, find unique providers, attempt to resolve each
2. Providers that resolve: build `credentialMap`, run `toIdRefs` for those
3. Providers that don't resolve: leave refs as-is (provider-only, no `id`)
4. Set `requires_setup: true` in metadata if any providers were unresolved
5. Set `requires_setup: false` (or omit) if all resolved or no credentials
   needed
6. Always create the workspace and return 200

The `invalid_credential_keys` check is also deferred — if a credential resolves
but has wrong keys, treat it as unresolved and include that provider in setup.

### Server: new `POST /workspaces/:workspaceId/setup/complete` endpoint

1. Fetch workspace config, run `extractCredentials`
2. Group by provider, check every provider has all paths with a `credentialId`
3. If all good: set `requires_setup: false` in metadata, return 200
4. If not: return 422 with the still-missing providers

### Client: `add-workspace.svelte` changes

Remove `MissingCredentialsDialog` usage and `CredentialRetryState`. On
successful `POST /create`, always redirect to `/spaces/[spaceId]`. The setup
page handles credential resolution.

### Client: `/spaces/[spaceId]` page changes

**Loader (`+page.ts`):**

- Check `workspace.metadata.requires_setup`
- If `true`: fetch credential usages and provider details (same logic as edit
  page loader — group by provider, fetch provider details from Link)
- If `false`: fetch sessions and artifacts as before

**Page (`+page.svelte`):**

- If `requires_setup` is true, render the setup layout instead of normal content:
  - Workspace title
  - Workspace description
  - Integrations table (same component/pattern as edit page — provider icon,
    provider name, Connect/Replace button per row)
  - "Complete Setup" button, disabled until all providers show connected
- If `requires_setup` is false, render the normal workspace detail page
- The page is fully locked during setup — no edit, delete, or other actions
  available

**Connect flows** reuse the same mechanisms as the edit page:

- OAuth providers: popup via daemon authorize URL
- App install providers: popup via app-install authorize URL
- API key providers: `LinkAuthModal` inline
- On success: bind credential to all paths for that provider via
  `PUT /config/credentials/:path`, then invalidate page data

**"Complete Setup" button:**

- Enabled only when every provider row shows connected
- Calls `POST /setup/complete`
- On success: invalidates page data, page re-renders as normal workspace view

### No changes to

- The edit page (still works independently for post-setup credential management)
- The chat page (no credential gating)
- The sidebar/nav (workspace appears normally in the list)
- The export flow (unrelated)

## Testing Decisions

Good tests verify observable behavior through the component's public interface,
not implementation details.

- **`POST /create` with missing credentials**: test that workspace is created
  with `requires_setup: true` instead of returning 400
- **`POST /create` with all credentials resolved**: test that
  `requires_setup` is false/absent
- **`POST /setup/complete` with all creds connected**: test it sets
  `requires_setup: false` and returns 200
- **`POST /setup/complete` with missing creds**: test it returns 422 with
  unresolved providers
- **Setup page loader**: test that it fetches credential usages and provider
  details when `requires_setup` is true, and fetches sessions/artifacts when
  false
- Prior art: `apps/atlasd/routes/workspaces/export.test.ts` and
  `apps/atlasd/routes/workspaces/config-credentials-put.test.ts`

## Out of Scope

- Runtime credential health monitoring (broken creds after setup)
- Selecting from multiple existing credentials for the same provider
- Credential management from the setup page (no unbind/remove)
- Changes to the chat page or sidebar

## Further Notes

The `MissingCredentialsDialog` and `CredentialRetryState` in
`apps/web-client/src/lib/modules/spaces/` become dead code after this change
and can be removed.
