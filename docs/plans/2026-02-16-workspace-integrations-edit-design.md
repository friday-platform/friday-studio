## Problem Statement

Workspace configs reference external credentials (GitHub, Slack, etc.) through
`LinkCredentialRef` objects in MCP server and agent env vars. There's no way to
see or manage these credential bindings from the space edit screen. Users have to
know which integrations a workspace needs and manually ensure they're connected
before running it.

## Solution

Add an "Integrations" section to the space edit page that lists every provider
the workspace requires, shows whether each is connected, and lets the user
connect or replace credentials directly.

## User Stories

1. As a workspace owner, I want to see which integrations my workspace requires,
   so that I know what needs to be connected before it can run
2. As a workspace owner, I want to see which integrations are currently
   connected, so that I know the workspace is ready
3. As a workspace owner, I want to connect a missing integration from the edit
   page, so that I don't have to leave the space context
4. As a workspace owner, I want to replace an existing credential with a
   different one, so that I can rotate keys or switch accounts
5. As a workspace owner, I want the connect flow to go directly to the right
   provider (OAuth popup, API key modal, etc.), so that I don't have to search
   through a list of all providers
6. As a workspace owner, I want the new credential automatically bound to all
   places in my workspace config that reference that provider, so that I don't
   have to update each MCP server or agent individually

## Implementation Decisions

### Type export for workspace config routes

The workspace config routes (`configRoutes` in
`apps/atlasd/routes/workspaces/config.ts`) are exported as a value but not as a
type. Add `WorkspaceConfigRoutes` type export, re-export from `apps/atlasd/mod.ts`,
and add to the RPC client in `packages/client/v2/mod.ts` so the edit page can use
typed calls for credential fetching.

### Data loading

The edit page gets a new `+page.ts` loader that fetches:

1. Credential usages via `GET /api/workspaces/:workspaceId/config/credentials`
   (returns `CredentialUsage[]` with path, credentialId, provider, key)
2. Provider details via `GET /api/link/v1/providers/:id` for each unique provider

Both fetched in parallel. The workspace object itself is already available from
the layout loader.

### Grouping by provider

Multiple credential paths can reference the same provider (e.g.
`mcp:github:GITHUB_TOKEN` and `agent:researcher:GH_TOKEN` both reference
`github`). The UI groups by provider and shows one row per unique provider.

A provider is "connected" when **all** its credential paths have a
`credentialId`. If any path is missing an ID, the provider shows as not
connected.

### Table UI

New "Integrations" section between "General" and "Actions" on the edit page.
Table structure:

| Provider icon | Provider name | Connect / Replace button |

- The `Logo` component and `ProviderDetails` component currently live in
  `settings/(components)/`. Move both to `$lib/modules/integrations/` so both
  pages can share them (along with the existing `getServiceIcon` already there)
- Row styling matches the settings page credentials table (large rows, no
  header)
- If the workspace has zero credential refs, the Integrations section is not
  rendered at all

### Connect / Replace flow

Both buttons trigger the same flow - connect a credential for the target
provider:

- **OAuth** providers: open popup via daemon authorize URL
- **App install** providers: open popup via app-install authorize URL
- **API key** providers: open `LinkAuthModal` with the provider's secret field

On success, the new credential ID is bound to **all** paths for that provider
via `PUT /config/credentials/:path`. For providers with multiple paths, each
path is updated sequentially.

After binding, the page data is invalidated to reflect the new state.

### No unbind/remove action

The edit screen is strictly for connecting credentials to the workspace. There
is no concept of unbinding or removing a credential from this screen. Credential
revocation is a global action done from the Settings page. If a credential is
removed globally, any workspace referencing it will naturally break until a new
one is connected.

## Testing Decisions

Good tests verify observable behavior through the component's public interface,
not implementation details.

- **Edit page loader**: test that it fetches credential usages and provider
  details, and correctly surfaces the data
- **Provider grouping logic**: test that multiple paths for the same provider
  collapse into one row, and connected status is computed correctly (all paths
  need IDs)
- **Credential binding after connect**: test that all paths for a provider are
  updated when a new credential is connected
- Prior art: `apps/atlasd/routes/workspaces/config-credentials-put.test.ts` for
  credential update tests

## Out of Scope

- Selecting from existing credentials that match the provider (next iteration)
- Global credential management (already handled in Settings page)
- Workspace config file editing (workspace.yml is managed by the daemon)
