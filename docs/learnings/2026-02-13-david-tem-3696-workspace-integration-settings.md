# Learnings: Settings Integrations Migration

## Analytics regression during refactor

When absorbing connect logic from `connect-provider-cell.svelte` into the new
dialog component, the `completeFlow()` function lost the
`GA4.CREDENTIAL_LINK_SUCCESS` tracking event. The original was scoped to a
single provider (had `providerId` in closure), but the dialog handles all
providers. Fix: store the active provider's id and type in component state when
initiating the popup flow.

**Takeaway**: When moving logic from a per-item component into a shared
container, audit all side effects that relied on per-item closure scope.

## Dialog.Content render order (melt-ui)

`Dialog.Content` renders children before header, then footer. To get the visual
order of header → body → footer, the main body content goes in the `footer`
snippet. This is a melt-ui quirk worth knowing.

## TanStack renderComponent and Svelte 5 snippets

`renderComponent` (TanStack Svelte table) can't render Svelte 5 snippets
directly. When you need a button with an onclick handler in a table cell, create
a thin wrapper component (e.g. `connect-button-cell.svelte`).
