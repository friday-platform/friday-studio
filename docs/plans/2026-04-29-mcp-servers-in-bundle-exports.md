# MCP Servers in Workspace Bundle Exports

**Date:** 2026-04-29
**Companion to:** `2026-04-20-workspace-bundles-export-research.md`, `2026-04-20-workspace-bundles-implementation-plan.md`, `2026-04-21-full-instance-export-plan.md`, `2026-04-22-mcp-registry-import-design.v4.md`, `2026-04-24-mcp-custom-server-add-design.v2.md`
**Purpose:** Extend workspace bundle export/import to include MCP Registry Entries and their Link Provider wiring, so exported workspaces are credential-ready on re-import: `connect_service` can collect fresh credentials, but credential values are never migrated.

---

## Problem Statement

As a Friday user, I export a workspace that uses MCP servers (e.g., GitHub, Linear, Notion) and re-import it on a fresh machine. The workspace.yml arrives with `tools.mcp.servers` references intact, but the target daemon has no MCP Registry Entries for those servers and no Link Providers for their credentials. `connect_service` fails silently or produces cryptic auth errors. I have to manually re-install every MCP Registry Entry before reconnecting credentials, defeating the purpose of a portable bundle.

## Solution

MCP Registry Entry metadata travels with bundles. On export, referenced Dynamic MCP Registry Entries are serialized into the archive. On import, they are restored to the target daemon's registry and their Link Providers are recreated. The result is a self-contained workspace that boots with its MCP tooling registered and ready for `connect_service` to collect fresh credentials.

Two scopes:
- **Single-workspace bundles** carry only the MCP servers actually referenced by that workspace (`tools.mcp.servers` keys).
- **Full-instance bundles (`bundle-all`)** carry **all** dynamic MCP registry entries in a global slot, plus each workspace's referenced entries inside the per-workspace inner zip.

Link provider creation inputs are preserved via an optional field on `MCPServerMetadata`, making re-import deterministic without heuristics.

---

## User Stories

1. As a Friday user, I want my exported workspace to include the MCP servers it uses, so that re-importing on another machine preserves my tool integrations.
2. As a Friday user, I want exported MCP servers to retain their descriptions, security ratings, and configuration templates, so that the target daemon's catalog shows the same metadata I had.
3. As a Friday user, I want the OAuth and API-key Link Providers for my MCP Registry Entries to be recreated on import, so that `connect_service` prompts me for exactly the right fresh credentials.
4. As a Friday user, I want imported MCP servers to collide gracefully with existing entries — skipping rather than overwriting — so that my target instance's registry stays safe.
5. As a Friday user, I want a full-instance export to include every MCP server I've ever added (not just referenced ones), so that my complete registry is backed up.
6. As a Friday user, I want the import summary to tell me which MCP servers were added, skipped, or had Link provider errors, so that I know what needs manual attention.
7. As a Friday user, I want registry-imported MCP servers (from `registry.modelcontextprotocol.io`) to retain their upstream provenance on re-import, so that "check for updates" and "pull update" still work.
8. As a Friday user, I want custom-added MCP servers (paste-JSON or HTTP URL) to be fully portable, so that my hand-configured servers don't require re-pasting.
9. As a Friday user, I want blessed/static MCP servers to NOT be included in exports, so that bundle size stays small and binary-shipped entries are supplied by the target daemon.
10. As a Friday engineer, I want the bundle format to treat MCP server JSON as opaque files (hash + path), so that the `@atlas/bundle` package doesn't depend on `@atlas/core` MCP schemas.
11. As a Friday engineer, I want the `MCPServerMetadata` schema to carry an optional `linkProvider` field, so that the exact Link Provider creation input is preserved round-trip through the MCP registry storage adapter.
12. As a Friday engineer, I want the install and custom-add routes to persist `linkProvider` at creation time, so that subsequent exports capture it.
13. As a Friday engineer, I want import to treat Link Provider 409 as success only when the existing provider's public shape matches the bundled provider, so that re-importing the same bundle is idempotent without masking provider ID conflicts.
14. As a Friday engineer, I want import to fail when required Link Provider creation fails for any reason other than 409, so that an imported workspace is never reported as credential-ready when `connect_service` cannot work.
15. As a Friday engineer, I want the lockfile to record integrity hashes for embedded MCP server files, so that tampered bundles are rejected atomically.
16. As a Friday engineer, I want bundle-all to embed MCP servers in `global/mcp-servers/` and workspaces' referenced servers inside each per-workspace zip, so that single-workspace exports remain self-contained.
17. As a Friday engineer, I want the bundle-all manifest to reserve a `global.mcpServers` slot, so that future readers know where to find the global registry backup.
18. As a Friday engineer, I want old MCP entries that lack `linkProvider` (created before this feature) to export without Link recreation and report `provider-missing`; if a workspace references such an entry and its config requires Link credentials, that workspace import fails with a clear delete/re-add instruction.
19. As a Friday user, I want the playground settings page export/import to require zero UI changes, so that the backend handles everything transparently.
20. As a Friday user, I want re-imported workspaces with MCP servers to pass config validation immediately, so that I don't see resolver-check false positives on custom stdio servers.

