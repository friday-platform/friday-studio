# Team Lead Learnings — Workspace Setup Flow (2026-02-16)

Branch: david/tem-3696-workspace-integration-settings

## Observations

- `toIdRefs` (in `@atlas/config/mutations`) throws when a provider is missing from the credentialMap — had to change it to skip/return unchanged for partial credential resolution. This wasn't documented anywhere.
- `WorkspaceManager.registerWorkspace` builds metadata internally and doesn't accept arbitrary extra metadata fields. Custom metadata (like `requires_setup`) must be set via a separate `updateWorkspaceStatus` call after registration.
- SvelteKit `PageData` is a union of all loader return types but Svelte template `{#if}` blocks don't narrow TypeScript types. Discriminated unions with `as const` don't help — all return paths need the same shape with default values.
- `FilesystemWorkspaceCreationAdapter` mock in tests must use `class` syntax, not `vi.fn().mockReturnValue()`, because production code uses `new` — arrow functions aren't constructors.
- The connect flow (OAuth popup, app install, API key via LinkAuthModal, credential binding via PUT) is duplicated between the edit page and setup page. If this pattern grows to a third location, extract it.