---

## Implementation Decisions

### Summary of changes

| Layer | What changes |
|---|---|
| `packages/agent-sdk` | Export shared Dynamic Link Provider input schema from a focused subpath |
| `packages/core/mcp-registry/schemas.ts` | Add optional `linkProvider: DynamicProviderInputSchema.optional()` to `MCPServerMetadataSchema` |
| `apps/atlasd/routes/mcp-registry.ts` | Persist `linkProvider` through the MCP registry storage adapter at install/custom-add time |
| `packages/bundle/src/lockfile.ts` | Add `mcpServers` to `primitives` schema |
| `packages/bundle/src/bundle.ts` | Accept `mcpServers` option; embed `mcp-servers/` dir; hash + verify |
| `packages/bundle/src/bundle-all.ts` | Accept `global.mcpServers`; embed `global/mcp-servers/`; import global first |
| `apps/atlasd/routes/workspaces/bundle-helpers.ts` | Collect referenced MCP servers from workspace config; pass to `exportBundle` |
| `apps/atlasd/routes/workspaces/index.ts` | Route handlers: export passes adapter; import calls `adapter.add` + `createLinkProvider` |

### `linkProvider` persistence (prerequisite)

Add a focused `@atlas/agent-sdk` subpath export (for example `@atlas/agent-sdk/link-provider`) containing the Dynamic Link Provider input schemas/types. Both `apps/link` and `packages/core` import this shared schema; do not duplicate Link provider shape in `@atlas/core`.

`MCPServerMetadataSchema` gains:
```ts
linkProvider: DynamicProviderInputSchema.optional()
```

Zod v4 strips unknown keys by default — without this field, any stored `linkProvider` is silently dropped on read, making export impossible.

The `/install` and `/custom` routes are updated to include `linkProvider` when calling `adapter.add()`:
- Registry install: `linkProvider: translateResult.linkProvider` (undefined for Curated Upstream Overrides that route to static Link Providers)
- Custom HTTP URL: `linkProvider: { type: "oauth", ... }`
- Custom JSON with env: `linkProvider: { type: "apikey", ... }` (undefined if no env vars)

Old entries without `linkProvider` continue to work; they export without Link Provider recreation and the importer reports `provider-missing`. No export-time heuristics attempt to synthesize missing providers. For workspace-referenced entries whose config contains Link credential refs, `provider-missing` is a blocking workspace import error because the workspace cannot be credential-ready.

### Bundle format (single workspace)

```
<name>.zip
├── workspace.yml
├── workspace.lock
├── skills/...
├── agents/...
├── memory/...          (migration mode only)
└── mcp-servers/
    ├── <id>.json       # MCPServerMetadata (includes optional linkProvider)
    └── ...
```

Only Dynamic MCP Registry Entries are included. Blessed MCP Registry Entries are omitted — they are baked into the target daemon's binary. Workspace-only Enabled MCP Servers with no registry entry are not synthesized into registry metadata; their runnable config already travels in `workspace.yml`. If a workspace-only server config contains Link credential refs and no registry `linkProvider` exists, export fails with a clear instruction to add/install the MCP server through the registry first, because the bundle cannot be credential-ready.

`workspace.lock` records:
```yaml
primitives:
  skills: { ... }
  agents: { ... }
  mcpServers:
    <id>:
      hash: <sha256>
      path: mcp-servers/<id>.json
```

`mcpServers` is a new key in the `primitives` object. The hash covers the JSON file bytes.

### Bundle format (bundle-all)

```
atlas-full-export.zip
├── manifest.yml
├── workspaces/
│   └── <wid>.zip       # each contains its own mcp-servers/ (referenced only)
└── global/
    ├── skills.zip      (existing)
    └── mcp-servers/
        ├── <id>.json   # ALL dynamic entries
        └── ...
```

`manifest.yml`:
```yaml
reserved:
  global:
    skills: global/skills.zip
    memory: null
    mcpServers: global/mcp-servers
```

`mcpServers` is a string path (not a zip) because entries are individual JSON files.

### Export flow

**Single workspace (`GET /:workspaceId/bundle`)**:
1. `buildWorkspaceBundleBytes` extracts `Object.keys(config.workspace.tools?.mcp?.servers ?? {})` — referenced server IDs.
2. For each ID: skip if blessed (`mcpServersRegistry.servers[id]` exists); otherwise query the dynamic adapter.
3. If no Dynamic MCP Registry Entry exists:
   - If the workspace-only server config has no Link credential refs, include no registry metadata and continue; the runnable config remains in `workspace.yml`.
   - If it has Link credential refs, fail export as non-portable because no Link Provider blueprint exists.
4. Serialize each found entry to JSON bytes.
5. Pass `mcpServers: Array<{ id, jsonBytes }>` to `exportBundle`.
6. `exportBundle` hashes each file, writes to zip, records in lockfile.

**Bundle-all (`GET /bundle-all`)**:
1. Route handler queries `adapter.list()` for ALL Dynamic MCP Registry Entries, including entries not referenced by any workspace.
2. Passes them to `exportAll` as `global.mcpServers`.
3. `exportAll` embeds them in `global/mcp-servers/` and sets `manifest.reserved.global.mcpServers`.
4. Per-workspace inner bundles follow the single-workspace flow above (each carries only its referenced servers).

### Import flow

**Single workspace (`POST /import-bundle`)**:
1. `importBundle` extracts and verifies `mcp-servers/` files (hash check via lockfile).
2. Returns `primitives` entries with `kind: "mcp-server"`.
3. Route validates the materialized `workspace.yml`.
4. Route reads and validates every `mcp-servers/<id>.json` with `MCPServerMetadataSchema.parse()` before mutating registry state. The lockfile key, file path ID, `metadata.id`, and `metadata.linkProvider.id` (when present) must all match; mismatch is bundle corruption and blocks import.
5. Route processes bundled MCP Registry Entries before workspace registration:
   - Calls `await adapter.add(metadata)`.
   - On "already exists", fetches the existing registry entry and verifies it is compatible with the bundled metadata before reporting metadata as skipped.
   - Incompatible metadata collision is a blocking `registry_entry_conflict` error for workspace-referenced entries.
   - Tracks registry entries newly created by this import for rollback.
6. If `metadata.linkProvider` exists, attempt Link Provider creation whether metadata was added or skipped:
   - Validate `metadata.linkProvider.id === metadata.id` (corruption guard).
   - Call `createLinkProvider(metadata.linkProvider)`.
   - 409 → fetch the existing provider and compare public shape; compatible shape is success, mismatch is blocking `provider_conflict`.
   - Other errors → fail the import.
   - Track Link Providers newly created by this import for rollback.
7. If MCP Registry Entry or Link Provider processing fails, best-effort rollback deletes only registry entries and dynamic Link Providers created by this import. Pre-existing collisions are never deleted.
8. After MCP registry/provider processing succeeds, route runs the same provider-existence and credential-binding pass used by YAML workspace import:
   - Provider ID invalid/missing from Link registry → fail import with `provider_missing`.
   - Exactly one existing credential for a provider → bind it into the imported workspace config, matching YAML import behavior.
   - Multiple existing credentials → preserve provider-only refs and surface the same ambiguity/setup path as YAML import.
   - Provider exists but has no connected credential yet → proceed; the workspace is credential-ready and setup can call `connect_service`.
9. After provider-existence and credential-binding checks pass, route registers the workspace with the workspace manager.
10. If provider-existence checks or workspace registration fail, best-effort rollback deletes only registry entries and dynamic Link Providers created by this workspace import. Pre-existing collisions are never deleted.

Per-workspace MCP Registry Entry import is deliberately pre-registration with rollback so failed imports do not leave a registered workspace that cannot run `connect_service`, and failed workspace imports do not leave newly-created registry/provider cruft behind.

**Bundle-all (`POST /import-bundle-all`)**:
1. `importAll` extracts `global/mcp-servers/` if `manifest.reserved.global.mcpServers` is present. Returns paths in `ImportAllResult`.
2. Route handler processes global MCP Registry Entries first as a best-effort registry backup:
   - Successful global entries are added before workspace imports.
   - Failed global entries are reported under `globalMcpServers` and any records created for that failed entry are rolled back.
   - Global failures do not block unrelated workspace imports.
3. Then iterates workspace bundles. Each workspace import may also have its own referenced `mcp-servers/`.
4. Collision on workspace-scoped entries: verify metadata compatibility, skip metadata registration when compatible (global already registered), and still attempt Link Provider creation if the workspace-scoped copy carries `linkProvider`.
5. Per-workspace referenced MCP Registry Entry or Link Provider failures block only that workspace import.
6. Report structure extended with explicit MCP result arrays and stable error codes:
   - Top-level bundle-all: `globalMcpServers: Array<{ id, status: "added" | "skipped" | "failed", code?: McpImportErrorCode, warning? }>`.
   - Single-workspace import response: `mcpServers: Array<{ id, status: "added" | "skipped" | "conflict", linkProviderStatus?: "created" | "exists" | "missing" | "conflict", code?: McpImportErrorCode, warning? }>`.
   - Bundle-all per imported workspace: same `mcpServers[]` shape nested on that workspace result.
   - Stable blocking error codes: `registry_entry_conflict`, `provider_conflict`, `provider_missing`, `link_provider_create_failed`.

### Collision policy

On import, if a server ID already exists in the target registry:
- Fetch the existing MCP Registry Entry and verify it is compatible with the bundled metadata before treating the collision as a safe skip.
- Compatibility compares operational fields only: `source`, `upstream.canonicalName` when present, `configTemplate`, `platformEnv`, and `requiredConfig`. Cosmetic catalog fields (`name`, `description`, `constraints`, `securityRating`, `readme`) are ignored. `linkProvider` shape is checked separately.
- Compatible collision: skip metadata registration; the target registry entry wins.
- Incompatible collision: fail workspace-referenced imports with `registry_entry_conflict`; for bundle-all global/unreferenced entries, report the global entry as failed without blocking unrelated workspaces.
- If the bundled metadata includes `linkProvider`, still attempt Link Provider creation after metadata compatibility passes.
- Treat Link 409 as success only after verifying the existing provider's credential-shape fields are compatible with the bundled `linkProvider`: same provider `type`; for API-key providers, same `secretSchema` keys/types; for OAuth providers, same discovery `serverUrl` and scopes set. Cosmetic fields (`displayName`, `description`, icons/docs URLs, setup instructions) are ignored.
- Treat Link Provider shape mismatches as blocking `provider_conflict` import errors.
- Treat non-409 Link Provider creation failures as blocking import errors.

This is non-destructive and idempotent without silently accepting same-ID/different-meaning registry collisions.

### Module Boundaries

**`packages/bundle/src/bundle.ts` — export/import primitive I/O**
- *Interface:* `exportBundle({ mcpServers?: Array<{ id, jsonBytes }> })` returns zip bytes; `importBundle()` returns primitives including `kind: "mcp-server"`.
- *Hides:* zip layout, hashing algorithm, lockfile serialization, file path conventions.
- *Trust contract:* every file in `mcp-servers/` is hashed and verified via lockfile. Opaque bytes — no schema knowledge.

**`packages/bundle/src/bundle-all.ts` — global archive assembly**
- *Interface:* `exportAll({ global?: { mcpServers?: Array<{ id, jsonBytes }> } })`; `importAll()` returns global file paths.
- *Hides:* outer zip layout, manifest schema, global vs per-workspace nesting.
- *Trust contract:* global MCP servers are extracted as paths; caller validates and processes.

**`apps/atlasd/routes/workspaces/bundle-helpers.ts` — workspace-level orchestration**
- *Interface:* `buildWorkspaceBundleBytes()` gains MCP collection; `materializeImportedMemory()` unchanged.
- *Hides:* how referenced server IDs are discovered from workspace config; adapter query logic; blessed vs dynamic classification.
- *Trust contract:* only referenced, non-blessed, found-in-adapter servers are passed to the bundle layer.

**`apps/atlasd/routes/mcp-registry.ts` — registry CRUD + Link wiring**
- *Interface:* `createLinkProvider()` is extracted to a reusable export (or shared module). Install/custom routes persist `linkProvider` through the MCP registry storage adapter.
- *Hides:* Link service URL discovery, auth header injection, HTTP retry policy, 409 shape verification, and error classification.
- *Trust contract:* on 201, the provider was created; on 409 with compatible shape, the provider already exists; on 409 with incompatible shape or any other error, the caller receives a blocking import error safe for UI display. Metadata registration and Link Provider creation are rolled back on blocking failures when they were created by the current import.

**`packages/core/mcp-registry/schemas.ts` — registry metadata schema**
- *Interface:* `MCPServerMetadataSchema` with optional `linkProvider` parsed through the shared `DynamicProviderInputSchema` from `@atlas/agent-sdk/link-provider`.
- *Hides:* Zod v4 stripping behavior for MCP Registry Entry metadata.
- *Trust contract:* metadata round-trips through registry storage without losing the `linkProvider` field.

**`packages/agent-sdk/link-provider` — Dynamic Link Provider input contract**
- *Interface:* `DynamicProviderInputSchema` and inferred input types used by both Link and MCP registry metadata.
- *Hides:* Link Provider input shape evolution from package-specific duplicate schemas.
- *Trust contract:* Link's provider creation route and MCP Registry Entry persistence validate the same wire shape.

### Data Isolation

Not applicable. The MCP registry is a single-tenant daemon resource behind `MCPRegistryStorageAdapter` (local Deno.Kv by default, Cortex when configured). No user-scoped database tables are involved.

---

## Testing Decisions

### Unit tests (package layer)

**`packages/bundle/src/bundle.test.ts`** — extend existing:
- Export with two MCP servers → zip contains `mcp-servers/a.json` and `mcp-servers/b.json`; lockfile records both hashes.
- Import with MCP servers → `primitives` includes `kind: "mcp-server"` entries; hash verification fails if JSON is tampered.
- Export without MCP servers → no `mcp-servers/` dir in zip; lockfile `mcpServers` is empty object.

**`packages/bundle/src/bundle-all.test.ts`** — extend existing:
- Export with `global.mcpServers` → outer zip contains `global/mcp-servers/` files; manifest `reserved.global.mcpServers` is populated.
- Import with global MCP servers → `ImportAllResult` includes global paths.

**`packages/core/src/mcp-registry/schemas.test.ts`** (new or extend):
- `MCPServerMetadataSchema.parse()` preserves `linkProvider` field round-trip.
- Metadata without `linkProvider` still validates (backward compat).

### Integration tests (route layer)

**`apps/atlasd/routes/workspaces/bundle.test.ts`** (new file, or extend existing export test):
- Export a workspace referencing a dynamic MCP server → zip includes the server JSON with `linkProvider`.
- Export a workspace referencing a blessed server → zip does NOT include it.
- Export a workspace referencing a workspace-only server without Link credential refs → zip produced without registry metadata.
- Export a workspace referencing a workspace-only server with Link credential refs → export fails with a non-portable credential-provider error.

**`apps/atlasd/routes/workspaces/bundle-all.test.ts`** — extend:
- Bundle-all export includes `global/mcp-servers/` with ALL dynamic entries, even unreferenced ones.
- Bundle-all import restores global entries, then workspace entries (collision skips gracefully).

**`apps/atlasd/routes/mcp-registry.test.ts`** — extend:
- Install route persists `linkProvider` through the registry adapter (assert via adapter.get()).
- Custom-add route persists `linkProvider` through the registry adapter.
- Import route calls `createLinkProvider` with persisted sidecar (mock Link service fetch, assert POST body).
- Import with existing compatible server → adapter.add throws, compatibility check passes, reported as skipped.
- Import with existing incompatible server → import fails with `registry_entry_conflict` for workspace-referenced entries.
- Import with Link 409 and compatible provider shape → treated as success.
- Import with Link 409 and incompatible provider shape → import fails with `provider_conflict`.
- Import with Link 500 → import fails and rolls back registry/provider records created by that import.
- Import with static/curated provider ref after provider setup → invalid provider blocks; provider exists with no credential proceeds as setup-required.

### End-to-end smoke test

1. Install a registry MCP server (e.g., `io.github/Digital-Defiance/mcp-filesystem`).
2. Add it to a workspace's `tools.mcp.servers`.
3. Export the workspace as a bundle.
4. Stop daemon, wipe `~/.atlas/`, start fresh.
5. Import the bundle.
6. Query `GET /api/mcp-registry/` — the server appears.
7. Verify `adapter.get(id).linkProvider` is populated.

### Prior art

- `apps/atlasd/routes/workspaces/export.test.ts` — round-trip YAML export with credential stripping.
- `apps/atlasd/routes/workspaces/bundle-all.test.ts` — zip-of-zips round-trip.
- `packages/core/src/mcp-registry/translator.test.ts` — fixture-driven metadata shape verification.

---

## Out of Scope

- **Backfilling or deriving `linkProvider` for pre-existing entries.** Entries created before this PR will lack `linkProvider` in registry storage. They export without it and report `provider-missing`; if a workspace references the entry and its config requires Link credentials, that workspace import fails with a clear delete/re-add instruction. Users can delete and re-add old entries if full portability is needed.
- **Blessed/static server export.** Blessed MCP Registry Entries in `mcpServersRegistry.servers` are never exported; they are assumed present on the target daemon.
- **MCP server editing post-import.** The import path is additive only. If the user wants to update a server, they use the existing check-update/pull-update flows.
- **Workspace config mutation to add/remove MCP servers.** This PR is about portability, not workspace authoring. The existing `enableMCPServer` / `disableMCPServer` mutations in `@atlas/config` are unchanged.
- **Import preview/confirmation UI.** Bundle import itself is treated as consent to create bundled Dynamic MCP Registry Entries and Dynamic Link Providers. A future preview step can improve UX, but it is not part of this plan.
- **SSE, WebSocket, Docker, PyPI transport support.** The translator's rejection of these transports is unchanged; such servers simply aren't included in exports because they can't be installed automatically.
- **Resource data or ledger contents in MCP context.** MCP server tool definitions, READMEs, and other runtime-discovered data are not part of the bundle. Only the registry metadata (config template, required config, Link provider sidecar) is preserved.
- **Cross-instance Link credential value migration.** Link stores actual tokens/secrets. Only the *provider schema* (what fields exist, OAuth discovery URL) is recreated or verified. The user must re-run `connect_service` on the target to obtain fresh tokens. This is intentional — credential values should never leave the Link vault.
- **Deterministic export flag for bundle-all.** The existing `createdAt` timestamp still makes bundle-all non-deterministic. A future `?deterministic=true` flag is orthogonal.

---

## Further Notes

### Graceful degradation for old entries

The `linkProvider` field is optional in both the Zod schema and registry storage. Old entries read back with `linkProvider: undefined`. On export, they serialize as JSON without the key. On import, the route sees no `linkProvider`, skips Link Provider creation, and reports `provider-missing`. If the entry is global/unreferenced, this is a warning. If a workspace references the entry and its config contains Link credential refs, `provider-missing` blocks that workspace import because the workspace cannot be credential-ready. No heuristic backfill runs during export/import; users can delete and re-add old entries if full credential-flow portability is needed.

### `skipResolverCheck` preservation

Custom stdio entries carry `skipResolverCheck: true` in their `configTemplate`. This flag is part of `MCPServerConfigSchema` and travels in the metadata JSON naturally. Re-imported custom stdio servers will not trigger package-resolution false positives during workspace lint.

### Curated Upstream Override handling

When an upstream entry has a Curated Upstream Override (e.g., Notion with a shared static Link Provider), the translator skips `linkProvider` creation. The exported metadata has no `linkProvider`. On import, no Link Provider is created. The workspace config references `{ from: "link", provider: "notion" }`, which relies on the static "notion" provider already existing on the target (or the user setting it up). This is correct — Curated Upstream Overrides route to platform infrastructure, not per-server bundled dynamic providers.

### Bundle-all duplication

Each inner workspace zip may contain a subset of the same servers that also appear in `global/mcp-servers/`. This is intentional: single-workspace bundles must be self-contained. The import code handles collisions by skipping duplicates. Metadata is small (a few KB per server); the duplication cost is negligible.

### Playground UI impact

None. Importing a bundle is considered sufficient user consent to create the bundled Dynamic MCP Registry Entries and Dynamic Link Providers. The settings page (`+page.svelte`) and memory page already call `/bundle-all`, `/import-bundle`, and `/import-bundle-all`. The backend absorbs all new behavior. The only visible change is additional entries in the import summary toast/report.

### Lockfile schema version

This change is additive — `mcpServers` is a new optional key under `primitives`. Existing lockfiles without it are still valid. `schemaVersion` remains `1`.
